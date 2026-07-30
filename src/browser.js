// Browser lifecycle. One Chromium instance, one context, reused across cycles
// (keeps Cloudflare cookies/clearance alive), recycled periodically.

import { chromium } from 'playwright';
import { config } from './config.js';
import { log } from './logger.js';

let browser = null;
let context = null;
let cyclesSinceLaunch = 0;

// Third-party noise we never need. Fewer requests = faster loads and a far
// smaller rate-limit footprint. NOTE: challenges.cloudflare.com must NOT be
// blocked — Cloudflare Turnstile has to load for the site to trust us.
const BLOCKED = /doubleclick\.net|google-analytics|googletagmanager|googleadservices|analytics\.tiktok|rokt-api\.com|facebook\.net|snapchat|bing\.com\/bat|branch\.io|\/ccm\/collect|\/rmkt\/collect|gtm\.amctheatres/i;

export async function getContext() {
  if (context && cyclesSinceLaunch < config.browserRecycleCycles) return context;
  await closeBrowser();

  const launchOpts = {
    headless: config.headless,
    args: ['--disable-blink-features=AutomationControlled', ...config.extraChromiumArgs],
  };
  if (config.chromeExecutable) launchOpts.executablePath = config.chromeExecutable;
  if (config.proxyServer) launchOpts.proxy = { server: config.proxyServer };

  browser = await chromium.launch(launchOpts);
  context = await browser.newContext({
    userAgent: config.userAgent,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: config.timezone,
  });
  await context.route(BLOCKED, (route) => route.abort());
  context.setDefaultNavigationTimeout(config.navTimeoutMs);
  cyclesSinceLaunch = 0;
  log.debug('browser launched');
  return context;
}

export function markCycle() {
  cyclesSinceLaunch += 1;
}

export async function closeBrowser() {
  try {
    if (context) await context.close();
  } catch {}
  try {
    if (browser) await browser.close();
  } catch {}
  context = null;
  browser = null;
}

// Force a fresh browser on next getContext() — used after hard failures.
export async function recycleBrowser() {
  cyclesSinceLaunch = Infinity;
  await closeBrowser();
}
