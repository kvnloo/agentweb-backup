#!/bin/bash
# dev-services.sh — Manages dev server tmux sessions on the EC2 instance
#
# Usage:
#   dev-services.sh start-all     Start all 4 dev servers in tmux sessions
#   dev-services.sh stop-all      Kill all tmux sessions
#   dev-services.sh restart <svc> Stop + start one service
#   dev-services.sh status        Show session state + PIDs
#   dev-services.sh logs <svc>    Tail log file for a service
set -euo pipefail

APP_DIR="/home/ec2-user/agentweb"
LOG_DIR="$APP_DIR/logs"

# Service definitions: session_name → (directory, command)
start_service() {
  local svc="$1"
  local dir cmd

  case "$svc" in
    backend)
      dir="$APP_DIR/backend"
      cmd="npx ts-node-dev --respawn --exit-child --transpile-only src/server.ts"
      ;;
    partner-portal)
      dir="$APP_DIR/partner-portal"
      cmd="npx vite --host 0.0.0.0 --port 5173"
      ;;
    customer-portal)
      dir="$APP_DIR/customer-portal"
      cmd="npx vite --host :: --port 5174"
      ;;
    test-env-access)
      dir="$APP_DIR/test-env-access"
      cmd="node server.js"
      ;;
    *)
      echo "Unknown service: $svc"
      exit 1
      ;;
  esac

  # Kill existing session if any
  tmux kill-session -t "$svc" 2>/dev/null || true

  mkdir -p "$LOG_DIR"

  # Start tmux session with the dev command, tee output to log file
  tmux new-session -d -s "$svc" -c "$dir" \
    "bash -c '$cmd 2>&1 | tee -a $LOG_DIR/$svc.log; echo \"[EXIT \$?] $(date)\" >> $LOG_DIR/$svc.log; exec bash'"

  echo "Started $svc (tmux session: $svc, log: $LOG_DIR/$svc.log)"
}

stop_service() {
  local svc="$1"
  tmux kill-session -t "$svc" 2>/dev/null && echo "Stopped $svc" || echo "$svc not running"
}

cmd_start_all() {
  for svc in backend partner-portal customer-portal test-env-access; do
    start_service "$svc"
  done
  echo ""
  echo "All services started. Use 'dev-services.sh status' to check."
}

cmd_stop_all() {
  for svc in backend partner-portal customer-portal test-env-access; do
    stop_service "$svc"
  done
}

cmd_restart() {
  local svc="${1:-}"
  if [[ -z "$svc" ]]; then
    echo "Usage: dev-services.sh restart <backend|partner-portal|customer-portal|test-env-access>"
    exit 1
  fi
  stop_service "$svc"
  sleep 1
  start_service "$svc"
}

cmd_status() {
  echo "Dev Services Status:"
  echo "===================="
  for svc in backend partner-portal customer-portal test-env-access; do
    if tmux has-session -t "$svc" 2>/dev/null; then
      local pid
      pid=$(tmux list-panes -t "$svc" -F '#{pane_pid}' 2>/dev/null | head -1)
      echo "  $svc: RUNNING (tmux session, shell PID: ${pid:-unknown})"
    else
      echo "  $svc: STOPPED"
    fi
  done
}

cmd_logs() {
  local svc="${1:-}"
  if [[ -z "$svc" ]]; then
    echo "Usage: dev-services.sh logs <backend|partner-portal|customer-portal|test-env-access>"
    exit 1
  fi
  local logfile="$LOG_DIR/$svc.log"
  if [[ -f "$logfile" ]]; then
    tail -f "$logfile"
  else
    echo "No log file found: $logfile"
    exit 1
  fi
}

# Dispatch
CMD="${1:-help}"
shift || true

case "$CMD" in
  start-all)  cmd_start_all ;;
  stop-all)   cmd_stop_all ;;
  restart)    cmd_restart "${1:-}" ;;
  status)     cmd_status ;;
  logs)       cmd_logs "${1:-}" ;;
  help|*)
    echo "Usage: dev-services.sh <command>"
    echo ""
    echo "Commands:"
    echo "  start-all               Start all dev servers in tmux sessions"
    echo "  stop-all                Kill all tmux sessions"
    echo "  restart <service>       Restart one service"
    echo "  status                  Show session state"
    echo "  logs <service>          Tail log file for a service"
    echo ""
    echo "Services: backend, partner-portal, customer-portal, test-env-access"
    ;;
esac
