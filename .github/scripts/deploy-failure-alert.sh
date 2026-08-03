#!/usr/bin/env bash
#
# Announce a failed production deploy in Slack (ENG-865).
#
# A failed production deploy used to be entirely silent. On 2026-08-01 the
# Deploy run for PR #2237 failed, nothing said so, and production stayed
# undeployable for ~17 hours while the cause (ENG-837) was misattributed twice.
# A red check in the Actions tab is not a notification — nobody is watching it.
#
# Invoked by the `notify-deploy-failure` job in .github/workflows/deploy.yml,
# which only runs when a Deploy job that actually RAN concluded failure or
# cancelled. A job `skipped` by the path filter is not a failure and posts
# nothing; neither does a successful deploy. That noise budget is the whole
# game: an alert that cries wolf gets muted, and a muted alert is no alert.
#
# Required environment:
#   REPO             owner/repo, e.g. AgentWebPro/agentweb
#   RUN_ID           the failing workflow run id
#   COMMIT_SHA       the commit the run was deploying
#
# At least one of these must report a failing conclusion, or the script refuses
# to post and exits non-zero (see summarize_failed_jobs):
#   DETECT_RESULT    needs.detect-changes.result
#   BACKEND_RESULT   needs.backend-deploy.result
#   PARTNER_RESULT   needs.partner-deploy.result
#
# Optional environment:
#   SLACK_SECRET_ID  Secrets Manager secret id (default prod/AgentWeb/Slack)
#   GH_TOKEN         token used to read the run's annotations (never in argv)
#   RUN_ATTEMPT      defaults to 1
#   RUN_URL          defaults to the run's canonical URL built from REPO/RUN_ID
#   COMMIT_SUBJECT   commit message; empty on a workflow_dispatch run
#   DEPLOY_ACTOR     who triggered the run
#
# The bot token AND the destination channel both come from the secret. The
# channel is deliberately never hardcoded: the Emma bot has no `channels:join`
# scope, so it can only post to channels it is already a member of, and moving
# the alert must be a secret edit rather than a code change and a deploy.
#
# SECURITY — read this before editing:
#   * A value fetched at runtime is NOT auto-masked. GitHub only redacts strings
#     already in its secret store, so the token is registered with `::add-mask::`
#     the moment it exists and before anything else touches it.
#   * NEVER run this under `set -x` / `bash -x` / `shell: bash -x {0}`. xtrace
#     prints the expanded assignment, the argv, and the `::add-mask::` call
#     itself — leaking the token to a permanent run log *before* the mask is
#     registered. There is no ordering that makes xtrace safe here.
#   * The token never enters argv. argv is world-readable via /proc to every
#     process in the job and is echoed by any command tracer, so curl reads the
#     Authorization header from a config file inside a 0700 temp dir instead.
#   * The token never crosses a step boundary. A masked value written to
#     $GITHUB_OUTPUT is silently DROPPED by the runner, which would leave this
#     alert looking configured and being dead — the exact failure it exists to
#     prevent.
#
# Failure policy: no `|| true`, no `continue-on-error`, no fallback channel. A
# missing, malformed or revoked secret, a network failure, or a Slack `ok:false`
# all exit non-zero. Slack answers HTTP 200 with {"ok":false,"error":"..."} for
# invalid_auth / not_in_channel / channel_not_found, so the HTTP status alone
# proves nothing and the response body is parsed. An alerting path that quietly
# stops working is worse than none, because it is trusted.
#
# Rehearsal without a production outage: set the variables above by hand,
# pointing RUN_ID at a historical failed Deploy run, and run this script. It
# posts a real alert carrying that run's real classified reason.
#
# Exit status: 0 only when Slack answered {"ok": true}.

set -euo pipefail

SLACK_SECRET_ID="${SLACK_SECRET_ID:-prod/AgentWeb/Slack}"
RUN_ATTEMPT="${RUN_ATTEMPT:-1}"
SLACK_TIMEOUT_SECONDS="${SLACK_TIMEOUT_SECONDS:-20}"
REASON_MAX_CHARS="${REASON_MAX_CHARS:-1500}"

# Populated by load_slack_secret. Never printed, never exported, never an output.
SLACK_BOT_TOKEN=''
SLACK_CHANNEL=''

# Populated by summarize_failed_jobs / build_message.
JOB_SUMMARY=''
ALERT_TEXT=''

# 0700 scratch space for the secret, the curl config and the Slack response.
WORKDIR=''
cleanup() {
  if [ -n "${WORKDIR}" ]; then
    rm -rf "${WORKDIR}"
  fi
}
trap cleanup EXIT

log() {
  echo "[deploy-alert] $*"
}

# Every failure exits non-zero with a stable, greppable prefix, matching
# eb-deploy.sh. GitHub renders the ::error:: annotation at the top of the job.
fail() {
  echo "::error::DEPLOY_ALERT_FAILED: $*" >&2
  echo "[deploy-alert] DEPLOY_ALERT_FAILED: $*" >&2
  exit 1
}

require_env() {
  local name="$1"
  # Indirect expansion keeps this readable under `set -u`.
  if [ -z "${!name:-}" ]; then
    fail "required environment variable ${name} is empty or unset."
  fi
}

require_command() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    fail "required command '${name}' is not on PATH, so the deploy failure could not be announced."
  fi
}

# Belt and braces. The runner redacts ::add-mask:: values in its own log, but
# this script also runs in tests and by hand, where nothing is masked. Every
# captured stderr goes through here before it is printed.
#
# Implemented with bash parameter expansion rather than `sed`, deliberately.
# `sed "s|${SLACK_BOT_TOKEN}|***|g"` puts the token in a child process's argv,
# which is world-readable via /proc/<pid>/cmdline and `ps` for the life of that
# process — on the happy path, since every alert redacts its reason. That would
# defeat the whole point of routing the Authorization header through
# `curl --config`. Parameter expansion runs in this shell: no fork, no argv.
#
# `${line//"$tok"/***}` quotes the needle so it is treated as a literal, not a
# glob pattern.
redact() {
  local line tok="${SLACK_BOT_TOKEN:-}"
  while IFS= read -r line || [ -n "${line}" ]; do
    if [ -n "${tok}" ]; then
      printf '%s\n' "${line//"${tok}"/***}"
    else
      printf '%s\n' "${line}"
    fi
  done
}

# $1 = file, $2 = max chars. Collapses to a single redacted line: workflow
# commands and Slack alerts are line-oriented, and AWS/EB text is not.
head_of_file() {
  if [ ! -f "$1" ]; then
    printf '<no output>'
    return 0
  fi
  tr '\n' ' ' <"$1" | cut -c "1-${2}" | redact
}

# Collapses a possibly multi-line value to its first line.
first_line() {
  printf '%s' "${1%%$'\n'*}"
}

# ---------------------------------------------------------------------------
# Trigger gate
# ---------------------------------------------------------------------------

record_job_result() {
  local label="$1" result="${2:-}"
  case "${result}" in
    failure | cancelled | timed_out)
      JOB_SUMMARY="${JOB_SUMMARY:+${JOB_SUMMARY}, }${label}: ${result}"
      ;;
    *) ;;
  esac
}

# The workflow's `if:` is the first gate; this is the second, and it is the one
# that can be unit-tested. `skipped` matches nothing here, so an ordinary
# docs-only merge (where the path filter selects neither project) is silent.
summarize_failed_jobs() {
  record_job_result 'Detect changed projects' "${DETECT_RESULT:-}"
  record_job_result 'Backend deploy to production' "${BACKEND_RESULT:-}"
  record_job_result 'Partner portal deploy to production' "${PARTNER_RESULT:-}"

  if [ -z "${JOB_SUMMARY}" ]; then
    fail "refusing to post a deploy-failure alert: none of DETECT_RESULT='${DETECT_RESULT:-}', BACKEND_RESULT='${BACKEND_RESULT:-}', PARTNER_RESULT='${PARTNER_RESULT:-}' is failure/cancelled/timed_out. A skipped job is the path filter working as intended, and a successful deploy must stay silent. Reaching this line means the workflow condition or the env wiring is wrong, so it is loud rather than a quiet no-op."
  fi
}

# ---------------------------------------------------------------------------
# Slack credentials
# ---------------------------------------------------------------------------

load_slack_secret() {
  if ! aws secretsmanager get-secret-value \
    --secret-id "${SLACK_SECRET_ID}" \
    --query SecretString \
    --output text >"${WORKDIR}/secret.json" 2>"${WORKDIR}/secret.err"; then
    fail "could not read the Slack alert secret '${SLACK_SECRET_ID}' from AWS Secrets Manager, so a failed production deploy went unannounced. AWS reported: $(head_of_file "${WORKDIR}/secret.err" 400)"
  fi

  # Whitespace-only counts as empty, so a blanked secret says "empty" rather
  # than the less useful "not a JSON object" from the check below. The value is
  # only tested here, never printed.
  if [ -z "$(tr -d '[:space:]' <"${WORKDIR}/secret.json")" ]; then
    fail "the Slack alert secret '${SLACK_SECRET_ID}' returned an empty SecretString."
  fi

  # `--output text` renders a missing SecretString as the literal token None.
  if [ "$(head -c 16 "${WORKDIR}/secret.json")" = "None" ]; then
    fail "the Slack alert secret '${SLACK_SECRET_ID}' has no SecretString (the AWS CLI returned 'None'). A binary or empty secret cannot carry the bot token."
  fi

  if ! jq -e 'type == "object"' "${WORKDIR}/secret.json" >/dev/null 2>&1; then
    fail "the Slack alert secret '${SLACK_SECRET_ID}' is not a JSON object; it must contain botToken and deployAlertChannel. Its contents are deliberately not printed."
  fi

  SLACK_BOT_TOKEN="$(jq -r '.botToken // empty' "${WORKDIR}/secret.json")"
  if [ -z "${SLACK_BOT_TOKEN}" ]; then
    fail "the Slack alert secret '${SLACK_SECRET_ID}' has no non-empty 'botToken', so nothing can authenticate to Slack."
  fi

  # Register the mask before ANY other statement can touch the token. Runtime
  # values are not masked for us; this line is the only thing standing between
  # a production bot token and a permanent public run log.
  #
  # Guarded on GITHUB_ACTIONS: inside the runner this is a workflow command and
  # the token is consumed, never rendered. Outside it — the by-hand rehearsal in
  # the header, or the test suite — it is just a plaintext print of a production
  # token to stdout, straight into terminal scrollback or an agent transcript.
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    printf '::add-mask::%s\n' "${SLACK_BOT_TOKEN}"
  fi

  SLACK_CHANNEL="$(jq -r '.deployAlertChannel // empty' "${WORKDIR}/secret.json")"
  if [ -z "${SLACK_CHANNEL}" ]; then
    fail "the Slack alert secret '${SLACK_SECRET_ID}' has no non-empty 'deployAlertChannel'. There is deliberately no hardcoded fallback: the bot has no channels:join scope, so a guessed channel would be rejected while the step still looked healthy."
  fi
}

# ---------------------------------------------------------------------------
# The classified reason
# ---------------------------------------------------------------------------

# Recovers the reason eb-deploy.sh classified.
#
# eb-deploy.sh's fail() writes `::error::EB_DEPLOY_FAILED: <reason>` and exits.
# That annotation is the only durable carrier: a step's stderr is unreadable
# from any later step or job, and nothing is written to GITHUB_ENV or
# GITHUB_OUTPUT. GitHub keeps the annotation on the job's check-run, which is
# what this reads (`actions: read` to list the jobs, `checks: read` for their
# annotations).
#
# Best-effort by design, and never fatal. A Deploy run can fail before
# eb-deploy.sh ever executes (npm ci, Build, zip, the S3 upload) or be killed by
# the runner's step timeout, in which case no EB_DEPLOY_FAILED annotation exists
# and the failed step's name is the best available answer. The alert says which
# case it is instead of posting an empty Reason line — but it always posts. No
# alert is a far worse outcome than an alert with a thinner reason.
resolve_failure_reason() {
  local jobs_file="${WORKDIR}/jobs.json"
  local err_file="${WORKDIR}/gh.err"
  local job_id job_name conclusion annotation step reason

  if [ -z "${GH_TOKEN:-}" ]; then
    printf 'unavailable — GH_TOKEN is not set, so the run annotations could not be read. Open the run for the cause.'
    return 0
  fi

  if ! command -v gh >/dev/null 2>&1; then
    printf 'unavailable — the gh CLI is not on PATH, so the run annotations could not be read. Open the run for the cause.'
    return 0
  fi

  if ! gh api "repos/${REPO}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}/jobs?per_page=100" \
    >"${jobs_file}" 2>"${err_file}"; then
    printf "unavailable — could not list the run's jobs (%s). Open the run for the cause." \
      "$(head_of_file "${err_file}" 200)"
    return 0
  fi

  reason=''
  while IFS=$'\t' read -r job_id job_name conclusion; do
    if [ -z "${job_id}" ]; then
      continue
    fi

    annotation=''
    if gh api "repos/${REPO}/check-runs/${job_id}/annotations" \
      >"${WORKDIR}/annotations.json" 2>"${err_file}"; then
      if ! jq -r '(. // [])[] | .message // empty' "${WORKDIR}/annotations.json" \
        >"${WORKDIR}/annotations.txt" 2>/dev/null; then
        : >"${WORKDIR}/annotations.txt"
      fi
      if grep -m1 -F 'EB_DEPLOY_FAILED:' "${WORKDIR}/annotations.txt" \
        >"${WORKDIR}/annotation-hit.txt"; then
        annotation="$(cat "${WORKDIR}/annotation-hit.txt")"
      fi
    fi

    if [ -n "${annotation}" ]; then
      # Keep only the classified text, dropping the prefix eb-deploy.sh uses to
      # make the line greppable in the first place.
      reason="${job_name}: ${annotation#*EB_DEPLOY_FAILED: }"
      break
    fi

    step="$(jq -r --arg id "${job_id}" \
      '(.jobs // [])[] | select((.id|tostring) == $id) | (.steps // [])[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out") | .name' \
      "${jobs_file}" 2>/dev/null | head -n 1)"

    if [ -n "${step}" ]; then
      reason="${job_name}: ${conclusion} at step '${step}'. No EB_DEPLOY_FAILED annotation, so the run failed before or outside eb-deploy.sh."
    else
      reason="${job_name}: ${conclusion}, with no EB_DEPLOY_FAILED annotation and no failed step recorded — the job was most likely killed by the runner or a job-level timeout."
    fi
    break
  done < <(jq -r '(.jobs // [])[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out") | "\(.id)\t\(.name)\t\(.conclusion)"' "${jobs_file}" 2>/dev/null)

  if [ -z "${reason}" ]; then
    printf "unavailable — the run's job list reported no failed job, which contradicts the job results this alert was triggered with. Open the run for the cause."
    return 0
  fi

  printf '%s' "$(first_line "${reason}")" | cut -c "1-${REASON_MAX_CHARS}" | redact
}

# ---------------------------------------------------------------------------
# The message
# ---------------------------------------------------------------------------

build_message() {
  local short_sha subject reason
  short_sha="${COMMIT_SHA:0:7}"
  subject="$(first_line "${COMMIT_SUBJECT:-}")"
  if [ -z "${subject}" ]; then
    subject='(no commit subject — manual run)'
  fi
  reason="$(resolve_failure_reason)"

  ALERT_TEXT=":rotating_light: *Production deploy FAILED* — ${REPO}

*Jobs:* ${JOB_SUMMARY}
*Commit:* \`${short_sha}\` ${subject}
*Triggered by:* ${DEPLOY_ACTOR:-unknown}
*Reason:* ${reason}

${RUN_URL}

The deploy did not complete. Do not assume this commit is live in production."
}

build_payload() {
  if ! jq -n \
    --arg channel "${SLACK_CHANNEL}" \
    --arg text "${ALERT_TEXT}" \
    '{channel: $channel, text: $text, unfurl_links: false, unfurl_media: false}' \
    >"${WORKDIR}/payload.json" 2>"${WORKDIR}/jq.err"; then
    fail "could not build the Slack payload: $(head_of_file "${WORKDIR}/jq.err" 300)"
  fi
}

# ---------------------------------------------------------------------------
# Delivery
# ---------------------------------------------------------------------------

post_to_slack() {
  local rc=0 http_code ok slack_error

  # The Authorization header goes in through a config file, never argv. The
  # heredoc is unquoted so the token expands, and its body is not printed by a
  # command tracer even if one is ever switched on upstream.
  cat >"${WORKDIR}/curl.cfg" <<CURLCFG
url = "https://slack.com/api/chat.postMessage"
request = "POST"
header = "Authorization: Bearer ${SLACK_BOT_TOKEN}"
header = "Content-Type: application/json; charset=utf-8"
data = @${WORKDIR}/payload.json
CURLCFG

  # Retry transient failures. Without this, a single DNS blip, TCP reset, Slack
  # 5xx or 429 means the alert is never delivered — and the only remaining
  # signal is a red job inside a Deploy run that was ALREADY red, which is
  # exactly the invisible-failure shape ENG-865 exists to eliminate.
  #
  # `--retry` covers transient HTTP (429, 5xx) and, with --retry-connrefused,
  # connection-level failures. It does NOT retry a 4xx like invalid_auth, which
  # is correct — those are terminal and must fail fast.
  #
  # Accepted tradeoff: chat.postMessage is not idempotent, so a retry after a
  # response that was sent but not received could duplicate the alert. A
  # duplicated deploy-failure alert is a minor annoyance; a missing one is the
  # bug this whole issue is about.
  http_code="$(curl --silent --show-error \
    --max-time "${SLACK_TIMEOUT_SECONDS}" \
    --retry 3 --retry-delay 2 --retry-connrefused \
    --output "${WORKDIR}/response.json" \
    --write-out '%{http_code}' \
    --config "${WORKDIR}/curl.cfg" 2>"${WORKDIR}/curl.err")" || rc=$?

  if [ "${rc}" -ne 0 ]; then
    fail "the Slack chat.postMessage request failed at the network level (curl exit ${rc}), so a failed production deploy went unannounced. curl reported: $(head_of_file "${WORKDIR}/curl.err" 300)"
  fi

  if [ ! -s "${WORKDIR}/response.json" ] || ! jq -e 'type == "object"' "${WORKDIR}/response.json" >/dev/null 2>&1; then
    fail "Slack answered HTTP ${http_code} with a body that is not a JSON object, so delivery cannot be confirmed. Body: $(head_of_file "${WORKDIR}/response.json" 300)"
  fi

  # THE trap this whole step exists to avoid: chat.postMessage answers HTTP 200
  # with {"ok":false,"error":"invalid_auth"} for a revoked token, and
  # {"ok":false,"error":"not_in_channel"} when the channel is changed to one the
  # bot has not been invited to. `curl --fail` and the status code both say 200.
  # Only the body knows the message went nowhere.
  ok="$(jq -r '.ok // false' "${WORKDIR}/response.json")"
  if [ "${ok}" != "true" ]; then
    slack_error="$(jq -r '.error // "unknown"' "${WORKDIR}/response.json")"
    fail "Slack accepted the request with HTTP ${http_code} but REJECTED the message: ok=false error='${slack_error}'. The deploy-failure alert was NOT delivered to channel '${SLACK_CHANNEL}'. If this is not_in_channel or channel_not_found, invite the bot (it has no channels:join scope); if it is invalid_auth, rotate botToken in '${SLACK_SECRET_ID}'."
  fi
}

main() {
  require_env REPO
  require_env RUN_ID
  require_env COMMIT_SHA
  require_command aws
  require_command curl
  require_command jq

  RUN_URL="${RUN_URL:-https://github.com/${REPO}/actions/runs/${RUN_ID}}"

  summarize_failed_jobs
  log "Deploy run ${RUN_ID} failed (${JOB_SUMMARY}); assembling the Slack alert."

  umask 077
  WORKDIR="$(mktemp -d)"

  load_slack_secret
  build_message
  build_payload
  post_to_slack

  log "Deploy-failure alert delivered to channel ${SLACK_CHANNEL}."
}

main "$@"
