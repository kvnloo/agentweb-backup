#!/usr/bin/env bash
# Deliver a handoff (JSON on stdin) to the autofix box.
#
# Two transports, in order:
#   1. http://localhost:8790 — free when your SSH session is already open, because you connect with
#      `-L 8790:localhost:8790`, which makes the laptop's 8790 the box's chat server. This is the
#      normal case and needs no key, no IP, and no extra connection.
#   2. a one-shot `ssh ... 'curl ...'` — for when no tunnel is up. Needs the key and the current IP.
#
# The box's chat server binds 127.0.0.1 with no auth by design, so there is deliberately no third
# option here: reaching it always requires SSH access to the box.
#
# Config (all optional, override via env or ~/.autofix-handoff.conf):
#   AUTOFIX_HOST  public IP / hostname of the box   (changes on stop/start — see below)
#   AUTOFIX_KEY   ssh private key
#   AUTOFIX_PORT  chat server port                  (default 8790)
set -euo pipefail

[ -f "$HOME/.autofix-handoff.conf" ] && . "$HOME/.autofix-handoff.conf"
HOST="${AUTOFIX_HOST:-54.148.185.209}"
KEY="${AUTOFIX_KEY:-$HOME/.ssh/agentweb-test-env-harshit.pem}"
PORT="${AUTOFIX_PORT:-8790}"
URL="/api/handoff"

payload="$(cat)"
[ -n "$payload" ] || { echo "send-handoff: nothing on stdin" >&2; exit 2; }

emit() { # print the response, exit non-zero unless the box accepted it (202)
  local code="$1" body="$2"
  echo "$body"
  case "$code" in
    202) exit 0 ;;
    400) echo "send-handoff: the box rejected this handoff (see the error above) — fix and retry" >&2; exit 1 ;;
    *)   echo "send-handoff: unexpected HTTP $code from the box" >&2; exit 1 ;;
  esac
}

# 1. Existing tunnel.
if curl -sS -m 3 -o /dev/null "http://localhost:$PORT/api/health" 2>/dev/null; then
  out="$(printf '%s' "$payload" | curl -sS -m 300 -w '\n%{http_code}' \
        -XPOST "http://localhost:$PORT$URL" -H 'content-type: application/json' --data-binary @-)"
  emit "$(printf '%s' "$out" | tail -n1)" "$(printf '%s' "$out" | sed '$d')"
fi

# 2. No tunnel — go direct. Fail loudly about WHICH thing is missing; a wrong IP after a stop/start
# is the single most likely cause and is invisible otherwise.
[ -f "$KEY" ] || { echo "send-handoff: no tunnel on localhost:$PORT, and the ssh key is missing: $KEY" >&2; exit 2; }
echo "send-handoff: no tunnel on localhost:$PORT — connecting to $HOST directly…" >&2
if ! out="$(printf '%s' "$payload" | ssh -i "$KEY" -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
      "ec2-user@$HOST" "curl -sS -m 300 -w '\n%{http_code}' -XPOST 'http://localhost:$PORT$URL' \
      -H 'content-type: application/json' --data-binary @-" 2>/dev/null)"; then
  cat >&2 <<EOF
send-handoff: could not reach the box at $HOST.
  The public IP changes every time the instance is stopped and started, so a stale IP is the usual cause.
  Get the current one, then either export AUTOFIX_HOST=<ip> or put it in ~/.autofix-handoff.conf:
      aws ec2 describe-instances --instance-ids i-0cb38aac2332941dc \\
        --query 'Reservations[].Instances[].PublicIpAddress' --output text
EOF
  exit 2
fi
emit "$(printf '%s' "$out" | tail -n1)" "$(printf '%s' "$out" | sed '$d')"
