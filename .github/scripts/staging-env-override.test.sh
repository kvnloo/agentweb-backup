#!/usr/bin/env bash
#
# Tests for .github/scripts/staging-env-override.sh (ENG-2359, ENG-3087).
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

STAGING=Agentweb-backend-env-1
PROD=Agentweb-backend-env-prod-3

# --- ENG-3087: the environment is matched by exact name, never by substring ---

rc=$(EB_ENVIRONMENT_NAME=$STAGING run set LEAD_MAGNET_EXECUTE_DISABLED=true)
check "accepts the real staging environment name" '[[ $rc == 0 ]] && grep -q "update-environment .*--environment-name Agentweb-backend-env-1 " ${WORKDIR}/log'

rc=$(EB_ENVIRONMENT_NAME=$PROD run set LEAD_MAGNET_EXECUTE_DISABLED=true)
check "refuses the production environment (set)" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]] && grep -q "production" ${WORKDIR}/out'

rc=$(EB_ENVIRONMENT_NAME=$PROD run restore LEAD_MAGNET_EXECUTE_DISABLED)
check "refuses the production environment (restore)" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=$PROD EB_APPLICATION_NAME=agentweb-backend run show)
check "refuses the production environment (show)" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=$PROD EB_STAGING_ENVIRONMENT_NAME=$PROD STAGING_ENVIRONMENT_NAME=$PROD PRODUCTION_ENVIRONMENT_NAME=other run set LEAD_MAGNET_EXECUTE_DISABLED=true)
check "refuses production whatever else is passed" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=Agentweb-backend-env-2 run set LEAD_MAGNET_EXECUTE_DISABLED=true)
check "refuses an unknown environment name" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=Agentweb-backend-env-2 STAGING_ENVIRONMENT_NAME=Agentweb-backend-env-2 EB_STAGING_ENVIRONMENT_NAME=Agentweb-backend-env-2 run set LEAD_MAGNET_EXECUTE_DISABLED=true)
check "a caller cannot rename staging through the environment" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=backend-staging run set LEAD_MAGNET_EXECUTE_DISABLED=true)
check "refuses a name that merely contains staging" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=Agentweb-backend-env-prod-3-staging run set LEAD_MAGNET_EXECUTE_DISABLED=true)
check "refuses a production-like name that contains staging" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=agentweb-backend-env-1 run set LEAD_MAGNET_EXECUTE_DISABLED=true)
check "refuses a different-case spelling of staging" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME="${STAGING}x" run set LEAD_MAGNET_EXECUTE_DISABLED=true)
check "refuses a name that only starts with the staging name" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME='' run set LEAD_MAGNET_EXECUTE_DISABLED=true)
check "refuses an empty environment name" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(env -u EB_ENVIRONMENT_NAME bash -c "$(declare -f run); WORKDIR='$WORKDIR' FAKE='$FAKE' SCRIPT='$SCRIPT' run set LEAD_MAGNET_EXECUTE_DISABLED=true")
check "refuses an unset environment name" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

# --- ENG-3087: both Elastic Beanstalk environments live in us-west-2 ---

rc=$(env -u AWS_REGION EB_ENVIRONMENT_NAME=$STAGING EB_APPLICATION_NAME=agentweb-backend bash -c "$(declare -f run); WORKDIR='$WORKDIR' FAKE='$FAKE' SCRIPT='$SCRIPT' run show")
check "show defaults to us-west-2 and names staging" '[[ $rc == 0 ]] && grep -q "describe-configuration-settings --region us-west-2 --application-name agentweb-backend --environment-name Agentweb-backend-env-1 " ${WORKDIR}/log'

rc=$(AWS_REGION=eu-west-1 EB_ENVIRONMENT_NAME=$STAGING EB_APPLICATION_NAME=agentweb-backend run show)
check "an explicit AWS_REGION still wins" '[[ $rc == 0 ]] && grep -q -- "--region eu-west-1 " ${WORKDIR}/log'

# --- ENG-2359: key allowlist and the EB calls ---

rc=$(EB_ENVIRONMENT_NAME=$STAGING run set OPENAI_API_KEY=x)
check "refuses non-allowlisted key" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=$STAGING run restore DATABASE_URL)
check "refuses non-allowlisted restore" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=$STAGING run set LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY=1,2)
check "refuses comma values" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

rc=$(EB_ENVIRONMENT_NAME=$STAGING run set LEAD_MAGNET_EXECUTE_DISABLED=true LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY=1)
check "set issues one update-environment with both options" '[[ $rc == 0 ]] && grep -q "update-environment .*--environment-name Agentweb-backend-env-1 --option-settings Namespace=aws:elasticbeanstalk:application:environment,OptionName=LEAD_MAGNET_EXECUTE_DISABLED,Value=true Namespace=aws:elasticbeanstalk:application:environment,OptionName=LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY,Value=1\$" ${WORKDIR}/log'
check "set waits for Ready before and after" '[[ $(grep -c describe-environments ${WORKDIR}/log) -ge 2 ]]'

rc=$(EB_ENVIRONMENT_NAME=$STAGING run restore LEAD_MAGNET_EXECUTE_DISABLED)
check "restore removes the option" '[[ $rc == 0 ]] && grep -q "update-environment .*--options-to-remove Namespace=aws:elasticbeanstalk:application:environment,OptionName=LEAD_MAGNET_EXECUTE_DISABLED$" ${WORKDIR}/log'

rc=$(EB_ENVIRONMENT_NAME=$STAGING run bogus)
check "unknown command fails" '[[ $rc == 2 && ! -s ${WORKDIR}/log ]]'

echo "${TESTS_RUN} run, ${TESTS_FAILED} failed"
[[ $TESTS_FAILED == 0 ]]
