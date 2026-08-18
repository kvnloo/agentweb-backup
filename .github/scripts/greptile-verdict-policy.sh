#!/usr/bin/env bash
#
# Decide whether the "Require Greptile Review" job should PASS or FAIL, given
# the verdict greptile-gate.sh already computed (pass | refused | unavailable
# — see that script's header for exactly how each is derived and why
# `unavailable` cannot misfire onto a review Greptile actually scored).
#
# Policy (changed 2026-08-18, Harsha's explicit direction): PR #2425
# (ENG-1277) sat blocked for most of a day by a real Greptile-side outage —
# reviews stuck on a stale head for hours, retrigger requests 400ing,
# unrelated PRs on the same repo reviewed normally in the same window (so not
# an org-wide credit exhaustion; something specific to this PR/commit chain
# never recovered). The code was independently proven the entire time: 10
# rounds of genuine Greptile findings fixed and live-verified with real
# reproductions, 55/55 unit tests, tsc clean, every backend/agentMode CI job
# green repeatedly. Blocking a fully-proven change on a service that will not
# answer, for hours, holds shipping hostage to nothing.
#
#   pass         -> job passes. A genuine verdict landed for this exact head
#                   at or above the bar.
#   refused      -> job fails, unchanged from before this policy. Greptile
#                   REVIEWED this head and scored it below the bar — a real
#                   negative signal stays a hard block regardless of this
#                   change.
#   unavailable  -> job passes, with a loud `::warning::` annotation so it
#                   stays visible on the PR that this was not a real review.
#                   Greptile never returned ANY verdict for this head within
#                   the poll window. This is the one behavior this policy
#                   changes; every other verdict is identical to before.
#   anything else (unset, empty, a typo, a future verdict this script does
#                   not know about) -> job fails. Fail closed on an unknown
#                   state rather than guess it means "did not find anything".
#
# CodeRabbit is deliberately not covered here: verified via the branch
# protection API on 2026-08-17 that it has never been a required check on
# this repo, and it reports `pass` in the PR checks UI regardless of its own
# rate-limit state (shown as "Review rate limited" vs "Review completed" —
# both surface as a passing check). It was already advisory-only; there is no
# gate here to loosen.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  printf '::error::greptile-verdict-policy: usage: greptile-verdict-policy.sh <pass|refused|unavailable>\n' >&2
  exit 1
fi

verdict="$1"

case "${verdict}" in
  pass)
    printf 'greptile-verdict-policy: PASS — Greptile scored this head at or above the bar.\n'
    exit 0
    ;;
  refused)
    printf '::error::greptile-verdict-policy: Greptile reviewed this head and it did not clear the bar — a real finding, still blocking. Address it, accept it with a human /greptile-override, or wait for a fresh review.\n' >&2
    exit 1
    ;;
  unavailable)
    printf '::warning::greptile-verdict-policy: Greptile never returned a verdict for this head within the poll window — not blocking on a service that is not answering. This is NOT a real review; treat it as unreviewed, not as cleared.\n'
    printf 'greptile-verdict-policy: PASS (with warning) — Greptile never returned a verdict for this head; not blocking.\n'
    exit 0
    ;;
  *)
    printf "::error::greptile-verdict-policy: unrecognized verdict '%s' — expected pass, refused, or unavailable. Failing closed on an unknown state rather than treating it as a pass.\n" "${verdict}" >&2
    exit 1
    ;;
esac
