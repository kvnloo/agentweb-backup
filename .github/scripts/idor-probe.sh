#!/usr/bin/env bash
#
# Cross-tenant (IDOR) negative probe for the post-merge verifier (ENG-2419,
# parent ENG-2405).
#
# Calls POST /api/domains/custom as tenant B against a project owned by
# tenant A and requires HTTP 403. The 403 path returns before any Vercel call
# (ENG-2403), so a correct deployment has no side effects.
#
# Fixture contract (all required; provisioning is gated on ENG-2405):
#   IDOR_API_BASE        API origin, e.g. https://api.agentweb.pro
#   TENANT_B_TOKEN       bearer token for tenant B (the attacker)
#   FIXTURE_PROJECT_ID   vercelProjectId owned by tenant A
#   TENANT_A_TOKEN       required so the fixture is a real two-tenant pair
#
# Exit codes:
#   0  PASS                 403 observed
#   1  FAIL                 any other status (2xx = IDOR; 4xx/5xx = inconclusive)
#   3  SKIPPED_NO_FIXTURE   fixture env missing. Never a pass (matches
#                           merge-evidence.sh NO_EVIDENCE=3).
#
# Tokens are passed to curl via a config on stdin, never argv, and never printed.

set -uo pipefail

PROBE_DOMAIN="${IDOR_PROBE_DOMAIN:-idor-probe.invalid}"

missing=()
for v in IDOR_API_BASE TENANT_A_TOKEN TENANT_B_TOKEN FIXTURE_PROJECT_ID; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "SKIPPED_NO_FIXTURE: missing ${missing[*]} (see ENG-2405)"
  exit 3
fi

body=$(printf '{"vercelProjectId":"%s","domain":"%s"}' "$FIXTURE_PROJECT_ID" "$PROBE_DOMAIN")

status=$(printf 'header = "Authorization: Bearer %s"\n' "$TENANT_B_TOKEN" |
  curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -K - \
    -X POST -H 'Content-Type: application/json' \
    --data "$body" "${IDOR_API_BASE%/}/api/domains/custom" 2>/dev/null) || status="000"

case "$status" in
  403)
    echo "PASS: cross-tenant POST /api/domains/custom returned 403"
    exit 0
    ;;
  2??)
    echo "FAIL: IDOR — tenant B attached a domain to tenant A's project (HTTP ${status}); remove ${PROBE_DOMAIN} from the fixture project"
    exit 1
    ;;
  *)
    echo "FAIL: inconclusive — expected 403, got HTTP ${status}"
    exit 1
    ;;
esac
