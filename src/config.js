// Central configuration. Everything here can be overridden via environment
// variables (or a .env file loaded by loadEnvFile below) so the monitor can be
// re-pointed at a different movie / theatre / format without code changes.
// See README.md ("Reusing this for another movie").

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency): KEY=VALUE lines, # comments.
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const line of txt.split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {
    /* no .env file is fine */
  }
}
loadEnvFile();

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const envInt = (k, d) => parseInt(env(k, String(d)), 10);
const envBool = (k, d) => /^(1|true|yes)$/i.test(env(k, d ? '1' : '0'));

export const config = {
  root: ROOT,

  // ---- What to watch -------------------------------------------------------
  baseUrl: env('AMC_BASE_URL', 'https://www.amctheatres.com'),
  // Theatre showtimes path (relative to baseUrl).
  theatrePath: env('AMC_THEATRE_PATH', '/movie-theatres/new-york-city/amc-lincoln-square-13/showtimes'),
  theatreName: env('AMC_THEATRE_NAME', 'AMC Lincoln Square 13'),
  // Movie is matched against the /movies/<slug> link on the showtimes page.
  movieSlugPattern: new RegExp(env('MOVIE_SLUG_PATTERN', 'the-odyssey'), 'i'),
  movieTitle: env('MOVIE_TITLE', 'The Odyssey'),
  // Format section label to KEEP. Matched against the format group heading,
  // never the auditorium number. "IMAX 70MM" is AMC's current label.
  formatPattern: new RegExp(env('FORMAT_PATTERN', '^IMAX\\s*70\\s*MM$'), 'i'),
  formatDisplay: env('FORMAT_DISPLAY', 'IMAX 70mm'),
  // Labels that look 70mm-adjacent. If we see one of these but nothing matching
  // formatPattern, the label text probably changed silently -> warn.
  formatDriftPattern: new RegExp(env('FORMAT_DRIFT_PATTERN', '70\\s*MM|IMAX'), 'i'),
  // Labels to explicitly ignore even though they match the drift pattern
  // (known non-70mm premium formats; keeps drift warnings quiet).
  knownOtherFormats: new RegExp(env('KNOWN_OTHER_FORMATS', 'LASER|DOLBY|PRIME|GRAND|RPX|70MM FILM AT AMC$'), 'i'),

  // ---- Date scanning --------------------------------------------------------
  // How many days ahead to look for showtimes/new date ranges.
  lookaheadDays: envInt('LOOKAHEAD_DAYS', 28),
  // Dates with known 70mm showtimes are re-checked every cycle; the remaining
  // horizon is probed round-robin, N extra date(s) per cycle, so a brand-new
  // date range is spotted within ~lookaheadDays cycles at worst.
  horizonProbesPerCycle: envInt('HORIZON_PROBES_PER_CYCLE', 1),
  // Hard cap of listing-page loads in a single cycle (rate-limit protection).
  maxPagesPerCycle: envInt('MAX_PAGES_PER_CYCLE', 4),

  // ---- Polling behaviour ----------------------------------------------------
  pollIntervalMs: envInt('POLL_INTERVAL_MS', 60_000),
  pollJitterMs: envInt('POLL_JITTER_MS', 20_000),
  // Pause between successive page loads inside one cycle (sequential, polite).
  intraCycleDelayMs: envInt('INTRA_CYCLE_DELAY_MS', 4_000),
  // Exponential backoff after 429/503/Cloudflare blocks. Cap per spec: 15 min.
  backoffBaseMs: envInt('BACKOFF_BASE_MS', 120_000),
  backoffMaxMs: envInt('BACKOFF_MAX_MS', 900_000),

  // ---- Alerting -------------------------------------------------------------
  // Suppress duplicate alerts for the same showtime for this long, unless the
  // seat count increased beyond the last alerted count.
  realertCooldownMs: envInt('REALERT_COOLDOWN_MS', 30 * 60_000),
  // Hour (0-23, theatre-local time) of the daily "I'm alive" summary.
  dailySummaryHour: envInt('DAILY_SUMMARY_HOUR', 9),
  timezone: env('TIMEZONE', 'America/New_York'),
  // Warn at most this often about scraper breakage (zero showtimes / drift).
  breakageWarnIntervalMs: envInt('BREAKAGE_WARN_INTERVAL_MS', 60 * 60_000),

  // ---- Telegram ---------------------------------------------------------------
  telegramToken: env('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: env('TELEGRAM_CHAT_ID', ''), // filled automatically on first /start if empty
  telegramPollTimeoutSec: envInt('TELEGRAM_POLL_TIMEOUT_SEC', 50),

  // ---- State ------------------------------------------------------------------
  stateFile: env('STATE_FILE', path.join(ROOT, 'data', 'state.json')),
  logFile: env('LOG_FILE', ''), // empty -> stdout only (journald captures it)

  // ---- Browser ----------------------------------------------------------------
  userAgent: env(
    'USER_AGENT',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  ),
  headless: envBool('HEADLESS', true),
  // Optional overrides, mainly for sandboxed/proxied environments.
  chromeExecutable: env('CHROME_EXECUTABLE', ''),
  proxyServer: env('BROWSER_PROXY', ''), // e.g. http://127.0.0.1:46021
  extraChromiumArgs: env('EXTRA_CHROMIUM_ARGS', '') // comma-separated
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Recycle the browser after this many cycles to keep memory flat.
  browserRecycleCycles: envInt('BROWSER_RECYCLE_CYCLES', 30),
  navTimeoutMs: envInt('NAV_TIMEOUT_MS', 60_000),
  // How long to wait after DOMContentLoaded for client rendering to settle.
  settleMs: envInt('PAGE_SETTLE_MS', 6_000),
};

export function describeConfig() {
  return [
    `theatre=${config.theatreName}`,
    `movie=${config.movieTitle} (${config.movieSlugPattern})`,
    `format=${config.formatDisplay} (${config.formatPattern})`,
    `poll=${config.pollIntervalMs / 1000}s±${config.pollJitterMs / 1000}s`,
    `lookahead=${config.lookaheadDays}d`,
  ].join(' ');
}
