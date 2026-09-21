#!/usr/bin/env bash
# Q-001: Hermes MCP OAuth discovery smoke (no tokens persisted).
set -euo pipefail

BASE="${HERMES_SMOKE_BASE_URL:-https://api.agentweb.pro}"
BASE="${BASE%/}"

echo "== Hermes MCP OAuth smoke: $BASE =="

echo "-- 1. Authorization server metadata"
META=$(curl -fsS "$BASE/.well-known/oauth-authorization-server")
echo "$META" | jq -e '.authorization_endpoint and .token_endpoint and .registration_endpoint' >/dev/null
AUTH_ENDPOINT=$(echo "$META" | jq -r '.authorization_endpoint')
echo "   authorization_endpoint: $AUTH_ENDPOINT"

echo "-- 2. Dynamic client registration (ephemeral)"
REG=$(curl -fsS -X POST "$BASE/oauth/register" \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"hermes-smoke","redirect_uris":["http://127.0.0.1:49152/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}')
CLIENT_ID=$(echo "$REG" | jq -r '.client_id')
test -n "$CLIENT_ID" && test "$CLIENT_ID" != null
echo "   client_id: ${CLIENT_ID:0:8}..."

echo "-- 3. Authorize redirect (expect 302, no token)"
VERIFIER=$(python3 - <<'PY'
import hashlib, base64, secrets
v = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
print(v)
PY
)
CHALLENGE=$(python3 - <<PY
import hashlib, base64
v = "$VERIFIER"
d = hashlib.sha256(v.encode()).digest()
print(base64.urlsafe_b64encode(d).decode().rstrip('='))
PY
)
STATE="smoke-$(date +%s)"
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' \
  "$AUTH_ENDPOINT?response_type=code&client_id=$CLIENT_ID&redirect_uri=http://127.0.0.1:49152/callback&state=$STATE&code_challenge=$CHALLENGE&code_challenge_method=S256")
if [ "$STATUS" != "302" ] && [ "$STATUS" != "303" ]; then
  echo "   unexpected authorize status: $STATUS" >&2
  exit 1
fi
echo "   authorize HTTP $STATUS (redirect to consent — OK)"

echo "== smoke passed (discovery + DCR + authorize redirect) =="
