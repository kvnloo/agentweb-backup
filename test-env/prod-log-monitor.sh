#!/bin/bash
# prod-log-monitor.sh — Proactive production log monitor.
# Fetches tail logs from Elastic Beanstalk, scans for error/intrusion patterns,
# and sends alert emails when issues are detected.
#
# Usage:
#   ./prod-log-monitor.sh run          Run a single scan (default)
#   ./prod-log-monitor.sh install      Install cron job (every 15 min)
#   ./prod-log-monitor.sh uninstall    Remove cron job
#   ./prod-log-monitor.sh status       Show cron status + last run info
#   ./prod-log-monitor.sh test-email   Send a test alert email
#
# Environment:
#   LOG_MONITOR_ENV=prod|staging   (default: prod)
#     prod    → Agentweb-backend-env-prod-3
#     staging → Agentweb-backend-env-1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="$REPO_DIR/logs/prod-log-monitor.log"
STATE_FILE="/tmp/prod-log-monitor-state.json"
TEMP_DIR="/tmp/prod-log-monitor"
BACKEND_ENV_FILE="$REPO_DIR/backend/.env"
AWS_REGION="us-west-2"

LOG_MONITOR_ENV="${LOG_MONITOR_ENV:-prod}"
case "$LOG_MONITOR_ENV" in
  prod)    EB_ENV_NAME="Agentweb-backend-env-prod-3" ;;
  staging) EB_ENV_NAME="Agentweb-backend-env-1" ;;
  *)
    echo "ERROR: LOG_MONITOR_ENV must be 'prod' or 'staging' (got: $LOG_MONITOR_ENV)"
    exit 1
    ;;
esac

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ─── Commands ─────────────────────────────────────────────────────────────────

cmd_run() {
  log "=== Starting log scan ($LOG_MONITOR_ENV → $EB_ENV_NAME) ==="

  log "Requesting tail logs from $EB_ENV_NAME..."
  aws elasticbeanstalk request-environment-info \
    --environment-name "$EB_ENV_NAME" \
    --info-type tail \
    --region "$AWS_REGION" \
    --output text > /dev/null 2>&1

  log "Waiting 8 seconds for logs..."
  sleep 8

  log "Retrieving log URLs..."
  local log_json
  log_json=$(aws elasticbeanstalk retrieve-environment-info \
    --environment-name "$EB_ENV_NAME" \
    --info-type tail \
    --region "$AWS_REGION" \
    --output json 2>&1)

  if [[ -z "$log_json" ]] || ! echo "$log_json" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    log "ERROR: Failed to retrieve log info: $log_json"
    log "=== Scan complete (error) ==="
    return 1
  fi

  # Hand off to Python for download, scan, and email
  echo "$log_json" | python3 "$SCRIPT_DIR/prod-log-monitor-scan.py" \
    --env-name "$EB_ENV_NAME" \
    --env-label "$LOG_MONITOR_ENV" \
    --state-file "$STATE_FILE" \
    --backend-env "$BACKEND_ENV_FILE" \
    --temp-dir "$TEMP_DIR"

  log "=== Scan complete ==="
}

cmd_test_email() {
  echo "Sending test alert email to ruiw@agentweb.pro..."
  python3 "$SCRIPT_DIR/prod-log-monitor-scan.py" \
    --env-name "$EB_ENV_NAME" \
    --env-label "$LOG_MONITOR_ENV" \
    --state-file "$STATE_FILE" \
    --backend-env "$BACKEND_ENV_FILE" \
    --temp-dir "$TEMP_DIR" \
    --test-email
  echo "Done. Check ruiw@agentweb.pro for the test email."
}

cmd_install() {
  local cron_entry="*/15 * * * * LOG_MONITOR_ENV=$LOG_MONITOR_ENV /bin/bash $SCRIPT_DIR/prod-log-monitor.sh run >> $LOG_FILE 2>&1"
  local existing
  existing=$(crontab -l 2>/dev/null || true)

  if echo "$existing" | grep -qF "prod-log-monitor.sh"; then
    echo "Cron job already installed. Current entry:"
    echo "$existing" | grep "prod-log-monitor.sh"
    echo ""
    echo "To change environment, run: $0 uninstall && LOG_MONITOR_ENV=staging $0 install"
    return 0
  fi

  (echo "$existing"; echo "$cron_entry") | crontab -
  echo "Cron job installed (LOG_MONITOR_ENV=$LOG_MONITOR_ENV):"
  echo "  $cron_entry"
  echo ""
  echo "Logs: $LOG_FILE"
  echo "To switch env: $0 uninstall && LOG_MONITOR_ENV=staging $0 install"
}

cmd_uninstall() {
  local existing
  existing=$(crontab -l 2>/dev/null || true)

  if ! echo "$existing" | grep -qF "prod-log-monitor.sh"; then
    echo "No cron job found for prod-log-monitor.sh"
    return 0
  fi

  echo "$existing" | grep -v "prod-log-monitor.sh" | crontab -
  echo "Cron job removed."
}

cmd_status() {
  echo "=== Prod Log Monitor Status ==="
  echo ""
  echo "Environment:  LOG_MONITOR_ENV=$LOG_MONITOR_ENV → $EB_ENV_NAME"
  echo ""

  local cron_entry
  cron_entry=$(crontab -l 2>/dev/null | grep "prod-log-monitor.sh" || true)
  if [[ -n "$cron_entry" ]]; then
    echo "Cron:         INSTALLED"
    echo "  Entry:      $cron_entry"
  else
    echo "Cron:         NOT INSTALLED"
  fi
  echo ""

  if [[ -f "$STATE_FILE" ]]; then
    python3 -c "
import json, time
state = json.load(open('$STATE_FILE'))
last_run = state.get('lastRun', 0)
last_env = state.get('lastRunEnv', 'unknown')
alerts = state.get('alerts', {})
if last_run:
    elapsed = int(time.time()) - last_run
    mins = elapsed // 60
    print(f'Last run:     {mins} minutes ago (env: {last_env})')
else:
    print('Last run:     never')
active = sum(1 for ts in alerts.values() if time.time() - ts < 7200)
print(f'Active alerts: {active} (suppressed for 2h)')
total = len(alerts)
print(f'Total alerts:  {total} (last 24h)')
"
  else
    echo "Last run:     never (no state file)"
  fi
  echo ""

  if [[ -f "$LOG_FILE" ]]; then
    local lines size
    lines=$(wc -l < "$LOG_FILE")
    size=$(du -h "$LOG_FILE" | cut -f1)
    echo "Log file:     $LOG_FILE ($lines lines, $size)"
    echo ""
    echo "Last 5 log lines:"
    tail -5 "$LOG_FILE"
  else
    echo "Log file:     $LOG_FILE (not yet created)"
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────

COMMAND="${1:-run}"
case "$COMMAND" in
  run)          cmd_run ;;
  install)      cmd_install ;;
  uninstall)    cmd_uninstall ;;
  status)       cmd_status ;;
  test-email)   cmd_test_email ;;
  *)
    echo "Usage: $0 {run|install|uninstall|status|test-email}"
    echo ""
    echo "Environment variables:"
    echo "  LOG_MONITOR_ENV=prod|staging  (default: prod)"
    exit 1
    ;;
esac
