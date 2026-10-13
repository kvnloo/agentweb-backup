#!/usr/bin/env bash
#
# Tests for .github/scripts/idor-probe.sh (ENG-2419). curl is a scripted mock
# on PATH; nothing touches the network.
#
#   bash .github/scripts/idor-probe.test.sh

# check() evals its condition later, so single quotes are intentional.
# shellcheck disable=SC2016

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${SCRIPT_DIR}/idor-probe.sh"
CANARY='canary-tenant-b-token-0000'

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

mkdir -p "${WORKDIR}/bin"
cat >"${WORKDIR}/bin/curl" <<'MOCK'
#!/usr/bin/env bash
# Records argv and stdin config, prints the scripted status code.
printf '%s\n' "$@" >"${PROBE_MOCK_DIR}/argv"
cat >"${PROBE_MOCK_DIR}/stdin"
cat "${PROBE_MOCK_DIR}/status"
MOCK
chmod +x "${WORKDIR}/bin/curl"

run_probe() { # $1 = mocked status; remaining = env assignments
  local status="$1"; shift
  printf '%s' "$status" >"${WORKDIR}/status"
  OUT=$(env -i PATH="${WORKDIR}/bin:/usr/bin:/bin" PROBE_MOCK_DIR="${WORKDIR}" "$@" bash "$PROBE" 2>&1)
  RC=$?
}

FULL=(IDOR_API_BASE=https://api.example.test TENANT_A_TOKEN=a-token "TENANT_B_TOKEN=${CANARY}" FIXTURE_PROJECT_ID=prj_A)

check() { # name, condition
  TESTS_RUN=$((TESTS_RUN + 1))
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1 (rc=${RC} out=${OUT})"; TESTS_FAILED=$((TESTS_FAILED + 1)); fi
}

run_probe 403 "${FULL[@]}"
check "403 => PASS exit 0" '[ "$RC" -eq 0 ] && [[ "$OUT" == PASS* ]]'
check "B token sent via stdin config" 'grep -q "Bearer ${CANARY}" "${WORKDIR}/stdin"'
check "token absent from argv" '! grep -q "$CANARY" "${WORKDIR}/argv"'
check "token absent from output" '[[ "$OUT" != *"$CANARY"* ]]'
check "targets /api/domains/custom with A project" 'grep -q "https://api.example.test/api/domains/custom" "${WORKDIR}/argv" && grep -q "prj_A" "${WORKDIR}/argv"'

for s in 200 201; do
  run_probe "$s" "${FULL[@]}"
  check "$s => FAIL IDOR exit 1" '[ "$RC" -eq 1 ] && [[ "$OUT" == *IDOR* ]]'
done

for s in 400 401 404 500 000; do
  run_probe "$s" "${FULL[@]}"
  check "$s => FAIL inconclusive exit 1" '[ "$RC" -eq 1 ] && [[ "$OUT" == *inconclusive* ]]'
done

for drop in IDOR_API_BASE TENANT_A_TOKEN TENANT_B_TOKEN FIXTURE_PROJECT_ID; do
  args=()
  for kv in "${FULL[@]}"; do [[ "$kv" == "${drop}="* ]] || args+=("$kv"); done
  rm -f "${WORKDIR}/argv"
  run_probe 403 "${args[@]}"
  check "missing ${drop} => SKIPPED_NO_FIXTURE exit 3, no request" '[ "$RC" -eq 3 ] && [[ "$OUT" == SKIPPED_NO_FIXTURE* ]] && [ ! -f "${WORKDIR}/argv" ]'
done

echo "${TESTS_RUN} run, ${TESTS_FAILED} failed"
[ "$TESTS_FAILED" -eq 0 ]
