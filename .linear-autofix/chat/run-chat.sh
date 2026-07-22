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

case "${1:-}" in
  start)
    if alive; then echo "[chat] already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    if [ -f "$LOGFILE" ] && [ "$(stat -c%s "$LOGFILE" 2>/dev/null || echo 0)" -gt 5242880 ]; then
      mv "$LOGFILE" "$LOGFILE.1"
    fi
    nohup node "$HERE/server.mjs" >>"$LOGFILE" 2>&1 &
    echo $! >"$PIDFILE"
    sleep 1
    PORT="$(node -e "import('$BASE/config.mjs').then(m=>console.log(m.config.chat?.port||8790))")"
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      echo "[chat] up on 127.0.0.1:$PORT (pid $(cat "$PIDFILE")) — tunnel: ssh -L $PORT:localhost:$PORT ec2-user@<ip>"
    else
      echo "[chat] started (pid $(cat "$PIDFILE")) but health check failed — see $LOGFILE"
      exit 1
    fi
    ;;
  stop)
    if alive; then kill "$(cat "$PIDFILE")"; rm -f "$PIDFILE"; echo "[chat] stopped"; else echo "[chat] not running"; rm -f "$PIDFILE"; fi
    ;;
  restart)
    # Self-call via the resolved absolute path, not "$0" — when invoked as `bash run-chat.sh`,
    # "$0" is the bare word "run-chat.sh" which isn't on PATH, so the recursion fails.
    bash "$HERE/run-chat.sh" stop; bash "$HERE/run-chat.sh" start
    ;;
  status)
    if alive; then echo "[chat] running (pid $(cat "$PIDFILE"))"; else echo "[chat] not running"; exit 1; fi
    ;;
  *)
    echo "Usage: $0 start|stop|status|restart"; exit 2
    ;;
esac
