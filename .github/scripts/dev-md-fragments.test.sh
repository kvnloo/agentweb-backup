#!/usr/bin/env bash
#
# Tests for dev-md-consolidate.sh and dev-md-guard.sh (ENG-809).
#
#   bash .github/scripts/dev-md-fragments.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLIDATE="${SCRIPT_DIR}/dev-md-consolidate.sh"
GUARD="${SCRIPT_DIR}/dev-md-guard.sh"

failures=0
checks=0
pass() { checks=$((checks + 1)); printf '  ok   %s\n' "$1"; }
fail() { checks=$((checks + 1)); failures=$((failures + 1)); printf '  FAIL %s\n' "$1"; }
expect() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }

WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT

git_repo() {
  local d="$1"
  git init -q -b main "${d}"
  git -C "${d}" config user.email t@example.com
  git -C "${d}" config user.name t
  git -C "${d}" config commit.gpgsign false
  printf '## ENG-1: oldest existing (2026-01-01)\n\nold body\n' >"${d}/dev.md"
  mkdir -p "${d}/dev/pending"
  printf '# pending fragments\n' >"${d}/dev/pending/README.md"
  git -C "${d}" add -A
  git -C "${d}" commit -q -m init
}

frag() { # dir name date title body
  printf '## %s (%s)\n\n%s\n' "$4" "$3" "$5" >"$1/dev/pending/$2.md"
}

echo 'AC1: two concurrent fragment PRs merge without conflict'
R="${WORK}/ac1"; git_repo "${R}"
git -C "${R}" checkout -q -b a
frag "${R}" eng-10-a 2026-10-01 'ENG-10: a' 'body a'
git -C "${R}" add -A; git -C "${R}" commit -q -m a
git -C "${R}" checkout -q main
git -C "${R}" checkout -q -b b
frag "${R}" eng-11-b 2026-10-02 'ENG-11: b' 'body b'
git -C "${R}" add -A; git -C "${R}" commit -q -m b
git -C "${R}" checkout -q main
rc=0; git -C "${R}" merge -q --no-edit a >/dev/null 2>&1 || rc=$?
expect 'AC1: first fragment PR merges' "${rc}" 0
rc=0; git -C "${R}" merge -q --no-edit b >/dev/null 2>&1 || rc=$?
expect 'AC1: second fragment PR merges with no manual resolution' "${rc}" 0

echo 'Contrast: the old line-1 prepend convention conflicts'
R0="${WORK}/old"; git_repo "${R0}"
git -C "${R0}" checkout -q -b a
{ printf '## ENG-10: a (2026-10-01)\n\na\n\n'; cat "${R0}/dev.md"; } >"${R0}/x" && mv "${R0}/x" "${R0}/dev.md"
git -C "${R0}" commit -qam a
git -C "${R0}" checkout -q main; git -C "${R0}" checkout -q -b b
{ printf '## ENG-11: b (2026-10-02)\n\nb\n\n'; cat "${R0}/dev.md"; } >"${R0}/x" && mv "${R0}/x" "${R0}/dev.md"
git -C "${R0}" commit -qam b
git -C "${R0}" checkout -q main
git -C "${R0}" merge -q --no-edit a >/dev/null 2>&1
rc=0; git -C "${R0}" merge -q --no-edit b >/dev/null 2>&1 || rc=$?
if [ "${rc}" -ne 0 ]; then pass 'old convention: second prepend conflicts (the bug)'; else fail 'old convention unexpectedly merged'; fi
git -C "${R0}" merge --abort >/dev/null 2>&1 || true

echo 'AC3/AC4: consolidation after merge'
frag "${R}" eng-12-c 2026-10-02 'ENG-12: c' 'body c'
out=$(bash "${CONSOLIDATE}" "${R}" 2>&1); rc=$?
expect 'AC3: consolidation succeeds' "${rc}" 0
headings=$(grep '^## ' "${R}/dev.md" | tr '\n' '|')
expect 'AC3: newest first, same-date ordered by filename desc, existing entries after' \
  "${headings}" '## ENG-12: c (2026-10-02)|## ENG-11: b (2026-10-02)|## ENG-10: a (2026-10-01)|## ENG-1: oldest existing (2026-01-01)|'
for b in 'body a' 'body b' 'body c' 'old body'; do
  if grep -qxF "${b}" "${R}/dev.md"; then pass "AC4: '${b}' present, not lost"; else fail "AC4: '${b}' lost"; fi
done
left=$(find "${R}/dev/pending" -name '*.md' ! -name README.md | wc -l | tr -d ' ')
expect 'AC3: consolidated fragments removed from dev/pending' "${left}" 0
if [ -f "${R}/dev/pending/README.md" ]; then pass 'README.md is never consumed'; else fail 'README.md was consumed'; fi
if grep -q 'Consolidated 3 fragment' <<<"${out}"; then pass 'run reports fragment count'; else fail "run did not report count: ${out}"; fi

echo 'Idempotence'
before=$(cat "${R}/dev.md")
rc=0; bash "${CONSOLIDATE}" "${R}" >/dev/null 2>&1 || rc=$?
expect 'nothing pending exits 0' "${rc}" 0
expect 'nothing pending leaves dev.md unchanged' "$(cat "${R}/dev.md")" "${before}"

echo 'AC4: a malformed fragment fails loudly and changes nothing'
frag "${R}" eng-13-good 2026-10-03 'ENG-13: good' 'body good'
printf 'no heading here\n' >"${R}/dev/pending/eng-14-bad.md"
rc=0; err=$(bash "${CONSOLIDATE}" "${R}" 2>&1) || rc=$?
expect 'malformed fragment fails the run' "${rc}" 1
if grep -q 'DEV_MD_CONSOLIDATE_FAILED' <<<"${err}"; then pass 'failure is greppable'; else fail "no marker: ${err}"; fi
expect 'dev.md untouched on failure' "$(cat "${R}/dev.md")" "${before}"
if [ -f "${R}/dev/pending/eng-13-good.md" ]; then pass 'valid fragment not deleted when run fails'; else fail 'valid fragment deleted on failed run'; fi
printf '## ENG-14: missing date\n\nx\n' >"${R}/dev/pending/eng-14-bad.md"
rc=0; bash "${CONSOLIDATE}" "${R}" >/dev/null 2>&1 || rc=$?
expect 'heading without a date fails' "${rc}" 1
: >"${R}/dev/pending/eng-14-bad.md"
rc=0; bash "${CONSOLIDATE}" "${R}" >/dev/null 2>&1 || rc=$?
expect 'empty fragment fails' "${rc}" 1
if ls "${R}"/dev.md.* >/dev/null 2>&1; then fail 'temp file leaked'; else pass 'no temp file left behind'; fi

echo 'AC2: the guard'
rc=0; err=$(printf 'backend/a.ts\ndev.md\n' | bash "${GUARD}" swarm/eng-1-x 2>&1) || rc=$?
expect 'AC2: a PR editing dev.md fails' "${rc}" 1
if grep -qF 'dev/pending/<eng-id>-<slug>.md' <<<"${err}"; then pass 'AC2: the failure names the fragment path to use'; else fail "no path in message: ${err}"; fi
rc=0; printf 'backend/a.ts\ndev/pending/eng-1-x.md\n' | bash "${GUARD}" swarm/eng-1-x >/dev/null 2>&1 || rc=$?
expect 'a fragment-only PR passes' "${rc}" 0
rc=0; printf 'docs/dev.md\n' | bash "${GUARD}" swarm/eng-1-x >/dev/null 2>&1 || rc=$?
expect 'a nested */dev.md is not the root dev.md' "${rc}" 0

S="${WORK}/status"
printf 'modified\tdev.md\nremoved\tdev/pending/eng-1-x.md\n' >"${S}"
rc=0; printf 'dev.md\ndev/pending/eng-1-x.md\n' | bash "${GUARD}" automation/dev-md-consolidate "${S}" >/dev/null 2>&1 || rc=$?
expect 'the consolidation PR is allowed' "${rc}" 0
printf 'modified\tdev.md\nmodified\tbackend/a.ts\n' >"${S}"
rc=0; printf 'dev.md\nbackend/a.ts\n' | bash "${GUARD}" automation/dev-md-consolidate "${S}" >/dev/null 2>&1 || rc=$?
expect 'the consolidation branch name cannot smuggle other changes' "${rc}" 1
printf 'modified\tdev.md\nadded\tdev/pending/eng-2-y.md\n' >"${S}"
rc=0; printf 'dev.md\ndev/pending/eng-2-y.md\n' | bash "${GUARD}" automation/dev-md-consolidate "${S}" >/dev/null 2>&1 || rc=$?
expect 'the consolidation PR may only REMOVE fragments' "${rc}" 1
rc=0; printf 'dev.md\n' | bash "${GUARD}" automation/dev-md-consolidate >/dev/null 2>&1 || rc=$?
expect 'the exemption fails closed without per-file status' "${rc}" 1

printf '\n%s checks run, %s failed\n' "${checks}" "${failures}"
[ "${failures}" -eq 0 ]
