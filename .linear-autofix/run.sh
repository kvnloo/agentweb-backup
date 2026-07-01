#!/usr/bin/env bash
# .linear-autofix/run.sh — one poll cycle. Wire this to cron.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$REPO"

# Load LINEAR_API_KEY (and any overrides) from .linear-autofix/.env if present.
if [ -f "$HERE/.env" ]; then set -a; . "$HERE/.env"; set +a; fi

# Prevent overlapping poll cycles.
exec 9>"$HERE/.poll.lock"
if ! flock -n 9; then
  echo "[autofix] previous poll still running; skipping this cycle"
  exit 0
fi

node "$HERE/poll.mjs" >>"$HERE/poll.log" 2>&1
node "$HERE/gc.mjs"   >>"$HERE/poll.log" 2>&1   # remove worktrees whose issue is Done/Canceled
