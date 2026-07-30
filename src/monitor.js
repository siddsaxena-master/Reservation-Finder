// Main polling loop + detection logic + alert composition.

import { config } from './config.js';
import { log } from './logger.js';
import { loadState, saveState } from './state.js';
import { fetchListing, fetchSeatMap, listingUrl, BlockedError } from './scraper.js';
import { markCycle, recycleBrowser, closeBrowser } from './browser.js';
import { sendMessage, escapeHtml } from './telegram.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- time helpers (theatre-local) -----------------------------------------

function theatreNowParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    dateISO: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10) % 24,
  };
}

function addDaysISO(dateISO, days) {
  const d = new Date(`${dateISO}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// "2:00am" -> 120, "10:00pm" -> 1320. Unparseable times sort last.
export function timeMinutes(timeText) {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec((timeText || '').trim());
  if (!m) return 24 * 60;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

export function prettyWhen(dateISO, timeText) {
  const d = new Date(`${dateISO}T12:00:00Z`);
  const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const t = (timeText || '').replace(/\s*(am|pm)\s*$/i, (m) => ` ${m.trim().toUpperCase()}`);
  return `${label}, ${t}`;
}

// ---- alert composition ------------------------------------------------------

function seatLine(rec) {
  if (rec.availableSeats === null || rec.availableSeats === undefined) {
    return rec.status === 'ALMOST_FULL' ? 'seats available (almost full)' : 'seats available';
  }
  const n = rec.availableSeats;
  let line = `${n} seat${n === 1 ? '' : 's'} available`;
  if (rec.seatNames?.length && rec.seatNames.length <= 12) line += ` — ${rec.seatNames.join(', ')}`;
  return line;
}

async function alertSeatOpen(rec) {
  const msg = [
    `🎟 <b>SEAT OPEN — ${escapeHtml(config.movieTitle)} ${escapeHtml(config.formatDisplay)}</b>`,
    escapeHtml(prettyWhen(rec.date, rec.timeText)),
    escapeHtml(seatLine(rec)),
    `<a href="${rec.url}">tap to buy</a>`,
  ].join('\n');
  return sendMessage(msg);
}

async function alertNewShowtime(rec) {
  const statusNote = rec.status === 'SOLD_OUT' ? ' (already sold out)' : '';
  const msg = [
    `🆕 <b>NEW SHOWTIME — ${escapeHtml(config.movieTitle)} ${escapeHtml(config.formatDisplay)}</b>`,
    escapeHtml(prettyWhen(rec.date, rec.timeText)) + statusNote,
    escapeHtml(rec.status === 'SOLD_OUT' ? 'will watch for cancellations' : seatLine(rec)),
    `<a href="${rec.url}">tap to buy</a>`,
  ].join('\n');
  return sendMessage(msg);
}

export function buildStatusText(state) {
  const now = Date.now();
  const { dateISO: today } = theatreNowParts();
  const recs = Object.values(state.showtimes)
    .filter((r) => r.date >= today && !r.removed)
    .sort((a, b) => a.date.localeCompare(b.date) || timeMinutes(a.timeText) - timeMinutes(b.timeText));
  if (!recs.length) {
    return `📽 <b>${escapeHtml(config.movieTitle)} — ${escapeHtml(config.formatDisplay)}</b>\nNo upcoming ${escapeHtml(
      config.formatDisplay
    )} showtimes are currently on the schedule at ${escapeHtml(config.theatreName)}.`;
  }
  const lines = [`📽 <b>${escapeHtml(config.movieTitle)} — ${escapeHtml(config.formatDisplay)} @ ${escapeHtml(config.theatreName)}</b>`];
  let lastDate = '';
  for (const r of recs) {
    if (r.date !== lastDate) {
      lines.push(`\n<b>${escapeHtml(prettyWhen(r.date, '').replace(/,\s*$/, ''))}</b>`);
      lastDate = r.date;
    }
    const icon = r.status === 'SOLD_OUT' ? '🔴' : r.status === 'ALMOST_FULL' ? '🟡' : '🟢';
    const seats =
      r.status === 'SOLD_OUT'
        ? 'sold out'
        : r.availableSeats !== null && r.availableSeats !== undefined
          ? `${r.availableSeats} seats`
          : r.status === 'ALMOST_FULL'
            ? 'almost full'
            : 'available';
    const age = Math.round((now - (r.lastSeenAt || now)) / 60000);
    lines.push(`${icon} ${escapeHtml(r.timeText)} — ${escapeHtml(seats)} <a href="${r.url}">link</a> <i>(${age}m ago)</i>`);
  }
  return lines.join('\n');
}

// ---- date planning ----------------------------------------------------------

export function planDates(state) {
  const { dateISO: today } = theatreNowParts();
  const horizonEnd = addDaysISO(today, config.lookaheadDays);
  const active = [...new Set(state.activeDates)].filter((d) => d >= today && d <= horizonEnd).sort();

  const plan = [];
  // 1) nearest active date every cycle (hottest window for cancellations)
  if (active.length) plan.push(active[0]);
  // 2) round-robin the remaining active dates
  const rest = active.slice(1);
  if (rest.length) {
    const take = Math.min(rest.length, Math.max(0, config.maxPagesPerCycle - 1 - config.horizonProbesPerCycle));
    for (let i = 0; i < take; i++) plan.push(rest[(state.horizonCursor + i) % rest.length]);
  }
  // 3) horizon probes: bookable dates in the lookahead window that are NOT
  //    active, to catch new date ranges. Rotates via the same cursor. The
  //    theatre's own date picker (when we've seen it) bounds the candidates.
  const picker = Array.isArray(state.pickerDates) ? state.pickerDates : [];
  const horizon = [];
  for (let i = 0; i <= config.lookaheadDays; i++) {
    const d = addDaysISO(today, i);
    if (active.includes(d)) continue;
    // "Today" is an empty-value option in AMC's picker, so it never appears in
    // pickerDates — always keep it probeable.
    if (picker.length && !picker.includes(d) && d !== today) continue;
    horizon.push(d);
  }
  // Fresh install (no known showtimes yet): use the whole page budget to map
  // the schedule quickly instead of one probe per cycle.
  const probeCount = active.length ? config.horizonProbesPerCycle : Math.max(1, config.maxPagesPerCycle - plan.length);
  for (let i = 0; i < probeCount && horizon.length; i++) {
    plan.push(horizon[(state.horizonCursor + i) % horizon.length]);
  }
  // If we know nothing at all yet, at least scan today.
  if (!plan.length) plan.push(today);
  return [...new Set(plan)].slice(0, config.maxPagesPerCycle);
}

// ---- one polling cycle ------------------------------------------------------

export async function runCycle(state, cycleNum) {
  const t0 = Date.now();
  const activeBefore = new Set(state.activeDates);
  const dates = planDates(state);
  const seen = new Map(); // id -> fresh showtime object
  const checkedDates = [];
  let driftSuspects = [];
  let movieSeenAnywhere = false;
  let pickerDates = [];

  for (const [i, d] of dates.entries()) {
    if (i > 0) await sleep(config.intraCycleDelayMs);
    const listing = await fetchListing(d); // throws BlockedError on 429/503/CF
    checkedDates.push(d);
    movieSeenAnywhere = movieSeenAnywhere || listing.movieOnPage;
    driftSuspects = driftSuspects.concat(listing.driftSuspects);
    pickerDates = pickerDates.concat(listing.pickerDates);
    for (const s of listing.showtimes) seen.set(s.id, s);
    log.debug(`listing ${d}: ${listing.showtimes.length} ${config.formatDisplay} showtimes, labels=[${listing.movieFormatLabels}]`);
  }

  const now = Date.now();
  const alerts = { seatOpen: [], newShowtime: [] };

  // --- merge fresh data into state, detect transitions ---
  for (const s of seen.values()) {
    const prev = state.showtimes[s.id];
    if (!prev) {
      const rec = {
        ...s,
        availableSeats: null,
        seatNames: null,
        firstSeenAt: now,
        lastSeenAt: now,
        soldOutSince: s.status === 'SOLD_OUT' ? now : null,
        lastAlertAt: 0,
        lastAlertSeats: 0,
        lastConfirm0At: 0,
        missCount: 0,
        removed: false,
      };
      state.showtimes[s.id] = rec;
      if (state.seeded) alerts.newShowtime.push(rec);
      continue;
    }
    const wasSoldOut = prev.status === 'SOLD_OUT';
    prev.timeText = s.timeText;
    prev.formatLabel = s.formatLabel;
    prev.url = s.url;
    prev.status = s.status;
    prev.lastSeenAt = now;
    prev.missCount = 0;
    prev.removed = false;
    if (s.status === 'SOLD_OUT') {
      if (!wasSoldOut) {
        prev.soldOutSince = now;
        prev.availableSeats = 0;
        prev.seatNames = null;
      }
    } else if (wasSoldOut) {
      // 0 -> >0 transition candidate; confirm via seat map below.
      alerts.seatOpen.push(prev);
    } else {
      // stayed available; stale exact counts are worse than none
      if (prev.availableSeats === 0) prev.availableSeats = null;
    }
  }

  // --- showtimes we expected on checked dates but didn't see ---
  for (const rec of Object.values(state.showtimes)) {
    if (rec.removed) continue;
    if (!checkedDates.includes(rec.date)) continue;
    if (seen.has(rec.id)) continue;
    rec.missCount = (rec.missCount || 0) + 1;
    if (rec.missCount >= 2) {
      rec.removed = true;
      log.info(`showtime ${rec.id} (${rec.date} ${rec.timeText}) no longer listed — marking removed`);
    }
  }

  // --- learn active dates (dates where we've SEEN our 70mm showtimes) ---
  const withShows = new Set(Object.values(state.showtimes).filter((r) => !r.removed).map((r) => r.date));
  state.activeDates = [...withShows].sort();
  // The theatre's date <select> tells us which dates are bookable at all;
  // horizon probing is limited to those (deduped, bounded by lookahead).
  if (pickerDates.length) state.pickerDates = [...new Set(pickerDates)].sort();
  const probesUsed = checkedDates.filter((d) => !activeBefore.has(d)).length;
  state.horizonCursor = (state.horizonCursor + Math.max(1, probesUsed)) % 1000;

  // --- confirm seat-open transitions with a real seat map (max 2 per cycle) ---
  const confirmed = [];
  for (const rec of alerts.seatOpen.slice(0, 2)) {
    if (!rec.hasDeepLink) {
      confirmed.push(rec); // can't pull a seat map without an id; alert on badge alone
      continue;
    }
    // "Ghost" shows (listing says available, seat map says 0 on sale) would
    // otherwise re-trigger a seat-map fetch every cycle — a rate-limit hazard.
    // After a 0-seat confirmation, trust it for the cooldown window.
    if (rec.lastConfirm0At && now - rec.lastConfirm0At < config.realertCooldownMs) {
      rec.status = 'SOLD_OUT';
      rec.availableSeats = 0;
      continue;
    }
    await sleep(config.intraCycleDelayMs);
    const idNum = /(\d+)/.exec(rec.id)?.[1];
    try {
      const seatMap = await fetchSeatMap(idNum);
      if (seatMap) {
        rec.availableSeats = seatMap.available;
        rec.seatNames = seatMap.seatNames;
        log.info(`seat map ${rec.id}: ${seatMap.available}/${seatMap.total} open via ${seatMap.source}`);
        if (seatMap.available > 0) {
          rec.lastConfirm0At = 0;
          confirmed.push(rec);
        } else {
          // listing badge stale/racy or show not actually on sale
          rec.status = 'SOLD_OUT';
          rec.availableSeats = 0;
          rec.lastConfirm0At = now;
        }
      } else {
        confirmed.push(rec); // parser broke: trust the listing badge, alert anyway
      }
    } catch (e) {
      log.warn(`seat map fetch failed for ${rec.id}: ${e.message} — alerting on listing badge alone`);
      confirmed.push(rec);
    }
  }
  // transitions beyond the per-cycle confirm cap still alert on badge data
  confirmed.push(...alerts.seatOpen.slice(2));

  // --- fire alerts (respecting the re-alert cooldown) ---
  let sent = 0;
  for (const rec of confirmed) {
    const cooldownActive = now - rec.lastAlertAt < config.realertCooldownMs;
    const seatsGrew = (rec.availableSeats ?? 1) > rec.lastAlertSeats;
    if (cooldownActive && !seatsGrew) {
      log.info(`suppressing re-alert for ${rec.id} (cooldown, seats not increased)`);
      continue;
    }
    if (await alertSeatOpen(rec)) {
      rec.lastAlertAt = now;
      rec.lastAlertSeats = rec.availableSeats ?? 1;
      sent++;
    }
  }
  for (const rec of alerts.newShowtime) {
    if (await alertNewShowtime(rec)) {
      rec.lastAlertAt = now;
      rec.lastAlertSeats = rec.availableSeats ?? 0;
      sent++;
    }
  }

  // --- breakage / drift warnings ---
  const totalLive = Object.values(state.showtimes).filter((r) => !r.removed).length;
  if (totalLive === 0 && state.lastNonZeroCount > 0) {
    if (now - state.lastBreakageWarnAt > config.breakageWarnIntervalMs) {
      state.lastBreakageWarnAt = now;
      const note = movieSeenAnywhere
        ? 'The movie is still listed, so the format filter or markup may have changed.'
        : `${config.movieTitle} was not found on the page at all.`;
      await sendMessage(
        `⚠️ <b>Monitor warning</b>\nPreviously tracked ${state.lastNonZeroCount} ${escapeHtml(
          config.formatDisplay
        )} showtimes, now finding 0. ${escapeHtml(note)}\nThis is more likely scraper breakage than every showtime vanishing — check the logs.`
      );
      log.warn('zero showtimes found where some existed before — possible scraper breakage');
    }
  }
  if (totalLive > 0) state.lastNonZeroCount = totalLive;

  const drift = [...new Set(driftSuspects)];
  if (drift.length && now - state.lastFormatDriftWarnAt > config.breakageWarnIntervalMs) {
    state.lastFormatDriftWarnAt = now;
    log.warn(`format label drift suspects: ${drift.join(' | ')}`);
    await sendMessage(
      `⚠️ <b>Format label may have changed</b>\nExpected a label matching <code>${escapeHtml(
        String(config.formatPattern)
      )}</code> but saw: ${escapeHtml(drift.join(', '))}\nUpdate FORMAT_PATTERN if AMC renamed the format.`
    );
  }

  // --- first-run seeding note ---
  if (!state.seeded) {
    state.seeded = true;
    const counts = { SOLD_OUT: 0, ALMOST_FULL: 0, AVAILABLE: 0 };
    for (const r of Object.values(state.showtimes)) if (!r.removed) counts[r.status] = (counts[r.status] || 0) + 1;
    await sendMessage(
      `✅ <b>Monitor started</b> — ${escapeHtml(config.movieTitle)} ${escapeHtml(config.formatDisplay)} @ ${escapeHtml(
        config.theatreName
      )}\nTracking ${totalLive} showtime(s): ${counts.SOLD_OUT} sold out, ${counts.ALMOST_FULL} almost full, ${counts.AVAILABLE} available.\nYou'll be alerted when a sold-out show opens up or a new showtime appears. Send /status any time.`
    );
  }

  markCycle();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const statusCounts = Object.values(state.showtimes)
    .filter((r) => !r.removed)
    .reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
  log.info(
    `cycle #${cycleNum} ok in ${secs}s — dates=[${checkedDates.join(',')}] tracked=${totalLive} ` +
      `(soldout=${statusCounts.SOLD_OUT || 0} almostfull=${statusCounts.ALMOST_FULL || 0} avail=${statusCounts.AVAILABLE || 0}) alerts=${sent}`
  );
  return { alertsSent: sent };
}

// ---- daily summary ----------------------------------------------------------

export async function maybeDailySummary(state) {
  const { dateISO, hour } = theatreNowParts();
  if (!state.lastDailySummaryOn) {
    // First run: don't fire a "daily" summary at whatever hour we started —
    // the startup message already reported the picture.
    state.lastDailySummaryOn = dateISO;
    return;
  }
  if (hour < config.dailySummaryHour) return;
  if (state.lastDailySummaryOn === dateISO) return;
  state.lastDailySummaryOn = dateISO;
  const text = `☀️ <b>Daily check-in — monitor is alive</b>\n\n${buildStatusText(state)}`;
  await sendMessage(text, { silent: true });
  log.info('daily summary sent');
}

// ---- main loop ----------------------------------------------------------------

export async function mainLoop(state) {
  let cycle = 0;
  let backoffMs = 0;
  let consecutiveFailures = 0;

  process.on('SIGTERM', async () => {
    log.info('SIGTERM — saving state and shutting down');
    saveState(state);
    await closeBrowser();
    process.exit(0);
  });

  for (;;) {
    cycle++;
    try {
      await runCycle(state, cycle);
      await maybeDailySummary(state);
      backoffMs = 0;
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures++;
      if (e instanceof BlockedError) {
        backoffMs = Math.min(backoffMs ? backoffMs * 2 : config.backoffBaseMs, config.backoffMaxMs);
        log.warn(`cycle #${cycle} blocked (${e.kind}, http ${e.status}) — backing off ${Math.round(backoffMs / 1000)}s`);
        if (e.kind === 'rate-limit') await recycleBrowser();
      } else {
        backoffMs = Math.min(backoffMs ? backoffMs * 2 : 30_000, config.backoffMaxMs);
        log.error(`cycle #${cycle} failed: ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`);
        if (consecutiveFailures >= 3) {
          await recycleBrowser();
          log.warn('3+ consecutive failures — recycled browser');
        }
        if (consecutiveFailures === 10) {
          await sendMessage(
            `⚠️ <b>Monitor warning</b>\n10 consecutive polling failures (latest: ${escapeHtml(e.message.slice(0, 200))}). Still retrying.`
          );
        }
      }
    }
    saveState(state);

    const jitter = Math.round((Math.random() * 2 - 1) * config.pollJitterMs);
    const wait = Math.max(5_000, config.pollIntervalMs + jitter + backoffMs);
    log.debug(`sleeping ${(wait / 1000).toFixed(0)}s`);
    await sleep(wait);
  }
}
