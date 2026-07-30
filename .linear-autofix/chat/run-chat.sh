#!/usr/bin/env bash
# .linear-autofix/chat/run-chat.sh — start/stop the chat UI server (long-running, like the
# preview proxy; NOT cron). Usage: run-chat.sh start|stop|status|restart
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="$(cd "$HERE/.." && pwd)"
PIDFILE="$HERE/server.pid"
LOGFILE="$HERE/chat.log"

# Same toolchain fix as run.sh: `claude` and node 20 must resolve from a minimal environment.
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v20.19.5/bin:$PATH"

# LINEAR_API_KEY (issue titles/descriptions) + AUTOFIX_RUN_ENABLED (gates Fix mode).
if [ -f "$BASE/.env" ]; then set -a; . "$BASE/.env"; set +a; fi

alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

PORT="$(node -e "import('$BASE/config.mjs').then(m=>console.log(m.config.chat?.port||8790))" 2>/dev/null || echo 8790)"

# Actually SERVING, not just pid-alive: two quick tries (a busy event loop — e.g. parsing the 22MB
# chat-state.json — can blip a single probe) so `ensure` doesn't flap-restart a healthy-but-busy server.
healthy() {
  for _ in 1 2; do
    curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# ENG-652: systemd (autofix-chat.service) is the SINGLE owner of the server when its unit is active.
# In that mode this script must NEVER spawn a second `node server.mjs` (they'd fight over :8790 /
# EADDRINUSE) and must NOT restart it (systemd's Restart=on-failure does that instantly). So `start`
# no-ops and `ensure` drops to a health-only probe, leaving all lifecycle to systemd.
systemd_owns() { command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet autofix-chat 2>/dev/null; }

case "${1:-}" in
  start)
    if systemd_owns; then echo "[chat] managed by systemd (autofix-chat.service) — use 'systemctl start autofix-chat'"; exit 0; fi
    if alive; then echo "[chat] already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    if [ -f "$LOGFILE" ] && [ "$(stat -c%s "$LOGFILE" 2>/dev/null || echo 0)" -gt 5242880 ]; then
      mv "$LOGFILE" "$LOGFILE.1"
    fi
    # 9>&- closes any inherited poll-lock fd: when run.sh revives this daemon it holds flock on
    # fd 9 (.poll.lock); without this the server inherits + pins it forever, wedging every future
    # poll cycle at `flock -n` (the 2026-07-22 stall — no pickups for ~16h). The server never uses fd 9.
    nohup node "$HERE/server.mjs" >>"$LOGFILE" 2>&1 9>&- &
    echo $! >"$PIDFILE"
    sleep 1
    if healthy; then
      echo "[chat] up on 127.0.0.1:$PORT (pid $(cat "$PIDFILE")) — tunnel: ssh -L $PORT:localhost:$PORT ec2-user@<ip>"
    else
      echo "[chat] started (pid $(cat "$PIDFILE")) but health check failed — see $LOGFILE"
      exit 1
    fi
    ;;
  stop)
    if alive; then
      PID="$(cat "$PIDFILE")"
      kill "$PID" 2>/dev/null || true
      # Wait for the process to actually exit (and release :8790) before returning — otherwise a
      # following `start` (via restart) races the socket teardown and hits EADDRINUSE. Escalate to
      # SIGKILL if it won't go within ~10s, then confirm the pid is gone.
      for _ in $(seq 1 50); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
      if kill -0 "$PID" 2>/dev/null; then kill -9 "$PID" 2>/dev/null || true; sleep 0.5; fi
      rm -f "$PIDFILE"; echo "[chat] stopped"
    else
      echo "[chat] not running"; rm -f "$PIDFILE"
    fi
    ;;
  restart)
    # Self-call via the resolved absolute path, not "$0" — when invoked as `bash run-chat.sh`,
    # "$0" is the bare word "run-chat.sh" which isn't on PATH, so the recursion fails.
    bash "$HERE/run-chat.sh" stop; bash "$HERE/run-chat.sh" start
    ;;
  ensure)
    # ENG-652: when systemd owns the server, cron must NOT supervise it — drop to a health-only probe so
    # the two never race to spawn/restart. systemd (Restart=on-failure, RestartSec=2) already revives a
    # crash instantly; here we just log if it happens to be down mid-restart and leave recovery to systemd.
    if systemd_owns; then
      if healthy; then exit 0; fi
      echo "[chat] systemd unit active but not serving on :$PORT (mid-restart?) — leaving recovery to systemd"
      exit 0
    fi
    # Legacy self-supervision (no systemd unit). Health-gated: this is what run.sh's cron calls every
    # 5 min (NOT plain `start`). `start` only revives a DEAD server (alive() = pid check). But a server
    # can be alive-but-not-serving: wedged on a hang, or lingering after a swallowed listen error. Plain
    # `start` no-ops on those (pid exists) and the tunnel stays dead until a human notices. Here we probe
    # the health endpoint: dead → start; alive-but-unhealthy → restart; healthy → leave it alone.
    if alive; then
      if healthy; then exit 0; fi
      echo "[chat] pid $(cat "$PIDFILE") alive but not serving on :$PORT — restarting"
      bash "$HERE/run-chat.sh" restart
    else
      bash "$HERE/run-chat.sh" start
    fi
    ;;
  status)
    if alive; then echo "[chat] running (pid $(cat "$PIDFILE"))"; else echo "[chat] not running"; exit 1; fi
    ;;
  *)
    echo "Usage: $0 start|stop|status|restart|ensure"; exit 2
    ;;
esac
