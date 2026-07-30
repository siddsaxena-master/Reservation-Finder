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

// AMC fronts busy pages with a Queue-it waiting room ("Global Safety Net").
// With no real event running it auto-advances in seconds and drops a cookie
// that exempts the rest of the browser session — so we wait it out (capped)
// instead of failing the cycle.
function looksLikeQueue(url, title) {
  return /queue-it\.net/i.test(url) || /^queue-it/i.test(title || '');
}

async function waitOutQueue(page) {
  log.warn(`Queue-it waiting room hit at ${page.url()} — waiting up to ${config.queueWaitMs / 1000}s for release`);
  try {
    await page.waitForURL((u) => /amctheatres\.com/.test(String(u)) && !/queue-it/i.test(String(u)), {
      timeout: config.queueWaitMs,
    });
    await page.waitForTimeout(config.settleMs);
    log.info('Queue-it released us back to the site');
    return true;
  } catch {
    return false;
  }
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
  let title = await page.title().catch(() => '');

  if (looksLikeQueue(page.url(), title)) {
    const released = await waitOutQueue(page);
    if (!released) {
      await page.close().catch(() => {});
      throw new BlockedError(status || 302, 'queue');
    }
    title = await page.title().catch(() => '');
  }

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

// Runs in the page. Extracts every showtime with its movie + format context.
//
// AMC's listing markup (verified 2026-07 against the live site) is strongly
// semantic — we lean on ARIA structure rather than styling classes:
//
//   <section aria-label="Showtimes for The Odyssey">
//     <li role="listitem" aria-label="IMAX 70MM Showtimes">
//       <h3><span>IMAX 70MM</span> …</h3>
//       <ul aria-label="Showtime Group Results">
//         <li><div role="group">
//           <a href="/showtimes/143822207"
//              aria-describedby="the-odyssey-76238 … …-imax70mm-0 …">
//             <time>10:00pm</time><span class="sr-only">Almost Full</span>
//           </a>
//           <div aria-hidden="true">…<span>Almost Full</span>…</div>
//         </div></li>
//       </ul>
//     </li>
//     <li role="listitem" aria-label="Laser at AMC Showtimes">…</li>
//   </section>
//
// Sold-out shows may render without an anchor, so any group item containing a
// <time> is captured even when no href is present.
// Exported so tools/parse-fixture.mjs can exercise it against saved HTML.
export function extractListingInPage() {
  const results = [];
  const formatLabelsSeen = new Set();

  const formatLabelOf = (el) => {
    const li = el.closest('li[role="listitem"][aria-label]');
    if (li) {
      const aria = li.getAttribute('aria-label') || '';
      const m = /^(.*?)\s*showtimes?$/i.exec(aria.trim());
      if (m && m[1]) return m[1].trim();
      if (aria.trim()) return aria.trim();
    }
    // Fallback: nearest h3's first span (the format heading)
    const h3 = el.closest('li,section')?.querySelector('h3 span');
    return h3 ? h3.textContent.trim() : null;
  };

  const movieContextOf = (el) => {
    const section = el.closest('section[aria-label]');
    const sectionLabel = section ? section.getAttribute('aria-label') : null;
    const movieLink = section?.querySelector('a[href*="/movies/"]');
    return {
      sectionLabel, // e.g. "Showtimes for The Odyssey"
      movieHref: movieLink ? movieLink.getAttribute('href') : null,
      describedby: el.getAttribute?.('aria-describedby') || '',
    };
  };

  // Primary: real showtime anchors.
  const anchors = [...document.querySelectorAll('a[href*="/showtimes/"]')].filter((a) =>
    /\/showtimes\/\d+/.test(a.getAttribute('href') || '')
  );
  // Secondary: group items with a <time> but no anchor (sold-out rendering).
  const groups = [...document.querySelectorAll('div[role="group"], ul[aria-label*="Showtime Group" i] > li')].filter(
    (g) => g.querySelector('time') && !g.querySelector('a[href*="/showtimes/"]')
  );

  const record = (el, href) => {
    const timeEl = el.querySelector('time') || (el.tagName === 'TIME' ? el : null);
    const timeText = (timeEl ? timeEl.textContent : (el.textContent || '').split('\n')[0] || '')
      .replace(/\s+/g, '')
      .toLowerCase();
    if (!/^\d{1,2}:\d{2}(am|pm)$/.test(timeText)) return;

    const { sectionLabel, movieHref, describedby } = movieContextOf(el);
    const formatLabel = formatLabelOf(el);
    if (formatLabel) formatLabelsSeen.add(formatLabel);

    // Badge lives in the anchor's sr-only span and/or the sibling badge <div>.
    const holder = el.closest('div[role="group"]') || el.parentElement || el;
    const badgeText = (holder.textContent || '').replace(timeEl ? timeEl.textContent : '', ' ');
    let badge = null;
    if (/sold\s*out/i.test(badgeText)) badge = 'SOLD_OUT';
    else if (/almost\s*full/i.test(badgeText)) badge = 'ALMOST_FULL';

    results.push({
      href,
      movieHref,
      sectionLabel,
      describedby,
      formatLabel,
      timeText,
      badge,
      disabled: href === null,
    });
  };

  for (const a of anchors) record(a, a.getAttribute('href'));
  for (const g of groups) record(g, null);

  // The date <select> lists every bookable date at this theatre — the
  // schedule horizon in one page load.
  const pickerDates = [
    ...new Set(
      [...document.querySelectorAll('select option')]
        .map((o) => o.getAttribute('value') || '')
        .filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))
    ),
  ];

  return { entries: results, formatLabelsSeen: [...formatLabelsSeen], pickerDates };
}

export async function fetchListing(dateISO) {
  const url = listingUrl(dateISO);
  const { page } = await openPage(url);
  try {
    const raw = await page.evaluate(extractListingInPage);
    const pickerDates = raw.pickerDates || [];

    const all = raw.entries;
    // Movie match, most-specific first: the aria-describedby tokens on each
    // showtime carry the movie slug; the enclosing <section aria-label>
    // carries the title; the section header links to /movies/<slug>.
    const isOurMovie = (e) =>
      (e.describedby && config.movieSlugPattern.test(e.describedby)) ||
      (e.movieHref && config.movieSlugPattern.test(e.movieHref)) ||
      (e.sectionLabel && new RegExp(config.movieTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(e.sectionLabel));
    const movieEntries = all.filter(isOurMovie);
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

// DOM parsing — the PRIMARY seat source in practice. AMC's seats page
// server-renders the whole map as an accessible grid; there is no separate
// availability XHR to intercept (verified against the live site 2026-07: the
// only JSON in flight is queue/consent/analytics noise). Markup:
//
//   <div role="grid" aria-label="Seat Selection Map">
//     <div role="row"><div role="gridcell">
//       <label><input disabled aria-label="Occupied AMC Club Rocker A33"></label>
//       <label><input aria-label="AMC Club Rocker C10"></label>   <- available
//
// Occupied seats carry an "Occupied" prefix and disabled; available seats are
// enabled inputs whose label ends in the seat name (e.g. "AMC Club Rocker C10",
// "Wheelchair Space D1").
function seatsFromDomInPage() {
  const inputs = [
    ...document.querySelectorAll('[role="grid"] [role="gridcell"] input[aria-label], [role="grid"] [role="gridcell"] button[aria-label]'),
  ];
  const seats = new Map();
  for (const el of inputs) {
    const label = (el.getAttribute('aria-label') || '').trim();
    const m = /([A-Z]{1,3}\s?-?\d{1,3})\s*$/.exec(label);
    if (!m) continue;
    const name = m[1].replace(/[\s-]+/g, '');
    const occupied =
      /^(occupied|unavailable|reserved|sold)/i.test(label) ||
      el.disabled === true ||
      el.getAttribute('aria-disabled') === 'true';
    // A seat can appear once; occupied wins if duplicated.
    seats.set(name, seats.has(name) ? seats.get(name) && !occupied : !occupied);
  }
  if (seats.size < 5) return null;
  const open = [...seats.entries()].filter(([, ok]) => ok).map(([n]) => n);
  return { total: seats.size, available: open.length, seatNames: open.sort(), source: 'dom' };
}

export async function fetchSeatMap(showtimeId) {
  const url = `${config.baseUrl}/showtimes/${showtimeId}/seats`;
  const { page, payloads } = await openPage(url);
  try {
    await page.waitForTimeout(2000);
    // DOM first (the map is server-rendered; see seatsFromDomInPage). The
    // payload scan is a secondary path in case AMC moves seat data into an
    // XHR/flight response in a future site version.
    let result = await page.evaluate(seatsFromDomInPage);
    if (!result) {
      result = seatsFromPayloads(payloads);
      if (result) log.warn(`seat map ${showtimeId}: DOM parse failed, used payload fallback`);
    }
    if (!result) {
      log.warn(`seat map ${showtimeId}: could not parse seats from DOM or payloads (${payloads.length})`);
      return null;
    }
    return { ...result, url };
  } finally {
    await page.close().catch(() => {});
  }
}
