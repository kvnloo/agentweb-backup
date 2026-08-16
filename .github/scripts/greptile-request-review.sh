#!/usr/bin/env bash
#
# Request a fresh Greptile review of a PR's current head (ENG-1282).
#
# greptile.json now sets `triggerOnUpdates: false`. Greptile no longer
# auto-reviews every push to an already-ready PR — only `opened` and
# `ready_for_review` trigger a review automatically. That flag existed
# because it was billing $1/review past the included 50/seat, and PRs here
# average 6.4 pushes before merge (max measured: 50) — every one of those was
# a paid re-review of code nobody had finished changing yet.
#
# This script is the deliberate replacement: call it ONCE, after a batch of
# fixes is pushed and you actually want a fresh verdict on the current head —
# not after every individual push. Calling it per-push recreates the exact
# cost this change removes. See .github/scripts/greptile-gate.sh, which waits
# for the review this triggers and fails closed (never a false pass) if one
# never arrives.
#
# What it does: posts a PR comment containing `@greptileai`, which is
# Greptile's documented manual-trigger mention. Nothing to parse from the
# response — Greptile answers asynchronously via its own review comment,
# which greptile-gate.sh reads separately.
#
# Environment:
#   REPO         owner/repo, e.g. AgentWebPro/agentweb
#   PR_NUMBER    pull request number
#   GH_TOKEN     token for `gh pr comment` (needs pull-requests: write)
#
# Not idempotent by design: every call posts one comment. The caller decides
# when a fresh review is warranted; this script has no way to know whether a
# review is already pending, and guessing wrong in either direction is worse
# than the trivial cost of one extra comment.
#
# Exit status: 0 only when the comment was posted. Any failure is loud —
# there is no fallback path, and a silently-skipped trigger means the gate
# later fails closed (UNAVAILABLE) for a reason nothing here explains.

set -euo pipefail

fail() {
  echo "::error::GREPTILE_REQUEST_REVIEW_FAILED: $*" >&2
  echo "[greptile-request-review] GREPTILE_REQUEST_REVIEW_FAILED: $*" >&2
  exit 1
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "required environment variable ${name} is empty or unset."
  fi
}

main() {
  require_env REPO
  require_env PR_NUMBER

  if ! command -v gh >/dev/null 2>&1; then
    fail "the gh CLI is not on PATH, so the review request could not be posted."
  fi

  if ! gh pr comment "${PR_NUMBER}" --repo "${REPO}" --body '@greptileai' >/dev/null; then
    fail "gh pr comment failed for ${REPO}#${PR_NUMBER}, so no review was requested. Check GH_TOKEN scope (needs pull-requests: write)."
  fi

  echo "[greptile-request-review] requested a fresh Greptile review on ${REPO}#${PR_NUMBER}."
}

main "$@"
