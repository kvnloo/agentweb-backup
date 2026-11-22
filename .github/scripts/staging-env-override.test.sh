#!/usr/bin/env bash
#
# Tests for .github/scripts/staging-env-override.sh (ENG-2359).
# A fake `aws` records its argv so we assert the exact EB calls and, more
# importantly, that production / non-allowlisted keys are refused before any
# AWS call is made.
#
# Run with:  bash .github/scripts/staging-env-override.test.sh

# shellcheck disable=SC2016,SC2034  # check() evals single-quoted asserts lazily; rc is read inside them

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/staging-env-override.sh"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT
TESTS_RUN=0; TESTS_FAILED=0

FAKE="${WORKDIR}/aws"
cat >"$FAKE" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$AWS_LOG"
if [[ "$*" == *describe-environments* ]]; then echo "Ready"; fi
EOF
chmod +x "$FAKE"

run() {
  : >"${WORKDIR}/log"
  AWS_CMD="$FAKE" AWS_LOG="${WORKDIR}/log" WAIT_INTERVAL_SECONDS=0 \
    bash "$SCRIPT" "$@" >"${WORKDIR}/out" 2>&1
  echo $?
}

check() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if eval "$2"; then echo "ok - $1"; else echo "FAIL - $1"; TESTS_FAILED=$((TESTS_FAILED + 1)); cat "${WORKDIR}/out" "${WORKDIR}/log"; fi
}

rc=$(EB_ENVIRONMENT_NAME=agentweb-backend-prod run set LEAD_MAGNET_EXECUTE_DISABLED=true)
check "refuses non-staging env" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME='' run set LEAD_MAGNET_EXECUTE_DISABLED=true)
check "requires env name" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=backend-staging run set OPENAI_API_KEY=x)
check "refuses non-allowlisted key" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=backend-staging run restore DATABASE_URL)
check "refuses non-allowlisted restore" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=backend-staging run set LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY=1,2)
check "refuses comma values" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=Backend-Staging run set LEAD_MAGNET_EXECUTE_DISABLED=true LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY=1)
check "set issues one update-environment with both options" '[[ $rc == 0 ]] && grep -q "update-environment .*--environment-name Backend-Staging --option-settings Namespace=aws:elasticbeanstalk:application:environment,OptionName=LEAD_MAGNET_EXECUTE_DISABLED,Value=true Namespace=aws:elasticbeanstalk:application:environment,OptionName=LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY,Value=1" ${WORKDIR}/log'
check "set waits for Ready before and after" '[[ $(grep -c describe-environments ${WORKDIR}/log) -ge 2 ]]'

rc=$(EB_ENVIRONMENT_NAME=backend-staging run restore LEAD_MAGNET_EXECUTE_DISABLED)
check "restore removes the option" '[[ $rc == 0 ]] && grep -q "update-environment .*--options-to-remove Namespace=aws:elasticbeanstalk:application:environment,OptionName=LEAD_MAGNET_EXECUTE_DISABLED$" ${WORKDIR}/log'

rc=$(EB_ENVIRONMENT_NAME=backend-staging run bogus)
check "unknown command fails" '[[ $rc == 2 ]]'

echo "${TESTS_RUN} run, ${TESTS_FAILED} failed"
[[ $TESTS_FAILED == 0 ]]
