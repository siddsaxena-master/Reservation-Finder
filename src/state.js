// Persistent state, stored as a local JSON file.
//
// Why a JSON file and not Supabase: this is a single process on a single
// droplet tracking a few dozen showtimes (a few KB). A network database adds
// latency, an outage mode, credentials to manage, and zero benefit at this
// scale. The file is written atomically (tmp + rename) so a crash mid-write
// can't corrupt it. If you later want history/analytics, see README.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

const EMPTY = {
  version: 1,
  // showtimeId -> record
  showtimes: {},
  // ISO dates (theatre-local) that had 70mm showtimes last time we looked
  activeDates: [],
  // ISO dates the theatre's date picker offers (bounds horizon probing)
  pickerDates: [],
  // Round-robin cursor for horizon scanning
  horizonCursor: 0,
  // Breakage bookkeeping
  lastNonZeroCount: 0,
  lastBreakageWarnAt: 0,
  lastFormatDriftWarnAt: 0,
  // Daily summary bookkeeping (theatre-local date string of last summary)
  lastDailySummaryOn: '',
  // Telegram
  chatId: '',
  telegramUpdateOffset: 0,
  // First run flag: seed silently instead of alert-spamming existing shows
  seeded: false,
};

export function loadState() {
  try {
    const raw = fs.readFileSync(config.stateFile, 'utf8');
    const st = { ...EMPTY, ...JSON.parse(raw) };
    return st;
  } catch {
    return { ...EMPTY };
  }
}

export function saveState(state) {
  try {
    const dir = path.dirname(config.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = config.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, config.stateFile);
  } catch (e) {
    log.error(`failed to save state: ${e.message}`);
  }
}

// Shape of a showtime record kept in state.showtimes[id]:
// {
//   id, date ("2026-08-22"), timeText ("7:00pm"), whenText ("Sat Aug 22, 7:00 PM"),
//   url, status: "AVAILABLE" | "ALMOST_FULL" | "SOLD_OUT",
//   availableSeats: number|null   (exact count when we've pulled the seat map)
//   seatNames: string[]|null,
//   firstSeenAt, lastSeenAt, soldOutSince: ms epoch | null,
//   lastAlertAt: 0, lastAlertSeats: 0,
// }
