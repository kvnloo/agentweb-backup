#!/usr/bin/env bash
#
# ENG-2677 (slice of ENG-2634): after a SUCCESSFUL production backend deploy,
# post one factual message to #feature-launches listing the PRs that shipped
# since the previous successful deploy, plus the run URL.
#
# Factual only: PR numbers, PR titles (verbatim from GitHub) and Linear ENG
# ids. No generated copy. Judgment-bearing launch posts stay human (ENG-2634).
#
# Inputs (env):
#   FEATURE_LAUNCHES_CHANNEL  Slack channel id (repo variable). Unset/empty ->
#                             logged ::notice:: and exit 0. The bot has no
#                             channels:join scope, so it must be invited first.
#   BASE_SHA                  head of the previous successful deploy, from
#                             deploy-base-sha.sh. Empty -> notice, exit 0
#                             (no trustworthy range, so nothing factual to say).
#   COMMIT_SHA                head deployed by this run.
#   REPO, RUN_URL, GH_TOKEN
#   SLACK_SECRET_ID           default prod/AgentWeb/Slack (botToken only).
#
# Deploy-control integrity: this runs in its own job AFTER backend-deploy has
# already succeeded and nothing depends on it, so it cannot gate, alter or roll
# back the deploy. It still fails loudly (no `|| true`) when Slack answers
# ok:false, so a broken notifier is a visible red job rather than a silent one.
#
# PR titles never reach `run:`; they arrive via the GitHub API and are only
# ever handled as data (jq --arg), never evaluated.

set -euo pipefail

SLACK_SECRET_ID="${SLACK_SECRET_ID:-prod/AgentWeb/Slack}"
SLACK_TIMEOUT_SECONDS="${SLACK_TIMEOUT_SECONDS:-20}"
SLACK_BOT_TOKEN=''
WORKDIR=''

log() { echo "[launch-notify] $*"; }
notice() { echo "::notice::LAUNCH_NOTIFY_SKIPPED: $*"; }
fail() {
  echo "::error::LAUNCH_NOTIFY_FAILED: $*" >&2
  exit 1
}

# build_launch_message <prs.json> <run_url>
# prs.json: JSON array of {number, title, body}. Prints the Slack text, or
# nothing for an empty list (caller then posts nothing). Pure: no network.
build_launch_message() {
  jq -r --arg run "$2" '
    if length == 0 then empty else
      ( "Shipped to production (backend):\n"
        + ( sort_by(.number)
            | map("- #" + (.number | tostring) + " " + .title
                  + ( [((.title + " " + (.body // "")) | match("ENG-[0-9]+"; "g").string)]
                      | unique | if length == 0 then "" else " (" + join(", ") + ")" end))
            | join("\n"))
        + "\n\n" + $run )
    end' "$1"
}

# collect_prs <base> <head> -> JSON array on stdout. PR numbers come from
# first-parent subjects in base..head: "Merge pull request #123 ..." (merge
# commits, this repo's default) or "... (#123)" (squash). Titles from the API.
collect_prs() {
  local nums n
  nums="$(git log --first-parent --format=%s "$1..$2" |
    sed -nE 's/^Merge pull request #([0-9]+) .*/\1/p; s/.*\(#([0-9]+)\)$/\1/p' | sort -un)"
  {
    for n in ${nums}; do
      gh pr view "${n}" --repo "${REPO}" --json number,title,body
    done
  } | jq -s '.'
}

load_bot_token() {
  aws secretsmanager get-secret-value --secret-id "${SLACK_SECRET_ID}" \
    --query SecretString --output text >"${WORKDIR}/secret.json" 2>"${WORKDIR}/secret.err" ||
    fail "could not read '${SLACK_SECRET_ID}' from Secrets Manager."
  SLACK_BOT_TOKEN="$(jq -r '.botToken // empty' "${WORKDIR}/secret.json" 2>/dev/null || true)"
  [ -n "${SLACK_BOT_TOKEN}" ] || fail "'${SLACK_SECRET_ID}' has no non-empty botToken."
  if [ -n "${GITHUB_ACTIONS:-}" ]; then printf '::add-mask::%s\n' "${SLACK_BOT_TOKEN}"; fi
}

post_to_slack() {
  local rc=0 http_code ok
  jq -n --arg channel "${FEATURE_LAUNCHES_CHANNEL}" --rawfile text "${WORKDIR}/text.txt" \
    '{channel: $channel, text: $text, unfurl_links: false, unfurl_media: false}' >"${WORKDIR}/payload.json"
  # Token goes through a curl config file, never argv.
  cat >"${WORKDIR}/curl.cfg" <<CURLCFG
url = "https://slack.com/api/chat.postMessage"
request = "POST"
header = "Authorization: Bearer ${SLACK_BOT_TOKEN}"
header = "Content-Type: application/json; charset=utf-8"
data = @${WORKDIR}/payload.json
CURLCFG
  http_code="$(curl --silent --show-error --max-time "${SLACK_TIMEOUT_SECONDS}" \
    --retry 3 --retry-delay 2 --retry-connrefused \
    --output "${WORKDIR}/response.json" --write-out '%{http_code}' \
    --config "${WORKDIR}/curl.cfg" 2>"${WORKDIR}/curl.err")" || rc=$?
  [ "${rc}" -eq 0 ] || fail "chat.postMessage failed at the network level (curl exit ${rc})."
  ok="$(jq -r '.ok // false' "${WORKDIR}/response.json" 2>/dev/null || echo false)"
  [ "${ok}" = "true" ] ||
    fail "Slack HTTP ${http_code} rejected the launch post: $(jq -r '.error // "unparseable body"' "${WORKDIR}/response.json" 2>/dev/null || echo 'unparseable body'). Deploy is unaffected."
}

main() {
  if [ -z "${FEATURE_LAUNCHES_CHANNEL:-}" ]; then
    notice "repo variable FEATURE_LAUNCHES_CHANNEL is not set; no #feature-launches post."
    return 0
  fi
  if [ -z "${BASE_SHA:-}" ]; then
    notice "no resolved previous-deploy base SHA; cannot list shipped PRs factually."
    return 0
  fi
  : "${COMMIT_SHA:?}" "${REPO:?}" "${RUN_URL:?}"
  umask 077
  WORKDIR="$(mktemp -d)"
  trap 'rm -rf "${WORKDIR}"' EXIT

  collect_prs "${BASE_SHA}" "${COMMIT_SHA}" >"${WORKDIR}/prs.json"
  build_launch_message "${WORKDIR}/prs.json" "${RUN_URL}" >"${WORKDIR}/text.txt"
  if [ ! -s "${WORKDIR}/text.txt" ]; then
    log "no merged PRs in ${BASE_SHA}..${COMMIT_SHA}; nothing to post."
    return 0
  fi
  load_bot_token
  post_to_slack
  log "posted launch note for $(jq length "${WORKDIR}/prs.json") PR(s)."
}

if [ "${LAUNCH_NOTIFY_LIB:-}" != "1" ]; then main "$@"; fi
