#!/usr/bin/env bash
#
# ENG-809: a PR must not edit dev.md directly; it writes a fragment instead.
#
#   printf '%s\n' <changed files> | bash .github/scripts/dev-md-guard.sh <head-ref> [status-file]
#
# stdin is the PR's changed paths, one per line. The optional status file has
# "<status>\t<path>" lines (GitHub's pulls/N/files `status` field) and is only
# consulted for the consolidation bot's branch.
#
# Direct dev.md edits are what made every pair of open PRs collide on line 1
# (see dev-md-consolidate.sh). The fragment convention only holds if it is
# enforced: a convention that relies on discipline broke twice in one night
# with three agents actively trying to honour it (decision, 2026-08-02).
#
# The single exemption is the consolidation PR itself, on branch
# automation/dev-md-consolidate, and only when every change in it is dev.md or
# a REMOVED dev/pending fragment. Anything else on that branch fails like any
# other PR, so the branch name alone cannot smuggle an edit through.

set -euo pipefail

HEAD_REF="${1:?usage: dev-md-guard.sh <head-ref> [status-file]}"
STATUS_FILE="${2:-}"
CONSOLIDATE_BRANCH="automation/dev-md-consolidate"

changed=$(cat)

if ! grep -qxF 'dev.md' <<<"${changed}"; then
  echo "dev.md not modified directly."
  exit 0
fi

if [ "${HEAD_REF}" = "${CONSOLIDATE_BRANCH}" ]; then
  if [ -z "${STATUS_FILE}" ] || [ ! -f "${STATUS_FILE}" ]; then
    echo "DEV_MD_GUARD_FAILED: consolidation PR exemption needs per-file status to verify" >&2
    exit 1
  fi
  ok=1
  while IFS=$'\t' read -r status path; do
    [ -z "${path}" ] && continue
    if [ "${path}" = "dev.md" ]; then continue; fi
    case "${path}" in
      dev/pending/*.md)
        [ "${status}" = "removed" ] && continue ;;
    esac
    echo "DEV_MD_GUARD_FAILED: consolidation PR may only change dev.md and remove dev/pending fragments; found ${status} ${path}" >&2
    ok=0
  done <"${STATUS_FILE}"
  if [ "${ok}" -eq 1 ]; then
    echo "dev.md modified by the consolidation PR; allowed."
    exit 0
  fi
  exit 1
fi

cat >&2 <<'EOF'
DEV_MD_GUARD_FAILED: this PR modifies dev.md directly.

Write your investigation note as a fragment instead:

    dev/pending/<eng-id>-<slug>.md      e.g. dev/pending/eng-809-dev-md-fragments.md

Line 1 must be the section heading ending in a date:

    ## ENG-809: what was learned (2026-10-06)

After merge, .github/workflows/dev-md-consolidate.yml folds pending fragments
into dev.md (newest first) and deletes them. Editing dev.md directly makes every
concurrent PR conflict on line 1 (ENG-809).
EOF
exit 1
