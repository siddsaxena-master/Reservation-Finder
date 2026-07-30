// Telegram Bot API client — zero dependencies, plain fetch.
// Outbound messages (alerts, summaries, warnings) + a long-polling loop for
// inbound commands (/status, /start, /help).

import { config } from './config.js';
import { log } from './logger.js';

const API = () => `https://api.telegram.org/bot${config.telegramToken}`;

// Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set
// (systemd unit sets it when needed). Nothing else required here.

async function api(method, payload) {
  const res = await fetch(`${API()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`telegram ${method} failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.result;
}

export function telegramConfigured() {
  return Boolean(config.telegramToken);
}

let cachedChatId = '';
export function setChatId(id) {
  cachedChatId = String(id || '');
}
export function getChatId() {
  return cachedChatId || config.telegramChatId;
}

export async function sendMessage(text, { silent = false } = {}) {
  if (!telegramConfigured()) {
    log.warn(`telegram not configured; would have sent: ${text.split('\n')[0]}`);
    return false;
  }
  const chatId = getChatId();
  if (!chatId) {
    log.warn('no chat id yet — send /start to the bot once; message queued to log only');
    return false;
  }
  try {
    await api('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: silent,
    });
    return true;
  } catch (e) {
    log.error(`telegram send failed: ${e.message}`);
    return false;
  }
}

export async function getMe() {
  return api('getMe');
}

// Long-poll for commands. onCommand(cmd, chatId) is called for each inbound
// text message; the offset is persisted by the caller via state.
export async function pollUpdates(offset, onCommand) {
  if (!telegramConfigured()) return offset;
  try {
    const updates = await api('getUpdates', {
      offset,
      timeout: config.telegramPollTimeoutSec,
      allowed_updates: ['message'],
    });
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      const msg = u.message;
      if (!msg || !msg.text) continue;
      await onCommand(msg.text.trim(), msg.chat.id);
    }
  } catch (e) {
    if (!/aborted|timeout/i.test(e.message)) log.error(`telegram poll error: ${e.message}`);
    // brief pause so a hard API error can't hot-loop
    await new Promise((r) => setTimeout(r, 5000));
  }
  return offset;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
