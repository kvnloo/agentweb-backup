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

# Keep the chat server alive AND serving. It hosts the chat UI and drives the autonomous merge WATCH
# loop, so it must never stay down. `ensure` (not `start`) is health-gated: it revives a dead server
# AND restarts a wedged-but-alive one (pid up but not answering /api/health) — which plain `start`
# can't, since it only checks the pid. This is the supervisor that makes an EADDRINUSE/hang self-heal
# within one cycle instead of staying dead until a human notices. Never aborts the cycle (|| true).
bash "$HERE/chat/run-chat.sh" ensure >>"$HERE/poll.log" 2>&1 || true

# Verify each per-assignee GitHub token + Linear key still maps to the right person (catches a
# swapped/expired credential before it mis-attributes). Throttled to ~hourly so we don't hammer the APIs.
CREDMARK="$HERE/.credcheck.stamp"
if [ ! -f "$CREDMARK" ] || [ "$(( $(date +%s) - $(stat -c %Y "$CREDMARK" 2>/dev/null || echo 0) ))" -gt 3600 ]; then
  node "$HERE/check-creds.mjs" >>"$HERE/poll.log" 2>&1
  touch "$CREDMARK"
fi

# Poll heartbeat (ENG-655): emit ONE CloudWatch datapoint only here, at the very END of the cycle — so
# it fires solely on a SUCCESSFUL run (set -e aborts earlier on any failed stage, and a wedged/crashed
# poller never reaches this line). Its absence is the signal: the `no-successful-poll-15m` alarm treats
# missing data as breaching. Namespace/instance are fixed because the least-priv runner role is scoped to
# PutMetricData on AgentWeb/Autofix only, and Harsha's alarm binds to this exact InstanceId. Region is
# explicit (cron's minimal env carries none). Never aborts the cycle (|| …): a transient CloudWatch blip
# must not turn an otherwise-good cycle into a false failure.
aws cloudwatch put-metric-data \
  --region us-west-2 \
  --namespace AgentWeb/Autofix \
  --metric-name PollSuccess --value 1 --unit Count \
  --dimensions InstanceId=i-0cb38aac2332941dc \
  >>"$HERE/poll.log" 2>&1 || echo "[autofix] warning: poll heartbeat put-metric-data failed" >>"$HERE/poll.log"
