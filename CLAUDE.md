# CLAUDE.md — Reservation-Finder

## What this project is

A **general reservation/availability finder**. The first (and current) target
is movie seats: The Odyssey in IMAX 70mm at AMC Lincoln Square 13, with
Telegram alerts (see README.md). But the repo's ambition is broader — future
targets may include other theatres/formats/movies and eventually other
reservation domains (restaurants, campsites, etc.). Keep the design
config-driven and the AMC-specific logic isolated in `src/scraper.js` so new
targets can be added without rewriting the core loop.

## Services it connects to

- **amctheatres.com** — scraped read-only via Playwright headless Chromium
  (Cloudflare blocks plain HTTP clients).
- **Telegram Bot API** — alerts out, `/status` commands in. Token lives in
  `.env` (`TELEGRAM_BOT_TOKEN`), never in code.
- **Local JSON state** (`data/state.json`) — the only store today.
- **Supabase (later)** — the intended store if/when history tracking or
  multi-target support is added. Do not add it preemptively.

Nothing else. Do not add services without an explicit request.

## Hard rules — never touch

1. **The purchase flow.** This is a read-only watcher, forever:
   - no automated purchasing or checkout of any kind
   - no stored payment credentials
   - no CAPTCHA solving or bot-detection circumvention
   - no clicking "Buy" on the user's behalf
   The user completes every purchase manually via the deep link.
2. **The production service.** Never restart, stop, reconfigure, or edit the
   live systemd service (`amc-70mm-monitor`) or its `.env` on the droplet
   without asking first. Code changes land via git; the user (or an approved
   deploy step) rolls them out.

## How the user likes to work

1. **Commit after anything works**, with a clear message — don't wait to be
   asked.
2. **Before writing code for a new feature**: explain the approach in plain
   English and wait for a go-ahead.
3. **After writing code, run it** and show real output. Never claim untested
   code "should work".
4. **Ask before**: deleting files, rewriting anything that already works, or
   touching production.

## Architecture (current)

```
src/index.js     entry; runs poll loop + Telegram listener concurrently
src/monitor.js   cycle planning, state diffing, alert rules, backoff
src/scraper.js   ALL amctheatres.com knowledge lives here (parsing, URLs)
src/browser.js   Chromium lifecycle; one context reused across cycles
src/telegram.js  zero-dep Bot API client (fetch)
src/state.js     local JSON state, atomic writes
src/config.js    every knob, env-overridable; loads .env
```

## Operational gotchas

- **Cloudflare rate-limits amctheatres.com hard** (temp-ban ≈ HTTP 403
  "error 1015" after a burst of page loads). Keep polling polite: ≤4 listing
  pages/cycle, sequential loads with delays, jittered interval, capped
  backoff. Don't lower the politeness settings casually.
- Test cycles: `node src/index.js --once --verbose`.
- In sandboxed Claude Code sessions (egress proxy), Chromium needs:
  `CHROME_EXECUTABLE=<path to full chrome>`, `BROWSER_PROXY=$HTTPS_PROXY`,
  `EXTRA_CHROMIUM_ARGS=--ssl-version-max=tls1.2,--no-sandbox`. On a normal
  droplet none of these are needed.
- Playwright version must match the preinstalled browser build if not
  running `npx playwright install` (pinned in package.json).
