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
# CAUGHT LIVE A SECOND TIME (Greptile 3/5, security-review section, same
# PR, reviewing the fix above): commit author metadata is SELF-DECLARED,
# not authenticated. `.author.login` resolving to dependabot[bot] only
# means the commit's email happens to match Dependabot's public, known
# noreply address (49699333+dependabot[bot]@users.noreply.github.com) —
# any repository writer can set that as their local `git config user.email`
# and push a commit that resolves the exact same way, with arbitrary
# attacker-controlled content, and the original version of this check would
# have waved it straight through.
#
# Fix: also require `.commit.verification.verified == true` on every
# commit. Verified live against a real Dependabot PR on this org
# (agentweb#2276): its Dependabot commit is `verified: true, reason:
# "valid"` — a real cryptographic signature GitHub attributes to the
# dependabot[bot] identity specifically, which only GitHub's own Dependabot
# infrastructure can produce. A human forging the author EMAIL cannot also
# forge a signature GitHub verifies as belonging to dependabot[bot]'s own
# signing identity — that would require possessing GitHub's actual signing
# key, not just knowing a public noreply address. (Also verified live: not
# all human commits in this org are signed — several of harshmoney123's own
# commits show `verified: false, reason: "unsigned"` — so this check is a
# real filter, not one that happens to pass everything anyway.)
#
# Fails CLOSED on any ambiguity: an unlinked commit author (no GitHub
# account resolves the commit's email — .author is null), an unverified or
# unsigned commit even if the author resolves correctly, an API failure, or
# zero commits found all mean NOT CONFIRMED dependabot-only, which the
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

  # Two independent conditions, both required, per commit:
  #   .author.login       — GitHub's resolved account (null if the commit's
  #                         email doesn't map to any account). This is WHO
  #                         github attributes the commit to.
  #   .commit.verification.verified — whether that attribution is actually
  #                         backed by a valid cryptographic signature, not
  #                         just a self-declared email. The author login
  #                         alone is forgeable by anyone with push access;
  #                         a verified signature attributed to
  #                         dependabot[bot] is not.
  # Neither check alone is sufficient: author-only is forgeable (see
  # header); verified-only would accept any human's own legitimately
  # signed commit, since it doesn't ask WHOSE signature it is.
  non_dependabot="$(printf '%s' "${commits_json}" | jq -s '
      [.[]] | flatten
      | map(select(
          (.author.login // "UNLINKED") != "dependabot[bot]"
          or (.commit.verification.verified // false) != true
        ))
      | length
    ' 2>/dev/null || echo -1)"

  if [ "${non_dependabot}" -lt 0 ]; then
    fail "could not parse the commit list for ${REPO}#${PR_NUMBER}."
    exit 1
  fi

  if [ "${non_dependabot}" -gt 0 ]; then
    echo "[dependabot-only-pr] ${REPO}#${PR_NUMBER}: ${non_dependabot} of ${total} commits are NOT both dependabot[bot]-authored AND signature-verified. Not bypass-eligible."
    exit 1
  fi

  echo "[dependabot-only-pr] ${REPO}#${PR_NUMBER}: all ${total} commit(s) authored by dependabot[bot] AND signature-verified. Bypass-eligible."
}

main "$@"
