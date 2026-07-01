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

# Rotate the poll log when it grows past ~5MB (keep one previous).
if [ -f "$HERE/poll.log" ] && [ "$(stat -c%s "$HERE/poll.log" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  mv "$HERE/poll.log" "$HERE/poll.log.1"
fi

node "$HERE/poll.mjs" >>"$HERE/poll.log" 2>&1
node "$HERE/gc.mjs"   >>"$HERE/poll.log" 2>&1   # remove worktrees whose issue is Done/Canceled
