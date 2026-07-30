import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function ts() {
  return new Date().toISOString();
}

function write(level, msg) {
  const line = `${ts()} [${level}] ${msg}`;
  // stdout for journald / pm2; optional file for convenience.
  console.log(line);
  if (config.logFile) {
    try {
      fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
      fs.appendFileSync(config.logFile, line + '\n');
    } catch {
      /* never let logging kill the monitor */
    }
  }
}

export const log = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
  debug: (m) => {
    if (process.argv.includes('--verbose') || process.env.VERBOSE) write('DEBUG', m);
  },
};
