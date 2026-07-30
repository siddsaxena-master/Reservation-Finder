// Debugging tool: run the listing parser against a saved HTML file, offline.
// Useful when AMC changes markup — dump the live page once, then iterate on
// the parser against the fixture without hammering the site.
//
//   node tools/parse-fixture.mjs <listing.html> [dateISO]
//
// Dump a fixture with:
//   node tools/dump-page.mjs <url> <out.html>

import { chromium } from 'playwright';
import path from 'node:path';
import { config } from '../src/config.js';
import { extractListingInPage } from '../src/scraper.js';

const file = process.argv[2];
const dateISO = process.argv[3] || 'fixture-date';
if (!file) {
  console.error('usage: node tools/parse-fixture.mjs <listing.html> [dateISO]');
  process.exit(1);
}

const launchOpts = { headless: true };
if (config.chromeExecutable) launchOpts.executablePath = config.chromeExecutable;
if (config.extraChromiumArgs.length) launchOpts.args = config.extraChromiumArgs;
const b = await chromium.launch(launchOpts);
const page = await b.newPage();
await page.goto('file://' + path.resolve(file), { waitUntil: 'domcontentloaded' });

const raw = await page.evaluate(extractListingInPage);
const isOurMovie = (e) =>
  (e.describedby && config.movieSlugPattern.test(e.describedby)) ||
  (e.movieHref && config.movieSlugPattern.test(e.movieHref)) ||
  (e.sectionLabel && new RegExp(config.movieTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(e.sectionLabel));

const movieEntries = raw.entries.filter(isOurMovie);
const matched = movieEntries.filter((e) => e.formatLabel && config.formatPattern.test(e.formatLabel));

console.log(`entries total=${raw.entries.length} movie=${movieEntries.length} formatMatched=${matched.length}`);
console.log(`pickerDates: ${raw.pickerDates.length} (${raw.pickerDates[0] || '-'} .. ${raw.pickerDates.at(-1) || '-'})`);
console.log(`format labels on page: ${raw.formatLabelsSeen.join(' | ')}`);
console.log('--- movie entries ---');
for (const e of movieEntries) {
  console.log(
    ` [${e.formatLabel}] ${e.timeText} badge=${e.badge ?? '-'} href=${e.href ?? 'NONE(sold-out render?)'} date=${dateISO}`
  );
}
await b.close();
