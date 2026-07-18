#!/usr/bin/env bash
# .linear-autofix/run.sh — one poll cycle. Wire this to cron.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$REPO"

# Cron runs with a minimal PATH (system node v18, no `claude`) — the 2026-07-02 first cron cycle
# crashed every fix at the claude spawn because of this. Put the user's toolchain first.
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v20.19.5/bin:$PATH"

# Load LINEAR_API_KEY (and any overrides) from .linear-autofix/.env if present.
if [ -f "$HERE/.env" ]; then set -a; . "$HERE/.env"; set +a; fi

# Prevent overlapping poll cycles.
exec 9>"$HERE/.poll.lock"
if ! flock -n 9; then
  echo "[autofix] previous poll still running; skipping this cycle"
  exit 0
fi

# Rotate the poll log when it grows past ~5MB (keep one previous). Safe rename: no process holds it
# open here (the previous cron cycle has exited before this one acquires the lock).
if [ -f "$HERE/poll.log" ] && [ "$(stat -c%s "$HERE/poll.log" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  mv "$HERE/poll.log" "$HERE/poll.log.1"
fi

# Rotate the chat server's log too (it now carries per-turn STATS lines). The long-running server
# holds it open, so a rename would strand its writes on the old inode — copytruncate instead.
# run-chat.sh opens the log with `>>` (O_APPEND), so after truncation the server's next write lands
# at the new (zero) EOF cleanly, with no sparse file.
CHATLOG="$HERE/chat/chat.log"
if [ -f "$CHATLOG" ] && [ "$(stat -c%s "$CHATLOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  cp "$CHATLOG" "$CHATLOG.1" && : >"$CHATLOG"
fi

node "$HERE/poll.mjs" >>"$HERE/poll.log" 2>&1
node "$HERE/gc.mjs"   >>"$HERE/poll.log" 2>&1   # remove worktrees whose issue is Done/Canceled

# Keep the chat server alive. It hosts the chat UI AND drives the autonomous merge WATCH loop (re-invokes
# a chat every few minutes until its PR merges), so it must never stay down. `start` is a no-op when it's
# already running and revives it after a crash/reboot — so persisted watches always resume. Never aborts
# the cycle (|| true) on a transient health-check miss.
bash "$HERE/chat/run-chat.sh" start >>"$HERE/poll.log" 2>&1 || true

# Verify each per-assignee GitHub token + Linear key still maps to the right person (catches a
# swapped/expired credential before it mis-attributes). Throttled to ~hourly so we don't hammer the APIs.
CREDMARK="$HERE/.credcheck.stamp"
if [ ! -f "$CREDMARK" ] || [ "$(( $(date +%s) - $(stat -c %Y "$CREDMARK" 2>/dev/null || echo 0) ))" -gt 3600 ]; then
  node "$HERE/check-creds.mjs" >>"$HERE/poll.log" 2>&1
  touch "$CREDMARK"
fi
