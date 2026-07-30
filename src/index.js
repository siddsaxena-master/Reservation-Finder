// Entry point. Starts the polling loop and the Telegram command listener.
//
//   node src/index.js            run forever (what systemd runs)
//   node src/index.js --once     single polling cycle, then exit (testing)
//   node src/index.js --verbose  debug logging

import { config, describeConfig } from './config.js';
import { log } from './logger.js';
import { loadState, saveState } from './state.js';
import { mainLoop, runCycle, buildStatusText } from './monitor.js';
import { pollUpdates, sendMessage, setChatId, getChatId, telegramConfigured, getMe } from './telegram.js';
import { closeBrowser } from './browser.js';

// NOTE: `state` is the SAME object the polling loop mutates — both loops
// share it and saves serialize the shared object, so neither loop can
// clobber the other's writes (single-threaded event loop, no torn state).
async function telegramCommandLoop(state) {
  if (!telegramConfigured()) {
    log.warn('TELEGRAM_BOT_TOKEN not set — alerts will only appear in logs');
    return;
  }
  try {
    const me = await getMe();
    log.info(`telegram bot connected: @${me.username}`);
  } catch (e) {
    log.error(`telegram getMe failed — check TELEGRAM_BOT_TOKEN: ${e.message}`);
    return;
  }
  if (state.chatId) setChatId(state.chatId);

  for (;;) {
    const offset = await pollUpdates(state.telegramUpdateOffset || 0, async (text, chatId) => {
      const bound = getChatId();
      if (!bound) {
        // First contact binds the chat. (Single-user bot by design.)
        setChatId(chatId);
        state.chatId = String(chatId);
        log.info(`bound telegram chat ${chatId}`);
        await sendMessage(
          `👋 Connected. This chat will now receive ${config.movieTitle} ${config.formatDisplay} seat alerts for ${config.theatreName}.\nCommands: /status /help`
        );
        return;
      }
      if (String(chatId) !== String(bound)) return; // ignore strangers

      if (/^\/status/i.test(text)) {
        await sendMessage(buildStatusText(state));
      } else if (/^\/help|^\/start/i.test(text)) {
        await sendMessage(
          `Monitoring <b>${config.movieTitle}</b> in <b>${config.formatDisplay}</b> at ${config.theatreName}.\n` +
            `• alerts when a sold-out show opens up (with seat count + buy link)\n` +
            `• alerts when new showtimes/dates appear\n` +
            `• daily ${config.dailySummaryHour}am check-in\n\n/status — current seat picture`
        );
      }
    });
    if (offset !== state.telegramUpdateOffset) {
      state.telegramUpdateOffset = offset;
      saveState(state); // persist so restarts don't replay old commands
    }
  }
}

async function main() {
  log.info(`amc-70mm-monitor starting: ${describeConfig()}`);
  const state = loadState();

  if (process.argv.includes('--once')) {
    try {
      await runCycle(state, 1);
    } finally {
      saveState(state);
      await closeBrowser();
    }
    return;
  }

  // Run the Telegram listener and the polling loop concurrently over ONE
  // shared state object. Each loop catches its own errors; Promise.all here
  // only ends on a truly fatal bug, which systemd's Restart=always handles.
  await Promise.all([mainLoop(state), telegramCommandLoop(state)]);
}

main().catch(async (e) => {
  log.error(`fatal: ${e.stack || e.message}`);
  await closeBrowser();
  process.exit(1);
});
