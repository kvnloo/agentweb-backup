#!/bin/bash
# watchdog.sh — Shuts down the instance after 24 hours of inactivity.
# Runs via cron every hour. Combined with instance-initiated-shutdown-behavior=terminate,
# a shutdown will terminate the instance.
#
# "Activity" = any HTTP traffic hitting the Docker containers (backend, partner, customer).

set -euo pipefail

IDLE_LIMIT=$((24 * 3600))  # 24 hours in seconds
ACTIVITY_FILE="/tmp/test-env-last-activity"

# Check if any container has produced logs in the last 24 hours.
# docker compose logs --since outputs nothing if no logs in that window.
COMPOSE_DIR="/home/ec2-user/agentweb/test-env"

if [[ ! -d "$COMPOSE_DIR" ]]; then
  exit 0
fi

RECENT_LOGS=$(cd "$COMPOSE_DIR" && docker compose logs --since 24h 2>/dev/null | head -1)

if [[ -n "$RECENT_LOGS" ]]; then
  # Activity detected — update timestamp
  date +%s > "$ACTIVITY_FILE"
  exit 0
fi

# No recent Docker logs — check how long we've been idle
if [[ -f "$ACTIVITY_FILE" ]]; then
  LAST_ACTIVITY=$(cat "$ACTIVITY_FILE")
else
  # No activity file means first check with no logs — start the clock now
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
