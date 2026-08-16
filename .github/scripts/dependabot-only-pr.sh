#!/usr/bin/env bash
#
# True iff EVERY commit in a PR was authored by dependabot[bot] — the actual
# check the Greptile-review Dependabot bypass needs (ENG-1282).
#
# CAUGHT LIVE (Greptile 3/5, security-review section, portal#1037): the
# bypass this replaces checked `github.event.pull_request.user.login` (who
# opened the PR) and `github.actor` (who triggered THIS push) — both fixed
# per-event, neither telling you what's actually IN the current head. The
# attack: a human pushes a commit onto a Dependabot-opened branch (their
# push correctly fails the actor check, so it gets a real review — good).
# Later, Dependabot performs a routine automated update of that same PR
# (a rebase/refresh it does on its own open PRs). THAT push's actor is
# dependabot[bot] again, satisfies both old checks, and grants a synthetic
# `pass` for the CURRENT head — which still contains the human's commit
# from the push before, now laundered through the bypass without ever
# being reviewed.
#
# Fix: don't ask "who triggered this event" — ask "does this PR's commit
# history, top to bottom, contain anything OTHER than dependabot[bot]
# commits." One human commit anywhere in the PR's history permanently
# disqualifies it from the bypass, even if Dependabot pushes again later —
# there is no way to "clean" a PR back to bypass-eligible short of closing
# it and letting Dependabot open a fresh one.
#
# Fails CLOSED on any ambiguity: an unlinked commit author (no GitHub
# account resolves the commit's email — .author is null), an API failure,
# or zero commits found all mean NOT CONFIRMED dependabot-only, which the
# caller must treat as "run the real gate," never as "safe to skip."
#
# Environment:
#   REPO         owner/repo, e.g. AgentWebPro/agentweb-customer-portal
#   PR_NUMBER    pull request number
#   GH_TOKEN     token for `gh api` (pull-requests: read is sufficient)
#
# Exit status:
#   0   every commit in the PR is authored by dependabot[bot] — safe to
#       treat as Dependabot-only for the review bypass.
#   1   at least one commit is not dependabot-authored, authorship could
#       not be confirmed for at least one commit, no commits were found,
#       or the API call itself failed. All of these mean: do NOT bypass.

set -euo pipefail

fail() {
  echo "::error::DEPENDABOT_ONLY_PR_CHECK_FAILED: $*" >&2
  echo "[dependabot-only-pr] DEPENDABOT_ONLY_PR_CHECK_FAILED: $*" >&2
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "required environment variable ${name} is empty or unset."
    exit 1
  fi
}

main() {
  require_env REPO
  require_env PR_NUMBER

  if ! command -v gh >/dev/null 2>&1; then
    fail "the gh CLI is not on PATH."
    exit 1
  fi

  local commits_json
  if ! commits_json="$(gh api --paginate "repos/${REPO}/pulls/${PR_NUMBER}/commits?per_page=100" 2>&1)"; then
    fail "could not list commits for ${REPO}#${PR_NUMBER}: ${commits_json}"
    exit 1
  fi

  local total non_dependabot
  total="$(printf '%s' "${commits_json}" | jq -s '[.[]] | flatten | length' 2>/dev/null || echo 0)"
  if [ -z "${total}" ] || [ "${total}" -eq 0 ]; then
    fail "found zero commits for ${REPO}#${PR_NUMBER} — cannot confirm dependabot-only authorship of an empty history."
    exit 1
  fi

  # .author is GitHub's resolved account for the commit (null if the
  # commit's email doesn't map to any account) — this is who GITHUB
  # attributes the commit to, which is what matters for this check, not
  # the raw .commit.author.email (which a human could set to anything).
  non_dependabot="$(printf '%s' "${commits_json}" | jq -s '
      [.[]] | flatten
      | map(select((.author.login // "UNLINKED") != "dependabot[bot]"))
      | length
    ' 2>/dev/null || echo -1)"

  if [ "${non_dependabot}" -lt 0 ]; then
    fail "could not parse the commit list for ${REPO}#${PR_NUMBER}."
    exit 1
  fi

  if [ "${non_dependabot}" -gt 0 ]; then
    echo "[dependabot-only-pr] ${REPO}#${PR_NUMBER}: ${non_dependabot} of ${total} commits are NOT authored by dependabot[bot] (or authorship is unlinked). Not bypass-eligible."
    exit 1
  fi

  echo "[dependabot-only-pr] ${REPO}#${PR_NUMBER}: all ${total} commit(s) authored by dependabot[bot]. Bypass-eligible."
}

main "$@"
