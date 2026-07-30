# AMC IMAX 70mm Seat Monitor

A read-only seat-availability watcher for **The Odyssey** in **IMAX 70mm** at
**AMC Lincoln Square 13**. It polls amctheatres.com, tracks every 70mm showtime,
and sends a Telegram alert — with a direct link to the seat-selection page —
when:

1. a **sold-out showtime opens up** (cancellation / expired checkout hold), or
2. a **new showtime or date range** appears on the schedule.

It never buys anything, never stores payment credentials, and never solves
CAPTCHAs. You tap the link and complete the purchase yourself.

```
🎟 SEAT OPEN — The Odyssey IMAX 70mm
Sat Aug 22, 7:00 PM
3 seats available — C12, C13, C14
[tap to buy]
```

## How it works

- **Node.js + Playwright (headless Chromium)** loads the theatre's showtimes
  page. Cloudflare fronts amctheatres.com and blocks plain HTTP clients, so a
  real browser is required.
- The showtimes listing server-renders a **SOLD OUT / ALMOST FULL badge per
  showtime**. The monitor polls that (cheap, one page per date) and diffs
  against last known state.
- When a sold-out show flips to available, it opens that showtime's **seat map**
  once to confirm and count exact seats (and seat numbers when exposed) — then
  alerts. The seats page server-renders the whole map as an accessible grid
  (`input aria-label="Occupied … A33"`), with **no separate availability
  XHR** (verified live 2026-07), so DOM parsing is the primary source; a
  payload scanner remains as fallback in case AMC moves seat data into
  JSON/flight responses later.
- AMC sometimes fronts pages with a **Queue-it waiting room** ("Global Safety
  Net"). With no real event running it auto-advances in seconds and sets a
  session cookie; the monitor waits it out (up to `QUEUE_WAIT_MS`, default
  90s) and only counts an unmoving queue as a blocked cycle.
- State lives in a **local JSON file** (`data/state.json`), written atomically.
  *Why not Supabase:* this is one process on one droplet tracking a few KB of
  showtime records; a hosted database adds credentials, latency, and an outage
  mode for zero benefit at this scale. If you ever want history/analytics,
  swap `src/state.js` — it's the only file that touches storage.

### Politeness / rate limiting (important)

Cloudflare on amctheatres.com temp-bans IPs that load pages in bursts
(observed empirically as HTTP 403 "error 1015" during development). The
monitor is deliberately frugal:

- Base poll interval **60s ± 20s jitter**, strictly sequential page loads,
  4s pause between loads inside a cycle.
- At most `MAX_PAGES_PER_CYCLE` (default 4) listing pages per cycle:
  the **nearest active date every cycle**, other active dates round-robin,
  plus one "horizon" probe per cycle so new date ranges are spotted within
  ~30 minutes even `LOOKAHEAD_DAYS` (28) out.
- Seat maps are only opened to confirm a detected transition (max 2/cycle).
- On 429/503/Cloudflare blocks: exponential backoff capped at **15 minutes**,
  browser recycled to shed cookies.

Net effect: the hottest window (next upcoming show date) is checked every
~60–90s; a date three weeks out is re-checked every few minutes. Pushing it
much harder gets the IP banned, which is slower than being patient.

## Alerts & commands

- **Seat-open alert** — sold-out ➜ available transition, with seat count,
  seat numbers (when the payload exposes them), and the deep link
  `https://www.amctheatres.com/showtimes/<id>/seats`.
- **New-showtime alert** — a showtime ID we've never seen (includes brand-new
  dates). Sold-out-on-arrival shows are announced and then watched.
- **Re-alert suppression** — a showtime won't re-alert within 30 minutes
  unless its seat count *increases* beyond the last alerted count.
- **`/status`** — replies with every tracked 70mm showtime, its badge/seat
  count, buy link, and data freshness.
- **Daily 9am check-in** (theatre-local) — proof of life + full picture.
- **Breakage warnings** — if the scraper suddenly finds zero 70mm showtimes
  where it previously found some, or the format label stops matching
  (e.g. AMC renames "IMAX 70MM"), you get a Telegram warning instead of
  silence. Warnings are rate-limited to one per hour.

First run seeds state silently (no alert spam for already-known showtimes) and
sends a startup summary instead.

## Setup

### 1. Telegram bot (the one step that needs you)

1. Open Telegram, message **@BotFather** → `/newbot` → pick a name and a
   username. BotFather replies with a token like `123456789:AAF...`.
2. Put it in `.env` as `TELEGRAM_BOT_TOKEN=...`.
3. Start the monitor, then send your new bot any message (e.g. `/start`).
   The first chat to message it is bound automatically and receives all
   alerts. (Other chats are ignored; set `TELEGRAM_CHAT_ID` to pin it
   explicitly.)

### 2. Install & run

```bash
cp .env.example .env          # then edit: add TELEGRAM_BOT_TOKEN
npm ci
npx playwright install chromium --with-deps   # once, downloads the browser
npm start                     # or: node src/index.js --once --verbose (single test cycle)
```

### 3. Run as a service (systemd)

```bash
sudo deploy/install.sh        # from the repo root on the droplet
sudo systemctl status amc-70mm-monitor
journalctl -u amc-70mm-monitor -f
```

The unit has `Restart=always` and is `enable`d, so it survives crashes and
reboots. `deploy/install.sh` is idempotent — rerun it after `git pull`.

## Reusing this for the next Nolan release

Everything is env-driven; edit `.env` and restart:

| Change            | Variable(s)                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| Different movie   | `MOVIE_SLUG_PATTERN` (matched against the `/movies/<slug>` link, e.g. `the-odyssey`), `MOVIE_TITLE` (display) |
| Different theatre | `AMC_THEATRE_PATH` (path of the theatre's showtimes page), `AMC_THEATRE_NAME` |
| Different format  | `FORMAT_PATTERN` (regex vs. the format-group heading, e.g. `^IMAX\s*70\s*MM$`, `^DOLBY CINEMA`), `FORMAT_DISPLAY` |
| Schedule horizon  | `LOOKAHEAD_DAYS`, `MAX_PAGES_PER_CYCLE`, `HORIZON_PROBES_PER_CYCLE`          |
| Pace              | `POLL_INTERVAL_MS`, `POLL_JITTER_MS`, `INTRA_CYCLE_DELAY_MS`                 |

The format filter matches the **format label**, never the auditorium number,
and warns if AMC's label text drifts.

Find the theatre path by browsing amctheatres.com to the theatre's showtimes
page and copying the path portion of the URL. Same for the movie slug.

## Layout

```
src/
  index.js     entry point; wires the poll loop + Telegram command listener
  monitor.js   polling cycle, detection/diff logic, alert composition, backoff
  scraper.js   Playwright page loads + parsing (listing badges, seat maps)
  browser.js   Chromium lifecycle (one context reused, periodic recycle)
  telegram.js  Bot API client (zero-dep fetch) + long-poll command loop
  state.js     local JSON state, atomic writes
  config.js    every knob, env-overridable; loads .env
  logger.js    timestamped stdout (journald-friendly) + optional file
deploy/
  amc-70mm-monitor.service   systemd unit
  install.sh                 idempotent installer for the droplet
```

## Operational notes

- Logs: every cycle logs timestamp, dates checked, tracked/sold-out/available
  counts, and alerts sent. `--verbose` (or `VERBOSE=1`) adds per-page detail.
- "Ghost" showtimes: AMC occasionally lists shows whose seat map renders
  fully occupied even though the listing shows no SOLD OUT badge (not on
  sale / blocked buyouts — observed on late-night marathon slots). The
  seat-map confirmation step keeps these from producing false seat-open
  alerts; they may appear as "available" in `/status` until they go on sale.
- The Telegram long-poll and the scrape loop are independent; a Telegram
  outage never stops scraping, and vice versa.
- If AMC changes markup: `scraper.js` is the only file to touch. The listing
  parser is heuristic (movie link ➜ format heading ➜ time buttons) rather than
  class-name-bound, so cosmetic redesigns usually survive; structural changes
  trigger the zero-showtimes warning rather than silent failure.
