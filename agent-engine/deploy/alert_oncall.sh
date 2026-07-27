#!/usr/bin/env bash
# Invoked by systemd's agent-engine-alert@.service (OnFailure= companion unit)
# when agent-engine.service fails to restart/stay up. Posts to a Slack
# incoming webhook whose URL is fetched via secrets_manager.py, so it uses
# the same env-var-first/Secrets-Manager-fallback resolution as everything
# else (see secrets_manager.get_alert_webhook_url()).
set -euo pipefail

FAILED_UNIT="${1:-agent-engine.service}"
HOST="$(hostname)"
TIMESTAMP="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

WEBHOOK_URL="$(python3 -c 'import secrets_manager; print(secrets_manager.get_alert_webhook_url())')"

if [ -z "$WEBHOOK_URL" ]; then
  echo "alert_oncall.sh: no alert webhook URL configured, cannot page oncall" >&2
  exit 1
fi

curl -sS -X POST -H 'Content-type: application/json' \
  --data "$(printf '{"text":"agent-engine (%s) failed on %s at %s"}' "$FAILED_UNIT" "$HOST" "$TIMESTAMP")" \
  "$WEBHOOK_URL"
