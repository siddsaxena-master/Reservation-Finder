// Debugging tool: save a rendered page's HTML for offline parser work.
//
//   node tools/dump-page.mjs <url> <out.html>
//
// Uses the same browser configuration as the monitor (config.js / .env),
// including CHROME_EXECUTABLE / BROWSER_PROXY / EXTRA_CHROMIUM_ARGS overrides.

import fs from 'node:fs';
import { chromium } from 'playwright';
import { config } from '../src/config.js';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node tools/dump-page.mjs <url> <out.html>');
  process.exit(1);
}

const launchOpts = {
  headless: config.headless,
  args: ['--disable-blink-features=AutomationControlled', ...config.extraChromiumArgs],
};
if (config.chromeExecutable) launchOpts.executablePath = config.chromeExecutable;
if (config.proxyServer) launchOpts.proxy = { server: config.proxyServer };

const b = await chromium.launch(launchOpts);
const ctx = await b.newContext({
  userAgent: config.userAgent,
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  timezoneId: config.timezone,
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
await page.waitForTimeout(config.settleMs);
fs.writeFileSync(out, await page.content());
console.log(`saved ${out} title="${await page.title()}"`);
await b.close();
