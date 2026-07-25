#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/local.xihe.daily-reminders.plist"
LOG_DIR="$PROJECT_DIR/.local/logs"
NODE_BIN="$(command -v node)"

mkdir -p "$LOG_DIR"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.xihe.daily-reminders</string>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--env-file=infra/.env.local</string>
    <string>server/run-daily-reminders.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/daily-reminders.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/daily-reminders.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"

echo "Installed local.xihe.daily-reminders"
echo "Schedule: daily 09:00"
echo "Plist: $PLIST_PATH"
echo "Logs: $LOG_DIR"
