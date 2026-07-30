// Scraping of amctheatres.com via Playwright.
//
// Two fetchers:
//   fetchListing(dateISO)  -> showtimes for the watched movie+format on a date
//                             (single page load; server-rendered badges give us
//                             SOLD OUT / ALMOST FULL / available per showtime)
//   fetchSeatMap(showtime) -> exact available-seat count (+ seat names when
//                             exposed). Prefers the JSON/RSC payloads the seats
//                             page fires; falls back to DOM parsing.
//
// Why we don't hit every seat map every cycle: amctheatres.com sits behind
// Cloudflare rate limiting that temp-bans an IP after a burst of page loads
// (observed empirically: HTTP 403 / error 1015). The listing page already
// carries per-showtime availability badges, so we poll that cheaply and only
// open a seat map to confirm + count when a sold-out show flips to available.

import { config } from './config.js';
import { log } from './logger.js';
import { getContext } from './browser.js';

export class BlockedError extends Error {
  constructor(status, kind) {
    super(`blocked by upstream (${kind}, status=${status})`);
    this.status = status;
    this.kind = kind; // 'rate-limit' | 'forbidden' | 'server'
  }
}

function classifyBlock(status, bodyText, title) {
  const t = `${title}\n${bodyText}`.slice(0, 2000);
  if (status === 429 || /error\s*1015|rate limited/i.test(t)) return new BlockedError(status, 'rate-limit');
  if (status === 403 || /attention required|access denied|cf-challenge|just a moment/i.test(t))
    return new BlockedError(status, 'forbidden');
  if (status === 503 || status >= 500) return new BlockedError(status, 'server');
  return null;
}

async function openPage(url) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  const payloads = []; // JSON / RSC bodies captured during load
  page.on('response', async (r) => {
    try {
      const ct = (r.headers()['content-type'] || '').toLowerCase();
      if (!/json|text\/x-component/.test(ct)) return;
      if (!/amctheatres\.com/.test(r.url())) return;
      const body = await r.text();
      if (body && body.length < 3_000_000) payloads.push({ url: r.url(), body });
    } catch {
      /* response body may be unavailable after nav; fine */
    }
  });
  let status = 0;
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
  status = resp ? resp.status() : 0;
  await page.waitForTimeout(config.settleMs);
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const blocked = classifyBlock(status, bodyText, title);
  if (blocked) {
    await page.close().catch(() => {});
    throw blocked;
  }
  return { page, payloads, status };
}

// ---------------------------------------------------------------------------
// Listing page
// ---------------------------------------------------------------------------

export function listingUrl(dateISO) {
  const u = new URL(config.theatrePath, config.baseUrl);
  if (dateISO) u.searchParams.set('date', dateISO);
  return u.toString();
}

// Runs in the page. Returns every showtime entry with enough context to filter
// by movie and format on the Node side. Sold-out shows may render as
// non-anchor elements, so both anchors and disabled buttons are collected.
function extractListingInPage() {
  const results = [];
  const formatLabelsSeen = new Set();

  const timeRe = /^\s*\d{1,2}:\d{2}\s*(am|pm)\s*$/i;
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // Candidate showtime elements: anchors to /showtimes/<id> plus button-ish
  // elements whose first text line is a bare time (sold-out renders).
  const anchors = [...document.querySelectorAll('a[href*="/showtimes/"]')].filter((a) =>
    /\/showtimes\/\d+/.test(a.href)
  );
  const buttons = [...document.querySelectorAll('button,[role="button"],div,span')].filter((el) => {
    if (el.querySelector('a')) return false;
    const first = (el.innerText || '').trim().split('\n')[0] || '';
    if (!timeRe.test(first)) return false;
    // must not be inside one of the anchors we already have
    return !el.closest('a[href*="/showtimes/"]');
  });
  // De-dup nested button-ish matches: keep outermost carrying same text
  const outerButtons = buttons.filter((el) => !buttons.some((o) => o !== el && o.contains(el)));

  const candidates = [
    ...anchors.map((a) => ({ el: a, href: a.href })),
    ...outerButtons.map((b) => ({ el: b, href: null })),
  ];

  for (const { el, href } of candidates) {
    if (!isVisible(el)) continue;
    // Movie block: nearest ancestor that contains a /movies/ link.
    let movieHref = null;
    let block = el.parentElement;
    while (block && block !== document.body) {
      const link = block.querySelector('a[href*="/movies/"]');
      if (link) {
        movieHref = link.getAttribute('href');
        break;
      }
      block = block.parentElement;
    }
    if (!block || block === document.body) continue;

    // Format heading: last "labelish" element before this showtime within the
    // movie block. Labelish = short, no digits-only, mostly uppercase text in
    // its own element (AMC renders format group names like "IMAX 70MM",
    // "LASER AT AMC" as standalone headings, often linked).
    let formatLabel = null;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT);
    const labelish = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n === el || n.contains(el)) break; // stop once we reach our showtime
      if (!isVisible(n)) continue;
      const own = [...n.childNodes]
        .filter((c) => c.nodeType === Node.TEXT_NODE)
        .map((c) => c.textContent.trim())
        .join(' ')
        .trim();
      if (!own || own.length < 3 || own.length > 40) continue;
      if (timeRe.test(own)) continue;
      const letters = own.replace(/[^A-Za-z]/g, '');
      if (letters.length < 3) continue;
      const upper = own.replace(/[^A-Z]/g, '').length;
      if (upper / letters.length < 0.8) continue; // headings are (nearly) all caps
      labelish.push(own);
    }
    if (labelish.length) formatLabel = labelish[labelish.length - 1];
    for (const l of labelish) formatLabelsSeen.add(l);

    const lines = (el.innerText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const timeText = lines[0] || '';
    const rest = lines.slice(1).join(' ');
    // Badge may also live in a sibling annotation right after the element.
    const sibText = (el.parentElement?.innerText || '').slice(0, 200);
    const badgeSource = `${rest} ${sibText}`;
    let badge = null;
    if (/sold\s*out/i.test(badgeSource)) badge = 'SOLD_OUT';
    else if (/almost\s*full/i.test(badgeSource)) badge = 'ALMOST_FULL';

    results.push({
      href,
      movieHref,
      formatLabel,
      timeText,
      badge,
      disabled: href === null || el.getAttribute('aria-disabled') === 'true',
    });
  }
  return { entries: results, formatLabelsSeen: [...formatLabelsSeen] };
}

export async function fetchListing(dateISO) {
  const url = listingUrl(dateISO);
  const { page } = await openPage(url);
  try {
    const raw = await page.evaluate(extractListingInPage);
    // Available dates from the date picker (?date=YYYY-MM-DD links), so the
    // monitor can learn the schedule horizon from a single page.
    const pickerDates = await page.evaluate(() => {
      const out = new Set();
      for (const a of document.querySelectorAll('a[href*="date="]')) {
        const m = /[?&]date=(\d{4}-\d{2}-\d{2})/.exec(a.getAttribute('href') || '');
        if (m) out.add(m[1]);
      }
      return [...out];
    });

    const all = raw.entries;
    const movieEntries = all.filter((e) => e.movieHref && config.movieSlugPattern.test(e.movieHref));
    const matched = movieEntries.filter((e) => e.formatLabel && config.formatPattern.test(e.formatLabel));

    // Format-label drift detection: the movie is on the page, some of its
    // format headings look 70mm/IMAX-adjacent, but nothing matched our exact
    // pattern -> AMC probably renamed the label.
    const movieLabels = [...new Set(movieEntries.map((e) => e.formatLabel).filter(Boolean))];
    const driftSuspects = movieLabels.filter(
      (l) => !config.formatPattern.test(l) && config.formatDriftPattern.test(l) && !config.knownOtherFormats.test(l)
    );

    const showtimes = matched.map((e) => {
      const idMatch = e.href ? /\/showtimes\/(\d+)/.exec(e.href) : null;
      const id = idMatch ? idMatch[1] : `${dateISO}|${e.timeText.toLowerCase()}|${e.formatLabel}`;
      const status = e.badge === 'SOLD_OUT' ? 'SOLD_OUT' : e.badge === 'ALMOST_FULL' ? 'ALMOST_FULL' : 'AVAILABLE';
      return {
        id,
        date: dateISO,
        timeText: e.timeText,
        formatLabel: e.formatLabel,
        status,
        url: idMatch ? `${config.baseUrl}/showtimes/${idMatch[1]}/seats` : listingUrl(dateISO),
        hasDeepLink: Boolean(idMatch),
      };
    });

    return {
      url,
      dateISO,
      movieOnPage: movieEntries.length > 0 || (await pageMentionsMovie(page)),
      showtimes,
      pickerDates,
      movieFormatLabels: movieLabels,
      driftSuspects,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function pageMentionsMovie(page) {
  try {
    return await page.evaluate(
      (pat) => new RegExp(pat, 'i').test(document.body?.innerText || ''),
      config.movieTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Seat map
// ---------------------------------------------------------------------------

// Scan captured JSON/RSC payloads for seat objects. AMC's seats page is a
// Next.js app; seat data arrives either as JSON XHR or inside React flight
// (text/x-component) chunks. Both contain per-seat objects with a name and an
// availability marker, so a tolerant regex-level scan is more change-proof
// than assuming an exact schema.
function seatsFromPayloads(payloads) {
  const seatRe = /\{[^{}]{0,400}?"(?:name|seatName|label)"\s*:\s*"([A-Z]{1,3}\s?-?\d{1,3})"[^{}]{0,400}?\}/g;
  const availRe = /"(?:available|isAvailable)"\s*:\s*(true|false)|"(?:status|state|availability)"\s*:\s*"([A-Za-z]+)"/;
  let best = null;
  for (const p of payloads) {
    const seats = [];
    let m;
    seatRe.lastIndex = 0;
    while ((m = seatRe.exec(p.body))) {
      const obj = m[0];
      const name = m[1].replace(/\s+/g, '');
      const a = availRe.exec(obj);
      if (!a) continue;
      let available;
      if (a[1] !== undefined) available = a[1] === 'true';
      else available = /^(available|open|free)$/i.test(a[2]);
      seats.push({ name, available });
    }
    if (seats.length >= 5) {
      // de-dup by name (payload chunks can repeat)
      const map = new Map(seats.map((s) => [s.name, s]));
      const uniq = [...map.values()];
      if (!best || uniq.length > best.length) best = uniq;
    }
  }
  if (!best) return null;
  const open = best.filter((s) => s.available);
  return { total: best.length, available: open.length, seatNames: open.map((s) => s.name).sort(), source: 'payload' };
}

// DOM fallback: count seat-shaped controls by accessibility attributes.
function seatsFromDomInPage() {
  const nodes = [...document.querySelectorAll('button,[role="button"],[role="checkbox"],[aria-label]')];
  const seats = new Map();
  for (const el of nodes) {
    const label = (el.getAttribute('aria-label') || '').trim();
    // e.g. "Seat C12, available", "C12 unavailable", "Row C Seat 12 - occupied"
    const m = /^(?:row\s*)?(?:seat\s*)?([A-Z]{1,3})\s*(?:seat)?\s*-?\s*(\d{1,3})\b/i.exec(label);
    if (!m) continue;
    if (!/seat|row/i.test(label) && !/^[A-Z]{1,3}\d{1,3}\b/.test(label)) continue;
    const name = `${m[1].toUpperCase()}${m[2]}`;
    const unavailable =
      /unavailable|occupied|taken|reserved|sold|not available/i.test(label) ||
      el.disabled === true ||
      el.getAttribute('aria-disabled') === 'true';
    seats.set(name, !unavailable);
  }
  if (seats.size < 5) return null;
  const open = [...seats.entries()].filter(([, ok]) => ok).map(([n]) => n);
  return { total: seats.size, available: open.length, seatNames: open.sort(), source: 'dom' };
}

export async function fetchSeatMap(showtimeId) {
  const url = `${config.baseUrl}/showtimes/${showtimeId}/seats`;
  const { page, payloads } = await openPage(url);
  try {
    // Give the seat map a moment beyond base settle; it renders client-side.
    await page.waitForTimeout(2000);
    let result = seatsFromPayloads(payloads);
    if (!result) {
      result = await page.evaluate(seatsFromDomInPage);
      if (result) log.warn(`seat map ${showtimeId}: payload parse failed, used DOM fallback`);
    }
    if (!result) {
      log.warn(`seat map ${showtimeId}: could not parse seats from payloads (${payloads.length}) or DOM`);
      return null;
    }
    return { ...result, url };
  } finally {
    await page.close().catch(() => {});
  }
}
