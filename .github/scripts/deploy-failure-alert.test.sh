#!/usr/bin/env bash
#
# Tests for .github/scripts/deploy-failure-alert.sh (ENG-865).
#
# The AWS CLI, the GitHub CLI and curl are replaced with scripted mocks on PATH,
# so every branch runs for real without touching AWS, GitHub or Slack. Run with:
#
#   bash .github/scripts/deploy-failure-alert.test.sh
#
# Two things here are doing unusual work and should not be trimmed:
#
#   * The Slack mock defaults to HTTP 200. Slack answers 200 with
#     {"ok":false,"error":"invalid_auth"} for a revoked token, so a test that
#     asserted on the status code would pass while the alert went nowhere. The
#     ok:false cases below are the ones that prove AC4.
#   * A canary token is planted in the secret fixture and asserted absent from
#     the script's output, from curl's argv, and from every failure path. A
#     runtime-fetched value is NOT auto-masked by the runner, so a single stray
#     echo would publish a production bot token to a permanent run log.
#
# The last section asserts the workflow wiring in deploy.yml, because the
# trigger condition is the half of AC2 that no shell test can reach.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALERT_SCRIPT="${SCRIPT_DIR}/deploy-failure-alert.sh"
DEPLOY_WORKFLOW="${SCRIPT_DIR}/../workflows/deploy.yml"

# Planted in the secret fixture. If this string reaches the log, argv, or any
# error message, the equivalent real token would already be burned.
CANARY_TOKEN='xoxb-CANARY-NEVER-LOG-000000000000'
CANARY_CHANNEL='C08TM4QPZAS'

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

# ---------------------------------------------------------------------------
# Mocks
# ---------------------------------------------------------------------------

install_mock_aws() {
  mkdir -p "${WORKDIR}/bin"
  cat >"${WORKDIR}/bin/aws" <<'MOCK'
#!/usr/bin/env bash
# Scripted stand-in for the AWS CLI. Fixtures live in $ALERT_MOCK_DIR:
#   secret_string   the SecretString the CLI prints (omit the file for "None")
#   secret_exit     "<exit>|<stderr message>" to simulate an API/IAM failure
MOCK_DIR="${ALERT_MOCK_DIR:?ALERT_MOCK_DIR must be set}"

operation="${2:-}"

case "$operation" in
  get-secret-value)
    if [ -f "${MOCK_DIR}/secret_exit" ]; then
      line=$(cat "${MOCK_DIR}/secret_exit")
      code="${line%%|*}"
      msg="${line#*|}"
      [ -n "$msg" ] && printf '%s\n' "$msg" >&2
      exit "$code"
    fi
    if [ -f "${MOCK_DIR}/secret_string" ]; then
      cat "${MOCK_DIR}/secret_string"
    else
      printf 'None\n'
    fi
    exit 0
    ;;

  *)
    printf 'mock aws: unhandled operation %s\n' "$operation" >&2
    exit 64
    ;;
esac
MOCK
  chmod +x "${WORKDIR}/bin/aws"
}

install_mock_gh() {
  mkdir -p "${WORKDIR}/bin"
  cat >"${WORKDIR}/bin/gh" <<'MOCK'
#!/usr/bin/env bash
# Scripted stand-in for the GitHub CLI. Fixtures live in $ALERT_MOCK_DIR:
#   gh_jobs.json          response for .../jobs
#   gh_annotations.json   response for .../annotations
#   gh_jobs_exit          non-zero to simulate a jobs-API failure
#   gh_annotations_exit   non-zero to simulate an annotations-API failure
MOCK_DIR="${ALERT_MOCK_DIR:?ALERT_MOCK_DIR must be set}"

path="${2:-}"

case "$path" in
  *annotations*)
    if [ -f "${MOCK_DIR}/gh_annotations_exit" ]; then
      printf 'gh: mock annotations failure (HTTP 403)\n' >&2
      exit "$(cat "${MOCK_DIR}/gh_annotations_exit")"
    fi
    # Per-job fixture wins when present, so a test can give one failed job an
    # EB_DEPLOY_FAILED annotation and another none. Without this every job
    # returns the same annotations and multi-job behaviour is untestable.
    job_id="${path##*/check-runs/}"; job_id="${job_id%%/*}"
    if [ -f "${MOCK_DIR}/gh_annotations_${job_id}.json" ]; then
      cat "${MOCK_DIR}/gh_annotations_${job_id}.json"
      exit 0
    fi
    if [ -f "${MOCK_DIR}/gh_annotations.json" ]; then
      cat "${MOCK_DIR}/gh_annotations.json"
    else
      printf '[]\n'
    fi
    exit 0
    ;;

  *jobs*)
    if [ -f "${MOCK_DIR}/gh_jobs_exit" ]; then
      printf 'gh: mock jobs failure (HTTP 403 Resource not accessible by integration)\n' >&2
      exit "$(cat "${MOCK_DIR}/gh_jobs_exit")"
    fi
    if [ -f "${MOCK_DIR}/gh_jobs.json" ]; then
      cat "${MOCK_DIR}/gh_jobs.json"
    else
      printf '{"jobs":[]}\n'
    fi
    exit 0
    ;;

  *)
    printf 'mock gh: unhandled path %s\n' "$path" >&2
    exit 64
    ;;
esac
MOCK
  chmod +x "${WORKDIR}/bin/gh"
}

install_mock_curl() {
  mkdir -p "${WORKDIR}/bin"
  cat >"${WORKDIR}/bin/curl" <<'MOCK'
#!/usr/bin/env bash
# Scripted stand-in for curl. Records what it was asked to do so the tests can
# prove the token stayed out of argv. Fixtures live in $ALERT_MOCK_DIR:
#   slack_response     body written to the --output file (default ok:true)
#   slack_http_code    value returned for --write-out '%{http_code}'
#   curl_exit          non-zero to simulate a network/timeout failure
# Records written back into $ALERT_MOCK_DIR:
#   curl_argv          every argument curl was invoked with
#   curl_config        the config file contents (where the header really goes)
#   payload_seen.json  the JSON body that would have been sent
MOCK_DIR="${ALERT_MOCK_DIR:?ALERT_MOCK_DIR must be set}"

printf '%s\n' "$*" >>"${MOCK_DIR}/curl_argv"

out_file=''
cfg_file=''
prev=''
for arg in "$@"; do
  case "$prev" in
    --output) out_file="$arg" ;;
    --config) cfg_file="$arg" ;;
  esac
  prev="$arg"
done

if [ -n "$cfg_file" ] && [ -f "$cfg_file" ]; then
  cat "$cfg_file" >>"${MOCK_DIR}/curl_config"
  data_ref=$(sed -n 's/^data = @//p' "$cfg_file" | head -n 1)
  if [ -n "$data_ref" ] && [ -f "$data_ref" ]; then
    cp "$data_ref" "${MOCK_DIR}/payload_seen.json"
  fi
fi

if [ -f "${MOCK_DIR}/curl_exit" ]; then
  printf 'curl: (28) Operation timed out after 20000 milliseconds\n' >&2
  exit "$(cat "${MOCK_DIR}/curl_exit")"
fi

if [ -n "$out_file" ]; then
  if [ -f "${MOCK_DIR}/slack_response" ]; then
    cat "${MOCK_DIR}/slack_response" >"$out_file"
  else
    printf '{"ok":true,"channel":"C08TM4QPZAS","ts":"1754200000.000100"}\n' >"$out_file"
  fi
fi

if [ -f "${MOCK_DIR}/slack_http_code" ]; then
  printf '%s' "$(cat "${MOCK_DIR}/slack_http_code")"
else
  printf '200'
fi
exit 0
MOCK
  chmod +x "${WORKDIR}/bin/curl"
}

# ---------------------------------------------------------------------------
# Fixture + assertion helpers
# ---------------------------------------------------------------------------

# The real annotation from the 2026-08-01 outage (run 30690549689), verbatim.
# `Process completed with exit code 1.` really is annotation[0] there, which is
# why the script matches on the EB_DEPLOY_FAILED prefix rather than an index.
REAL_EB_REASON="environment 'Agentweb-backend-env-prod-3' did not come up Ready on version 'backend-20260801-pr2237' within the overall deploy budget of 2700s. Last observed Status=Ready Health=Green Version=backend-20260731-pr2226."

new_mock_dir() {
  local dir
  dir="$(mktemp -d "${WORKDIR}/mock.XXXXXX")"

  printf '{"botToken":"%s","deployAlertChannel":"%s","deployAlertChannelName":"#team-chat"}\n' \
    "${CANARY_TOKEN}" "${CANARY_CHANNEL}" >"${dir}/secret_string"

  cat >"${dir}/gh_jobs.json" <<JOBS
{
  "total_count": 3,
  "jobs": [
    {"id": 91344410451, "name": "Detect changed projects", "conclusion": "success", "steps": []},
    {"id": 91344410453, "name": "Backend deploy to production", "conclusion": "failure",
     "steps": [
       {"name": "Checkout", "conclusion": "success"},
       {"name": "Deploy to Elastic Beanstalk and verify the environment took it", "conclusion": "failure"}
     ]},
    {"id": 91344410455, "name": "Partner portal deploy to production", "conclusion": "skipped", "steps": []}
  ]
}
JOBS

  jq -n --arg reason "EB_DEPLOY_FAILED: ${REAL_EB_REASON}" \
    '[{"level":"failure","message":"Process completed with exit code 1."},
      {"level":"failure","message":$reason}]' >"${dir}/gh_annotations.json"

  printf '%s' "${dir}"
}

set_secret_string() { printf '%s\n' "$2" >"$1/secret_string"; }
set_slack_response() { printf '%s\n' "$2" >"$1/slack_response"; }
set_fixture() { printf '%s' "$3" >"$1/$2"; }
drop_fixture() { rm -f "$1/$2"; }

# run_alert <mock_dir> [extra env assignments...]
run_alert() {
  local dir="$1"
  shift
  set +e
  env \
    PATH="${WORKDIR}/bin:${PATH}" \
    ALERT_MOCK_DIR="${dir}" \
    SLACK_SECRET_ID='prod/AgentWeb/Slack' \
    GH_TOKEN='gh-mock-token' \
    REPO='AgentWebPro/agentweb' \
    RUN_ID='30690549689' \
    RUN_ATTEMPT='1' \
    RUN_URL='https://github.com/AgentWebPro/agentweb/actions/runs/30690549689/attempts/1' \
    COMMIT_SHA='6f10a3dfed6f3de9e0bf702a7add0995bc12bee7' \
    COMMIT_SUBJECT='Merge pull request #2237 from AgentWebPro/swarm/eng-818-timeout-ordering' \
    DEPLOY_ACTOR='harshmoney123' \
    DETECT_RESULT='success' \
    BACKEND_RESULT='failure' \
    PARTNER_RESULT='skipped' \
    "$@" \
    bash "${ALERT_SCRIPT}" >"${WORKDIR}/out.txt" 2>&1
  LAST_EXIT=$?
  set -e
  LAST_OUTPUT="$(cat "${WORKDIR}/out.txt")"
  LAST_MOCK_DIR="${dir}"
}

pass() { printf '  ok   %s\n' "$1"; }

record_fail() {
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
  printf '  FAIL %s\n' "$1"
  shift
  printf '       %s\n' "$@"
}

check() {
  # check <description> <expected_exit> <expected substring>
  local desc="$1" expected_exit="$2" needle="$3"
  TESTS_RUN=$(( TESTS_RUN + 1 ))

  if [ "${LAST_EXIT}" -ne "${expected_exit}" ]; then
    printf '  FAIL %s\n       expected exit %s, got %s\n       output:\n%s\n' \
      "${desc}" "${expected_exit}" "${LAST_EXIT}" "${LAST_OUTPUT}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    return
  fi

  # ENG-1277: a here-string, not a pipe — see grep_effective's comment below
  # for the SIGPIPE-under-pipefail race this avoids.
  if [ -n "${needle}" ] && ! grep -qF "${needle}" <<<"${LAST_OUTPUT}"; then
    printf '  FAIL %s\n       output did not contain: %s\n       output:\n%s\n' \
      "${desc}" "${needle}" "${LAST_OUTPUT}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    return
  fi

  pass "${desc}"
}

# check_posted <description> <expected substring of the Slack message text>
check_posted() {
  local desc="$1" needle="$2" text
  TESTS_RUN=$(( TESTS_RUN + 1 ))

  if [ ! -f "${LAST_MOCK_DIR}/payload_seen.json" ]; then
    record_fail "${desc}" 'no Slack payload was sent at all' "output:" "${LAST_OUTPUT}"
    return
  fi

  text="$(jq -r '.text' "${LAST_MOCK_DIR}/payload_seen.json")"
  # ENG-1277: here-string, same reason as check() above.
  if ! grep -qF "${needle}" <<<"${text}"; then
    record_fail "${desc}" "the Slack message did not contain: ${needle}" "message was:" "${text}"
    return
  fi

  pass "${desc}"
}

check_nothing_posted() {
  local desc="$1"
  TESTS_RUN=$(( TESTS_RUN + 1 ))
  if [ -f "${LAST_MOCK_DIR}/payload_seen.json" ] || [ -f "${LAST_MOCK_DIR}/curl_argv" ]; then
    record_fail "${desc}" 'a Slack request was made when none should have been'
    return
  fi
  pass "${desc}"
}

# check_no_canary <description> — the token must not appear in anything the
# script emitted, other than the single ::add-mask:: line that registers it.
check_no_canary() {
  local desc="$1" leaked
  TESTS_RUN=$(( TESTS_RUN + 1 ))

  leaked="$(grep -F "${CANARY_TOKEN}" "${WORKDIR}/out.txt" 2>/dev/null | grep -vF '::add-mask::' || true)"
  if [ -n "${leaked}" ]; then
    record_fail "${desc}" 'the bot token appeared in the output on these lines:' "${leaked}"
    return
  fi

  if [ -f "${LAST_MOCK_DIR}/curl_argv" ] && grep -qF "${CANARY_TOKEN}" "${LAST_MOCK_DIR}/curl_argv"; then
    record_fail "${desc}" 'the bot token was passed to curl in argv (world-readable via /proc)'
    return
  fi

  pass "${desc}"
}

# Matches only lines that DO something. Every file here documents the rules it
# obeys, so a naive grep for `continue-on-error` or `set -x` finds the sentence
# forbidding it and reports the opposite of the truth.
grep_effective() {
  # grep_effective <file...> -- <pattern>
  local pattern="${*: -1}" files=( "${@:1:$#-1}" )
  # NOT `grep -q`: with `set -o pipefail`, grep exiting early on the first
  # match can SIGPIPE the upstream sed, and the pipeline then reports the
  # sed's 141 instead of grep's 0 — a TRUE match read as a miss. It is a race,
  # so it passes locally on a small file and fails on CI. Plain grep reads its
  # input to EOF, so the upstream never sees a closed pipe.
  sed -e 's/^[[:space:]]*#.*$//' "${files[@]}" | grep -E "${pattern}" >/dev/null
}

# check_workflow <description> <grep -E pattern> <expected: present|absent>
check_workflow() {
  local desc="$1" pattern="$2" expectation="$3"
  TESTS_RUN=$(( TESTS_RUN + 1 ))

  if grep_effective "${DEPLOY_WORKFLOW}" "${pattern}"; then
    if [ "${expectation}" = 'present' ]; then
      pass "${desc}"
    else
      record_fail "${desc}" "deploy.yml unexpectedly matches: ${pattern}"
    fi
    return
  fi

  if [ "${expectation}" = 'absent' ]; then
    pass "${desc}"
  else
    record_fail "${desc}" "deploy.yml does not match: ${pattern}"
  fi
}

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

install_mock_aws
install_mock_gh
install_mock_curl

printf 'deploy-failure-alert.sh\n'

# AC1 — the 2026-08-01 outage, reproduced end to end: a failed backend deploy
# posts one message carrying the run URL, the commit, and the exact reason
# eb-deploy.sh classified.
M=$(new_mock_dir)
run_alert "$M"
check 'AC1: a failed backend deploy exits 0 after Slack confirms delivery' 0 \
  'Deploy-failure alert delivered to channel C08TM4QPZAS'
check_posted 'AC1: the alert carries the run URL' \
  'https://github.com/AgentWebPro/agentweb/actions/runs/30690549689/attempts/1'
check_posted 'AC1: the alert carries the commit' '6f10a3d'
check_posted 'AC1: the alert carries the commit subject' 'Merge pull request #2237'
check_posted 'AC1: the alert carries the classified EB_DEPLOY_FAILED reason' \
  'did not come up Ready on version'
check_posted 'AC1: the reason keeps the observed state EB reported' \
  'Version=backend-20260731-pr2226'
check_posted 'AC1: the alert names which job failed' \
  'Backend deploy to production: failure'
check_posted 'AC1: the alert says the commit is not necessarily live' \
  'Do not assume this commit is live'
check_no_canary 'AC1: the bot token never reaches the log or argv'

# AC1 — the channel is read from the secret. Changing the secret moves the
# alert; the bot has no channels:join scope, so a hardcoded channel would be a
# code change away from posting nowhere.
TESTS_RUN=$(( TESTS_RUN + 1 ))
if [ "$(jq -r '.channel' "${M}/payload_seen.json")" = "${CANARY_CHANNEL}" ]; then
  pass 'AC1: the destination channel comes from the secret'
else
  record_fail 'AC1: the destination channel comes from the secret' \
    "channel was $(jq -r '.channel' "${M}/payload_seen.json")"
fi

M=$(new_mock_dir)
set_secret_string "$M" "{\"botToken\":\"${CANARY_TOKEN}\",\"deployAlertChannel\":\"C0AL81T5FAM\"}"
run_alert "$M"
check 'AC1: a different channel in the secret is honoured without a code change' 0 \
  'delivered to channel C0AL81T5FAM'

# AC1 — the Authorization header travels in curl's config file, never in argv.
TESTS_RUN=$(( TESTS_RUN + 1 ))
if grep -qF "Authorization: Bearer ${CANARY_TOKEN}" "${M}/curl_config"; then
  pass 'AC1: the Authorization header is passed through curl --config, not argv'
else
  record_fail 'AC1: the Authorization header is passed through curl --config, not argv' \
    'the config file did not carry the header'
fi

# AC1 — a cancelled deploy job is a failed deploy too (a step-level
# `if: failure()` would miss this one entirely).
M=$(new_mock_dir)
run_alert "$M" BACKEND_RESULT='cancelled'
check 'AC1: a cancelled backend deploy still alerts' 0 'alert delivered'
check_posted 'AC1: the alert names the cancellation' \
  'Backend deploy to production: cancelled'

# AC1 — a partner-portal failure alerts on the same path.
M=$(new_mock_dir)
run_alert "$M" BACKEND_RESULT='skipped' PARTNER_RESULT='failure'
check 'AC1: a failed partner deploy alerts' 0 'alert delivered'
check_posted 'AC1: the alert names the partner job' \
  'Partner portal deploy to production: failure'

# AC1 — a run that dies before any deploy job starts is still a production
# deploy that did not happen.
M=$(new_mock_dir)
run_alert "$M" DETECT_RESULT='failure' BACKEND_RESULT='skipped' PARTNER_RESULT='skipped'
check 'AC1: a failed detect-changes job alerts' 0 'alert delivered'
check_posted 'AC1: the alert names the detect job' 'Detect changed projects: failure'

# AC1 — a failure BEFORE eb-deploy.sh runs (npm ci, Build, zip, S3 upload) has
# no EB_DEPLOY_FAILED annotation. The alert must still post, naming the step,
# rather than sending an empty Reason line.
M=$(new_mock_dir)
jq -n '[{"level":"failure","message":"Process completed with exit code 1."}]' >"$M/gh_annotations.json"
jq '.jobs[1].steps = [{"name":"Install dependencies","conclusion":"failure"}]' \
  "$M/gh_jobs.json" >"$M/gh_jobs.tmp" && mv "$M/gh_jobs.tmp" "$M/gh_jobs.json"
run_alert "$M"
check 'AC1: a pre-eb-deploy failure still posts' 0 'alert delivered'
check_posted 'AC1: it names the step that actually failed' \
  "failure at step 'Install dependencies'"
check_posted 'AC1: and says plainly why there is no classified reason' \
  'before or outside eb-deploy.sh'

# AC1 — a job killed outright (runner death, job-level timeout) records no
# failed step either. Still posts, still says what it knows.
M=$(new_mock_dir)
jq -n '[]' >"$M/gh_annotations.json"
jq '.jobs[1].steps = []' "$M/gh_jobs.json" >"$M/gh_jobs.tmp" && mv "$M/gh_jobs.tmp" "$M/gh_jobs.json"
run_alert "$M"
check 'AC1: a job with no failed step recorded still posts' 0 'alert delivered'
check_posted 'AC1: it says the job was likely killed rather than inventing a reason' \
  'most likely killed by the runner'

# AC1 — the reason lookup is enrichment, never the trigger. A 403 on the jobs
# API must degrade the message, not suppress the alert: no alert is a far worse
# outcome than a thinner one.
M=$(new_mock_dir)
set_fixture "$M" 'gh_jobs_exit' '1'
run_alert "$M"
check 'AC1: an unreadable jobs API still delivers the alert' 0 'alert delivered'
check_posted 'AC1: and states the reason is unavailable instead of leaving it blank' \
  "could not list the run's jobs"

M=$(new_mock_dir)
set_fixture "$M" 'gh_annotations_exit' '1'
run_alert "$M"
check 'AC1: an unreadable annotations API still delivers the alert' 0 'alert delivered'
check_posted 'AC1: falling back to the failed step name' \
  "at step 'Deploy to Elastic Beanstalk"

M=$(new_mock_dir)
run_alert "$M" GH_TOKEN=''
check 'AC1: a missing GH_TOKEN degrades the reason but still delivers' 0 'alert delivered'
check_posted 'AC1: and says so' 'GH_TOKEN is not set'

# github.event.head_commit is null on a workflow_dispatch run, so COMMIT_SUBJECT
# arrives empty. The alert must still go out with a readable Commit line.
M=$(new_mock_dir)
run_alert "$M" COMMIT_SUBJECT=''
check 'AC1: a manual (workflow_dispatch) run has no commit subject and still alerts' 0 \
  'alert delivered'
check_posted 'AC1: the empty subject is labelled rather than left blank' \
  "\`6f10a3d\` (no commit subject"

# A merge commit message is multi-line. Slack alerts are one message, not a
# wall, and eb-deploy.sh reasons can carry embedded AWS text too.
M=$(new_mock_dir)
run_alert "$M" COMMIT_SUBJECT='Merge pull request #2237 from AgentWebPro/swarm/eng-818

fix(infra): stagger agent-mode timeout layers (ENG-818)'
check 'AC1: a multi-line commit message still delivers' 0 'alert delivered'
check_posted 'AC1: only the commit subject line is used' 'Merge pull request #2237'
TESTS_RUN=$(( TESTS_RUN + 1 ))
# ENG-1277: plain grep (no -q) redirected to /dev/null, not `grep -q` — same
# SIGPIPE-under-pipefail race as grep_effective() above, this time against
# jq's output rather than sed's. Plain grep reads its input to EOF instead of
# closing early on the first match, so jq never sees a closed pipe.
if jq -r '.text' "${M}/payload_seen.json" | grep -F 'stagger agent-mode timeout layers' >/dev/null; then
  record_fail 'AC1: the commit body is not pasted into the alert' \
    'the full multi-line commit message leaked into the Slack text'
else
  pass 'AC1: the commit body is not pasted into the alert'
fi

# ---------------------------------------------------------------------------
# AC2 — silence is the feature
# ---------------------------------------------------------------------------

printf '\nAC2 (a successful or skipped deploy must post nothing)\n'

# The common case on any merge touching neither backend/** nor partner-portal/**
# — run 30823838490 today. Both deploy jobs skipped, run conclusion success.
M=$(new_mock_dir)
run_alert "$M" DETECT_RESULT='success' BACKEND_RESULT='skipped' PARTNER_RESULT='skipped'
check 'AC2: an all-skipped run (path filter) refuses to post' 1 \
  'refusing to post a deploy-failure alert'
check_nothing_posted 'AC2: and no Slack request is made at all'

M=$(new_mock_dir)
run_alert "$M" DETECT_RESULT='success' BACKEND_RESULT='success' PARTNER_RESULT='success'
check 'AC2: a fully successful deploy posts nothing' 1 \
  'refusing to post a deploy-failure alert'
check_nothing_posted 'AC2: no Slack request on a successful deploy'
check 'AC2: and it is loud, because reaching here means the wiring is wrong' 1 \
  'the workflow condition or the env wiring is wrong'

M=$(new_mock_dir)
run_alert "$M" DETECT_RESULT='success' BACKEND_RESULT='success' PARTNER_RESULT='skipped'
check 'AC2: backend success + partner skipped posts nothing' 1 'refusing to post'
check_nothing_posted 'AC2: no Slack request on backend success + partner skipped'

# ---------------------------------------------------------------------------
# AC4 — a broken alerting path must be loud, never silent
# ---------------------------------------------------------------------------

printf '\nAC4 (missing/malformed secret and Slack ok:false must fail the step)\n'

# THE case. Slack answers HTTP 200 with ok:false for a revoked token, so a check
# on the status code alone would pass while the alert went nowhere. The mock
# returns 200 here deliberately.
M=$(new_mock_dir)
set_slack_response "$M" '{"ok":false,"error":"invalid_auth"}'
run_alert "$M"
check 'AC4: Slack ok:false fails the step even on HTTP 200' 1 \
  'REJECTED the message: ok=false'
check 'AC4: the failure names Slack own error code' 1 "error='invalid_auth'"
check 'AC4: the failure states the alert was NOT delivered' 1 \
  'was NOT delivered to channel'
check 'AC4: and it says the HTTP status was 200, so nobody re-adds a status check' 1 \
  'HTTP 200'
check_no_canary 'AC4: the token is not leaked on the Slack-rejection path'

M=$(new_mock_dir)
set_slack_response "$M" '{"ok":false,"error":"not_in_channel"}'
run_alert "$M"
check 'AC4: not_in_channel fails the step' 1 "error='not_in_channel'"
check 'AC4: and points at the missing channels:join scope' 1 'no channels:join scope'

M=$(new_mock_dir)
set_slack_response "$M" '{"ok":false,"error":"channel_not_found"}'
run_alert "$M"
check 'AC4: channel_not_found fails the step' 1 "error='channel_not_found'"

# The secret itself.
M=$(new_mock_dir)
set_fixture "$M" 'secret_exit' "255|An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret."
run_alert "$M"
check 'AC4: a missing secret fails the step' 1 \
  "could not read the Slack alert secret 'prod/AgentWeb/Slack'"
check 'AC4: the AWS error text is surfaced, not swallowed' 1 'ResourceNotFoundException'
check_nothing_posted 'AC4: nothing is posted when the secret cannot be read'

M=$(new_mock_dir)
set_fixture "$M" 'secret_exit' '255|An error occurred (AccessDeniedException) when calling the GetSecretValue operation: not authorized'
run_alert "$M"
check 'AC4: an IAM denial on the secret fails the step' 1 'AccessDeniedException'

M=$(new_mock_dir)
drop_fixture "$M" 'secret_string'
run_alert "$M"
check 'AC4: a secret with no SecretString (CLI prints None) fails the step' 1 \
  'has no SecretString'

M=$(new_mock_dir)
set_secret_string "$M" ''
run_alert "$M"
check 'AC4: an empty SecretString fails the step' 1 'returned an empty SecretString'

M=$(new_mock_dir)
set_secret_string "$M" 'botToken=xoxb-not-json'
run_alert "$M"
check 'AC4: a malformed (non-JSON) secret fails the step' 1 'is not a JSON object'

M=$(new_mock_dir)
set_secret_string "$M" '["not","an","object"]'
run_alert "$M"
check 'AC4: a JSON array is not an acceptable secret shape' 1 'is not a JSON object'

M=$(new_mock_dir)
set_secret_string "$M" '{"deployAlertChannel":"C08TM4QPZAS"}'
run_alert "$M"
check 'AC4: a secret with no botToken fails the step' 1 "has no non-empty 'botToken'"
check_nothing_posted 'AC4: nothing is posted without a token'

M=$(new_mock_dir)
set_secret_string "$M" "{\"botToken\":\"${CANARY_TOKEN}\"}"
run_alert "$M"
check 'AC4: a secret with no deployAlertChannel fails the step' 1 \
  "has no non-empty 'deployAlertChannel'"
check 'AC4: there is no hardcoded fallback channel to quietly post nowhere' 1 \
  'no hardcoded fallback'
check_nothing_posted 'AC4: nothing is posted without a channel'
check_no_canary 'AC4: the token is not leaked on the missing-channel path'

M=$(new_mock_dir)
set_secret_string "$M" "{\"botToken\":\"${CANARY_TOKEN}\",\"deployAlertChannel\":\"\"}"
run_alert "$M"
check 'AC4: an empty deployAlertChannel is not silently defaulted' 1 \
  "has no non-empty 'deployAlertChannel'"

# The wire.
M=$(new_mock_dir)
set_fixture "$M" 'curl_exit' '28'
run_alert "$M"
check 'AC4: a curl network failure fails the step' 1 \
  'failed at the network level (curl exit 28)'
check_no_canary 'AC4: the token is not leaked on the network-failure path'

M=$(new_mock_dir)
set_slack_response "$M" '<html>502 Bad Gateway</html>'
set_fixture "$M" 'slack_http_code' '502'
run_alert "$M"
check 'AC4: a non-JSON Slack response fails the step' 1 \
  'answered HTTP 502 with a body that is not a JSON object'

M=$(new_mock_dir)
set_slack_response "$M" ''
run_alert "$M"
check 'AC4: an empty Slack response body fails the step' 1 'delivery cannot be confirmed'

# Misconfiguration fails closed rather than posting a half-formed alert.
M=$(new_mock_dir)
run_alert "$M" REPO=''
check 'AC4: an empty required variable fails closed' 1 'REPO is empty or unset'

M=$(new_mock_dir)
run_alert "$M" RUN_ID=''
check 'AC4: a missing RUN_ID fails closed' 1 'RUN_ID is empty or unset'

# ---------------------------------------------------------------------------
# Secret hygiene
# ---------------------------------------------------------------------------

printf '\nsecret hygiene (a runtime-fetched token is NOT auto-masked)\n'

# The mask line is guarded on GITHUB_ACTIONS: outside the runner it is not a
# workflow command, just a plaintext print of a production token. So the
# in-Actions path is exercised explicitly here, and the outside-Actions path is
# asserted separately below.
M=$(new_mock_dir)
run_alert "$M" GITHUB_ACTIONS='true'

# `run_alert` restores `set -e`, so a bare grep that legitimately finds nothing
# would kill this suite instead of reporting a FAIL — and the case where it
# finds nothing is exactly the case these three checks exist to catch. Every
# match below is therefore taken inside an `if`.
line_number_of() {
  # line_number_of <fixed pattern> <file> — empty when there is no match.
  if grep -nF "$1" "$2" >"${WORKDIR}/match.txt"; then
    head -n 1 "${WORKDIR}/match.txt" | cut -d: -f1
  fi
}

TESTS_RUN=$(( TESTS_RUN + 1 ))
MASK_LINES=0
if grep -F '::add-mask::' "${WORKDIR}/out.txt" >"${WORKDIR}/mask-lines.txt"; then
  MASK_LINES="$(tr -cd '\n' <"${WORKDIR}/mask-lines.txt" | wc -c | tr -d ' ')"
fi
if [ "${MASK_LINES}" = '1' ]; then
  pass 'the token is registered with ::add-mask:: exactly once'
else
  record_fail 'the token is registered with ::add-mask:: exactly once' \
    "found ${MASK_LINES} ::add-mask:: lines"
fi

TESTS_RUN=$(( TESTS_RUN + 1 ))
if grep -qF "::add-mask::${CANARY_TOKEN}" "${WORKDIR}/out.txt"; then
  pass 'the mask registers the token itself, not a transformed form'
else
  record_fail 'the mask registers the token itself, not a transformed form' \
    'no ::add-mask:: line carried the token'
fi

# Masking after the fact is worthless: the runner only redacts text emitted
# AFTER the mask is registered.
TESTS_RUN=$(( TESTS_RUN + 1 ))
FIRST_TOKEN_LINE="$(line_number_of "${CANARY_TOKEN}" "${WORKDIR}/out.txt")"
FIRST_MASK_LINE="$(line_number_of '::add-mask::' "${WORKDIR}/out.txt")"
if [ -n "${FIRST_MASK_LINE}" ] && [ "${FIRST_TOKEN_LINE}" = "${FIRST_MASK_LINE}" ]; then
  pass 'the mask is registered before anything else can print the token'
else
  record_fail 'the mask is registered before anything else can print the token' \
    "first token line ${FIRST_TOKEN_LINE:-none}, first mask line ${FIRST_MASK_LINE:-none}"
fi

check_no_canary 'the token appears nowhere except the ::add-mask:: line'

# Regression guard for a confirmed leak found by adversarial review: the
# ::add-mask:: printf was unconditional. Inside Actions the runner consumes the
# workflow command and nothing is rendered — but OUTSIDE Actions it is simply a
# plaintext print of a production bot token to stdout. That path is not
# hypothetical: this script's own header documents a by-hand rehearsal, and the
# test suite itself runs outside Actions. Reproduced with a canary before the
# fix; this pins it.
M=$(new_mock_dir)
# GITHUB_ACTIONS pinned EMPTY, not merely left unset: this suite itself runs
# inside GitHub Actions, where the variable is already `true` in the ambient
# environment. Relying on it being absent passed locally and failed in CI —
# the test was asserting a property of my laptop, not of the script.
run_alert "$M" GITHUB_ACTIONS=''
TESTS_RUN=$(( TESTS_RUN + 1 ))
if grep -qF "${CANARY_TOKEN}" "${WORKDIR}/out.txt"; then
  record_fail 'outside GitHub Actions the token is never printed at all' \
    'the canary token appeared in stdout when GITHUB_ACTIONS was unset'
else
  pass 'outside GitHub Actions the token is never printed at all'
fi

TESTS_RUN=$(( TESTS_RUN + 1 ))
if grep -qF '::add-mask::' "${WORKDIR}/out.txt"; then
  record_fail 'no ::add-mask:: workflow command is emitted outside Actions' \
    'emitted ::add-mask:: with GITHUB_ACTIONS unset, where it is not a command'
else
  pass 'no ::add-mask:: workflow command is emitted outside Actions'
fi

# redact() must not fork. `sed "s|$TOKEN|***|g"` would place the token in a
# child process argv, world-readable via /proc and `ps` — on the happy path,
# since every alert redacts its reason. Parameter expansion runs in-process.
TESTS_RUN=$(( TESTS_RUN + 1 ))
REDACT_BODY="$(awk '/^redact\(\)/,/^}/' "${ALERT_SCRIPT}")"
# ENG-1277: here-string, not a pipe — see grep_effective's comment above.
if grep -qE '\b(sed|awk|perl|tr|python3?)\b' <<<"${REDACT_BODY}"; then
  record_fail 'redact() never passes the token to a subprocess' \
    'redact() invokes an external command; the token would land in its argv'
else
  pass 'redact() never passes the token to a subprocess'
fi

# The script must never be run under xtrace: it would print the expanded
# assignment, the argv, AND the ::add-mask:: call itself, leaking the token to a
# permanent run log before the mask exists.
check_workflow 'the workflow never invokes the alert under bash -x' \
  'deploy-failure-alert\.sh' 'present'
TESTS_RUN=$(( TESTS_RUN + 1 ))
if grep_effective "${ALERT_SCRIPT}" "${DEPLOY_WORKFLOW}" 'bash +-x|set +-x|bash *-x *\{0\}'; then
  record_fail 'neither the script nor the workflow enables xtrace' \
    'found an xtrace invocation — this leaks the token'
else
  pass 'neither the script nor the workflow enables xtrace'
fi

# A masked value written to $GITHUB_OUTPUT is silently dropped by the runner,
# which would leave this alert looking configured and being dead.
TESTS_RUN=$(( TESTS_RUN + 1 ))
if grep_effective "${ALERT_SCRIPT}" 'GITHUB_OUTPUT|GITHUB_ENV'; then
  record_fail 'the token never crosses a step boundary' \
    'the script writes GITHUB_OUTPUT/GITHUB_ENV — a masked value there is dropped'
else
  pass 'the token never crosses a step boundary'
fi

# ---------------------------------------------------------------------------
# Workflow wiring — the half of AC2 no shell test can reach
# ---------------------------------------------------------------------------

printf '\nworkflow wiring (deploy.yml)\n'

check_workflow 'the notify job exists' \
  '^  notify-deploy-failure:' 'present'
check_workflow 'it waits on both deploy jobs' \
  'needs: \[detect-changes, backend-deploy, partner-deploy\]' 'present'
check_workflow 'its condition is !cancelled\(\)-guarded, so a failed need cannot skip it' \
  '!cancelled\(\) &&' 'present'
check_workflow 'it fires on a failed backend deploy' \
  "needs\.backend-deploy\.result == 'failure'" 'present'
check_workflow 'it fires on a failed partner deploy' \
  "needs\.partner-deploy\.result == 'failure'" 'present'

# Cancellation is two different events wearing one word, and the gate has to
# tell them apart:
#   - a human cancels the RUN            -> !cancelled() false -> silent
#   - a deploy JOB dies on its own       -> !cancelled() true  -> ALERT
# An earlier cut excluded `cancelled` entirely, which silenced the second case:
# a real deploy that did not happen, reported as nothing. Greptile caught it.
check_workflow 'it fires on an independently cancelled backend deploy' \
  "needs\.backend-deploy\.result == 'cancelled'" 'present'
check_workflow 'it fires on an independently cancelled partner deploy' \
  "needs\.partner-deploy\.result == 'cancelled'" 'present'
check_workflow 'but a human cancelling the whole run stays silent' \
  '!cancelled\(\) &&' 'present'
# Scoped to the `if:` CONDITION, not the whole file. `DETECT_RESULT` is still
# passed to the script on purpose — it is a fail-closed guard that refuses
# loudly if the condition ever misfires — so a file-wide grep would fail on
# working code. What must be true is narrower: the GATE does not consider
# detect-changes, because that job deploys nothing.
TESTS_RUN=$(( TESTS_RUN + 1 ))
NOTIFY_IF="$(awk '
  /^  notify-deploy-failure:/ { in_job = 1 }
  in_job && /^    if: / { in_if = 1 }
  in_if { print }
  in_if && /^    runs-on:/ { exit }
' "${DEPLOY_WORKFLOW}")"
# ENG-1277: here-string, not a pipe — see grep_effective's comment above.
if grep -q 'detect-changes' <<<"${NOTIFY_IF}"; then
  record_fail 'it does NOT fire on detect-changes, which deploys nothing' \
    'the notify job if: condition references detect-changes'
else
  pass 'it does NOT fire on detect-changes, which deploys nothing'
fi
check_workflow 'AC2: it never fires on a skipped job' \
  "result == 'skipped'" 'absent'
check_workflow 'AC2: it never fires on a successful job' \
  "result == 'success'" 'absent'
check_workflow 'it runs in the prod environment, where the AWS secrets live' \
  '^    environment: prod$' 'present'
check_workflow 'it can list the run jobs and read their annotations' \
  '^      actions: read$' 'present'
check_workflow 'the Slack secret id is passed in, not guessed' \
  'SLACK_SECRET_ID: prod/AgentWeb/Slack' 'present'
check_workflow 'AC4: the notify step is not allowed to fail quietly' \
  'continue-on-error *:' 'absent'

# The bot can only post where it is already a member, so the channel has to be
# changeable without a deploy. A channel id in the workflow or the script would
# mean an outage-time fix requires a PR.
check_workflow 'the channel id is never hardcoded in the workflow' \
  'C0[A-Z0-9]{8,}' 'absent'
TESTS_RUN=$(( TESTS_RUN + 1 ))
if grep -qE 'C0[A-Z0-9]{8,}' "${ALERT_SCRIPT}"; then
  record_fail 'the channel id is never hardcoded in the script' \
    'found a literal Slack channel id'
else
  pass 'the channel id is never hardcoded in the script'
fi

# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Multi-job failure: a classified reason anywhere beats a generic fallback
# ---------------------------------------------------------------------------
#
# When BOTH deploy jobs fail and only the second carries EB_DEPLOY_FAILED, the
# loop used to break on the first job's generic fallback and discard the
# classification — throwing away the one thing the alert exists to deliver.
# Found by Greptile review on #2256.

printf '\nmulti-job failure (a classified reason must not be lost)\n'

M=$(new_mock_dir)
cat >"$M/gh_jobs.json" <<'JOBS'
{
  "total_count": 3,
  "jobs": [
    {"id": 800000001, "name": "Partner portal deploy to production", "conclusion": "failure",
     "steps": [{"name": "Build", "conclusion": "failure"}]},
    {"id": 800000002, "name": "Backend deploy to production", "conclusion": "failure",
     "steps": [{"name": "Deploy to Elastic Beanstalk and verify the environment took it", "conclusion": "failure"}]},
    {"id": 800000003, "name": "Detect changed projects", "conclusion": "success", "steps": []}
  ]
}
JOBS
# First failed job: no classification. Second: the real one.
jq -n '[{"level":"failure","message":"Process completed with exit code 1."}]' \
  >"$M/gh_annotations_800000001.json"
jq -n '[{"level":"failure","message":"EB_DEPLOY_FAILED: environment took the version but its health stayed Red for 180s."}]' \
  >"$M/gh_annotations_800000002.json"
run_alert "$M" BACKEND_RESULT='failure' PARTNER_RESULT='failure'
check_posted 'the classified reason on a later job wins over an earlier generic fallback' \
  'health stayed Red'
check_posted 'and the alert names the job that carried it' \
  'Backend deploy to production'

# The converse must still hold: with no classification anywhere, the generic
# fallback is still reported rather than the alert going out reasonless.
M=$(new_mock_dir)
cat >"$M/gh_jobs.json" <<'JOBS'
{
  "total_count": 2,
  "jobs": [
    {"id": 800000004, "name": "Partner portal deploy to production", "conclusion": "failure",
     "steps": [{"name": "Build", "conclusion": "failure"}]},
    {"id": 800000005, "name": "Backend deploy to production", "conclusion": "failure",
     "steps": [{"name": "Install dependencies", "conclusion": "failure"}]}
  ]
}
JOBS
jq -n '[{"level":"failure","message":"Process completed with exit code 1."}]' >"$M/gh_annotations_800000004.json"
jq -n '[{"level":"failure","message":"Process completed with exit code 1."}]' >"$M/gh_annotations_800000005.json"
run_alert "$M" BACKEND_RESULT='failure' PARTNER_RESULT='failure'
check_posted 'with no classification anywhere, the generic fallback is still reported' \
  'No EB_DEPLOY_FAILED annotation'

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
