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

async function telegramCommandLoop() {
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
  const state = loadState();
  if (state.chatId) setChatId(state.chatId);
  let offset = state.telegramUpdateOffset || 0;

  for (;;) {
    offset = await pollUpdates(offset, async (text, chatId) => {
      const bound = getChatId();
      if (!bound) {
        // First contact binds the chat. (Single-user bot by design.)
        setChatId(chatId);
        const st = loadState();
        st.chatId = String(chatId);
        saveState(st);
        log.info(`bound telegram chat ${chatId}`);
        await sendMessage(
          `👋 Connected. This chat will now receive ${config.movieTitle} ${config.formatDisplay} seat alerts for ${config.theatreName}.\nCommands: /status /help`
        );
        if (!/^\/start/.test(text)) return;
        return;
      }
      if (String(chatId) !== String(bound)) return; // ignore strangers

      if (/^\/status/i.test(text)) {
        const st = loadState();
        await sendMessage(buildStatusText(st));
      } else if (/^\/help|^\/start/i.test(text)) {
        await sendMessage(
          `Monitoring <b>${config.movieTitle}</b> in <b>${config.formatDisplay}</b> at ${config.theatreName}.\n` +
            `• alerts when a sold-out show opens up (with seat count + buy link)\n` +
            `• alerts when new showtimes/dates appear\n` +
            `• daily ${config.dailySummaryHour}am check-in\n\n/status — current seat picture`
        );
      }
    });
    // persist the update offset so restarts don't replay old commands
    const st = loadState();
    if (offset !== st.telegramUpdateOffset || (getChatId() && st.chatId !== getChatId())) {
      st.telegramUpdateOffset = offset;
      if (getChatId()) st.chatId = String(getChatId());
      saveState(st);
    }
  }
}

async function main() {
  log.info(`amc-70mm-monitor starting: ${describeConfig()}`);

  if (process.argv.includes('--once')) {
    const state = loadState();
    try {
      await runCycle(state, 1);
    } finally {
      saveState(state);
      await closeBrowser();
    }
    return;
  }

  // Run the Telegram listener and the polling loop concurrently. Each loop
  // catches its own errors; Promise.all here only ends on a truly fatal bug,
  // which systemd's Restart=always then handles.
  await Promise.all([mainLoop(), telegramCommandLoop()]);
}

main().catch(async (e) => {
  log.error(`fatal: ${e.stack || e.message}`);
  await closeBrowser();
  process.exit(1);
});
