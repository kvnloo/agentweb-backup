#!/usr/bin/env bash
#
# ENG-809: fold pending dev.md fragments into dev.md, newest first, and delete
# them.
#
#   bash .github/scripts/dev-md-consolidate.sh [repo-root]
#
# Why fragments
# -------------
# Every PR used to prepend its investigation note to line 1 of dev.md, so any
# two open PRs collided on the same hunk and the second to merge went
# CONFLICTING. A conflicted PR cannot schedule a workflow run at all and keeps
# displaying its last green (ENG-757), so the convention was the mechanism that
# made that blind window common. A PR now writes dev/pending/<eng-id>-<slug>.md
# instead: unique file per issue, so two PRs can never touch the same path.
# This script is the "consolidate" half of the 2026-08-02 decision (the
# Changesets / towncrier pattern).
#
# Fragment contract
# -----------------
# Line 1 must be a dev.md section heading ending in an ISO date:
#
#     ## ENG-123: what was learned (2026-10-06)
#
# Fragments are ordered by that date, newest first; same-date fragments are
# ordered by filename descending so the output is deterministic. A fragment
# that does not satisfy the contract FAILS the run and nothing is written —
# silently dropping a note is worse than the conflict this replaces (AC4).
#
# Safety
# ------
# dev.md is rewritten via a temp file and a final rename, and fragments are
# deleted only after the new dev.md has been verified to contain every
# fragment's full text. Any failure before that leaves the tree untouched.
#
# Exit status: 0 on success (including "nothing pending"), non-zero otherwise.

set -euo pipefail

ROOT="${1:-.}"
DEV_MD="${ROOT}/dev.md"
PENDING_DIR="${ROOT}/dev/pending"

die() {
  printf 'DEV_MD_CONSOLIDATE_FAILED: %s\n' "$*" >&2
  exit 1
}

[ -f "${DEV_MD}" ] || die "no dev.md at '${DEV_MD}'"

if [ ! -d "${PENDING_DIR}" ]; then
  echo "No ${PENDING_DIR} directory; nothing to consolidate."
  exit 0
fi

# Collect fragments (README.md documents the directory and is never folded in).
fragments=()
while IFS= read -r -d '' f; do
  case "$(basename "${f}")" in
    README.md) continue ;;
  esac
  fragments+=("${f}")
done < <(find "${PENDING_DIR}" -maxdepth 1 -type f -name '*.md' -print0)

if [ "${#fragments[@]}" -eq 0 ]; then
  echo "No pending fragments; dev.md unchanged."
  exit 0
fi

# Validate every fragment before touching anything, and build sort keys.
keyed=()
for f in "${fragments[@]}"; do
  [ -s "${f}" ] || die "fragment '${f}' is empty"
  heading=$(head -n 1 "${f}")
  case "${heading}" in
    '## '*) ;;
    *) die "fragment '${f}' must start with a '## ' heading; got: ${heading}" ;;
  esac
  date=$(sed -nE '1s/.*\(([0-9]{4}-[0-9]{2}-[0-9]{2})\)[[:space:]]*$/\1/p' "${f}")
  [ -n "${date}" ] || die "fragment '${f}' heading must end with '(YYYY-MM-DD)'; got: ${heading}"
  keyed+=("${date}"$'\t'"$(basename "${f}")"$'\t'"${f}")
done

ordered=()
while IFS= read -r line; do
  ordered+=("${line##*$'\t'}")
done < <(printf '%s\n' "${keyed[@]}" | sort -r -t $'\t' -k1,1 -k2,2)

tmp=$(mktemp "${DEV_MD}.XXXXXX")
trap 'rm -f "${tmp}"' EXIT

for f in "${ordered[@]}"; do
  # Strip trailing blank lines so spacing between sections is exactly one
  # blank line regardless of how the fragment was saved.
  sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' "${f}" >>"${tmp}"
  printf '\n' >>"${tmp}"
done
cat "${DEV_MD}" >>"${tmp}"

# Verify before deleting anything: every fragment's text must be present.
for f in "${ordered[@]}"; do
  while IFS= read -r l; do
    [ -z "${l}" ] && continue
    grep -qxF -- "${l}" "${tmp}" || die "verification failed: a line of '${f}' is missing from the consolidated dev.md; nothing was changed"
  done <"${f}"
done

mv "${tmp}" "${DEV_MD}"
trap - EXIT
for f in "${ordered[@]}"; do
  rm -- "${f}"
  echo "Consolidated $(basename "${f}")"
done
echo "Consolidated ${#ordered[@]} fragment(s) into dev.md."
