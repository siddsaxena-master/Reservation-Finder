#!/usr/bin/env bash
# Idempotent installer for the AMC 70mm monitor as a systemd service.
# Run from the repo root on the droplet:   sudo deploy/install.sh
# Re-run safely after every `git pull`.
set -euo pipefail

SERVICE=amc-70mm-monitor
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Run the service as the user who owns the checkout (not root)
APP_USER="$(stat -c '%U' "$APP_DIR")"

if [[ $EUID -ne 0 ]]; then
  echo "run with sudo: sudo deploy/install.sh" >&2
  exit 1
fi

command -v node >/dev/null || { echo "node not found — install Node.js >= 20 first" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || { echo "Node >= 20 required (found $(node -v))" >&2; exit 1; }

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "WARNING: $APP_DIR/.env not found — copy .env.example and set TELEGRAM_BOT_TOKEN" >&2
fi

echo "==> npm ci (as $APP_USER)"
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm ci"

echo "==> playwright chromium (+ OS deps)"
# --with-deps needs root for apt; browser itself lands in the user's cache
npx --prefix "$APP_DIR" playwright install-deps chromium
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npx playwright install chromium"

echo "==> systemd unit"
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__APP_USER__|$APP_USER|g" \
  "$APP_DIR/deploy/$SERVICE.service" > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE"      # start on boot
systemctl restart "$SERVICE"     # (re)start now

sleep 3
systemctl --no-pager --lines=5 status "$SERVICE" || true
echo
echo "Done. Follow logs with:  journalctl -u $SERVICE -f"
