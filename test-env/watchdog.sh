#!/bin/bash
# watchdog.sh — Shuts down the instance after 24 hours of inactivity.
# Runs via cron every hour. Combined with instance-initiated-shutdown-behavior=terminate,
# a shutdown will terminate the instance.
#
# Supports two modes:
#   Docker mode: "Activity" = any Docker container logs in the last 24 hours
#   Dev mode:    "Activity" = active SSH sessions OR log files modified within 24 hours

set -euo pipefail

IDLE_LIMIT=$((24 * 3600))  # 24 hours in seconds
ACTIVITY_FILE="/tmp/test-env-last-activity"

# Detect mode: dev mode has .test-env-dev-ready and no Docker
is_dev_mode() {
  [[ -f /home/ec2-user/.test-env-dev-ready ]] && ! command -v docker &>/dev/null
}

check_activity() {
  if is_dev_mode; then
    # Dev mode: check for active SSH sessions
    if who | grep -q .; then
      return 0  # activity detected
    fi

    # Dev mode: check if any log files modified within 24 hours
    local log_dir="/home/ec2-user/agentweb/logs"
    if [[ -d "$log_dir" ]]; then
      local recent
      recent=$(find "$log_dir" -name '*.log' -mmin -1440 2>/dev/null | head -1)
      if [[ -n "$recent" ]]; then
        return 0  # activity detected
      fi
    fi

    return 1  # no activity
  else
    # Docker mode: check Docker container logs
    local compose_dir="/home/ec2-user/agentweb/test-env"
    if [[ ! -d "$compose_dir" ]]; then
      return 1
    fi

    local recent_logs
    recent_logs=$(cd "$compose_dir" && docker compose logs --since 24h 2>/dev/null | head -1)
    if [[ -n "$recent_logs" ]]; then
      return 0  # activity detected
    fi

    return 1  # no activity
  fi
}

if check_activity; then
  # Activity detected — update timestamp
  date +%s > "$ACTIVITY_FILE"
  exit 0
fi

# No activity — check how long we've been idle
if [[ -f "$ACTIVITY_FILE" ]]; then
  LAST_ACTIVITY=$(cat "$ACTIVITY_FILE")
else
  # No activity file means first check with no activity — start the clock now
  date +%s > "$ACTIVITY_FILE"
  exit 0
fi

NOW=$(date +%s)
IDLE_SECONDS=$((NOW - LAST_ACTIVITY))

if [[ $IDLE_SECONDS -ge $IDLE_LIMIT ]]; then
  echo "$(date): No activity for $((IDLE_SECONDS / 86400)) days. Shutting down."
  shutdown -h now
else
  echo "$(date): Idle for $((IDLE_SECONDS / 3600)) hours (limit: $((IDLE_LIMIT / 3600))h)"
fi
