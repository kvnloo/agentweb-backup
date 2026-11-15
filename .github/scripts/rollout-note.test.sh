#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034  # check() evals single-quoted assertions late by design
#
# Tests for .github/scripts/rollout-note.sh (ENG-2637). `gh` is mocked on PATH.
# Run with:  bash .github/scripts/rollout-note.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/rollout-note.sh"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT
FAILED=0

mkdir -p "${WORKDIR}/bin"
cat >"${WORKDIR}/bin/gh" <<'MOCK'
#!/usr/bin/env bash
case "$1 $2" in
  "pr list") cat "${MOCK_PRS}" ;;
  "run list") cat "${MOCK_RUNS}" ;;
  *) echo "mock gh: unhandled $*" >&2; exit 99 ;;
esac
MOCK
chmod +x "${WORKDIR}/bin/gh"
export PATH="${WORKDIR}/bin:${PATH}" MOCK_PRS="${WORKDIR}/prs.json" MOCK_RUNS="${WORKDIR}/runs.json"

check() { if eval "$2"; then echo "ok - $1"; else echo "FAIL - $1"; FAILED=1; fi; }

cat >"${MOCK_PRS}" <<'EOF'
[
 {"number": 11, "title": "feat: Meta budget pacing (ENG-101)", "author": {"login": "harshmoney123"},
  "body": "## Summary\nPaces Meta budgets across the day.\nCloses ENG-101", "mergedAt": "2026-10-22T15:00:00Z",
  "files": [{"path": "src/a.ts"}]},
 {"number": 12, "title": "Fix GA4 sync retries", "author": {"login": "harshmoney123"},
  "body": "Refs ENG-102\nRetries GA4 sync on 429.", "mergedAt": "2026-10-22T16:00:00Z",
  "files": [{"path": "src/b.ts"}]},
 {"number": 13, "title": "chore: bump lint config", "author": {"login": "harshmoney123"},
  "body": "ENG-103", "mergedAt": "2026-10-22T16:30:00Z", "files": [{"path": "x.json"}]},
 {"number": 14, "title": "Bump zod", "author": {"login": "app/dependabot"},
  "body": "", "mergedAt": "2026-10-22T16:40:00Z", "files": [{"path": "package.json"}]},
 {"number": 15, "title": "Update runbook", "author": {"login": "harshmoney123"},
  "body": "ENG-104", "mergedAt": "2026-10-22T16:45:00Z", "files": [{"path": "docs/runbook.md"}]},
 {"number": 16, "title": "feat: not deployed yet (ENG-105)", "author": {"login": "harshmoney123"},
  "body": "x", "mergedAt": "2026-10-22T20:00:00Z", "files": [{"path": "src/c.ts"}]}
]
EOF
cat >"${MOCK_RUNS}" <<'EOF'
[{"createdAt": "2026-10-22T17:00:00Z"}, {"createdAt": "2026-10-21T10:00:00Z"}]
EOF

out="$(DATE=2026-10-22 OUT="${WORKDIR}/note.txt" bash "${SCRIPT}")"; rc=$?
check "exit 0 with draft" '[ "${rc}" = 0 ]'
check "marked DRAFT" 'grep -q "^DRAFT" <<<"${out}"'
check "feature 1 listed with ENG id, author, summary" \
  'grep -q "Meta budget pacing (ENG-101) (ENG-101, @harshmoney123, #11)" <<<"${out}" && grep -q "Paces Meta budgets" <<<"${out}"'
check "feature 2 listed with ENG id from body" 'grep -q "Fix GA4 sync retries (ENG-102" <<<"${out}"'
check "chore/dependabot/docs-only/undeployed skipped" \
  '! grep -qE "#1[3456]\)" <<<"${out}"'
check "exactly two items" '[ "$(grep -c "^- " <<<"${out}")" = 2 ]'
check "OUT file written" '[ -s "${WORKDIR}/note.txt" ]'

out="$(DATE=2026-10-20 OUT="${WORKDIR}/empty.txt" bash "${SCRIPT}")"; rc=$?
check "empty day: exit 0, no draft, no file" '[ "${rc}" = 0 ] && [ -z "${out}" ] && [ ! -e "${WORKDIR}/empty.txt" ]'

# Verifier regression: compound headings are structure, not rollout summaries.
for heading in '## What / why' '## SUMMARY & HOW:' '## What, Why'; do
  jq --arg heading "${heading}" '.[0].body = ($heading + "\nPaces Meta budgets across the day.")' \
    "${MOCK_PRS}" >"${WORKDIR}/compound.json"
  cp "${WORKDIR}/compound.json" "${MOCK_PRS}"
  out="$(DATE=2026-10-22 bash "${SCRIPT}")"
  check "compound heading skipped: ${heading}" 'grep -q "^  Paces Meta budgets across the day.$" <<<"${out}"'
done

# Do not discard substantive summaries merely because they start with a heading word.
for summary in 'Summary of the fix' 'What changed: retries now stop' 'Why this matters'; do
  jq --arg summary "${summary}" '.[0].body = $summary' "${MOCK_PRS}" >"${WORKDIR}/substantive.json"
  cp "${WORKDIR}/substantive.json" "${MOCK_PRS}"
  out="$(DATE=2026-10-22 bash "${SCRIPT}")"
  check "substantive summary retained: ${summary}" 'grep -Fq "  ${summary}" <<<"${out}"'
done

# Post-merge verifier 2026-11-15: the Reviewer-First PR template opens with a
# "## Risk: ... | Priority: ..." header and section headings. None of them is a summary.
jq '.[0].body = "## Risk: Low | Priority: Medium\n\n## What was wrong (before)\nBudgets overspent before noon.\n\n## What this fixes (after)\nPaces Meta budgets across the day.\n\n## Linear issue\nENG-101"' \
  "${MOCK_PRS}" >"${WORKDIR}/template.json"
cp "${WORKDIR}/template.json" "${MOCK_PRS}"
out="$(DATE=2026-10-22 bash "${SCRIPT}")"
check "template: risk/priority header is not the summary" '! grep -q "^  Risk:" <<<"${out}"'
check "template: section heading is not the summary" '! grep -qE "^  What (was wrong|this fixes)" <<<"${out}"'
check "template: summary is the sentence under What this fixes" 'grep -q "^  Paces Meta budgets across the day.$" <<<"${out}"'

# A markdown heading is structure whatever its words; without a "What this fixes"
# section the first sentence under the headings is the summary.
jq '.[0].body = "## Risk: Low | ENG-101\n### Context\nPaces Meta budgets across the day."' \
  "${MOCK_PRS}" >"${WORKDIR}/heading.json"
cp "${WORKDIR}/heading.json" "${MOCK_PRS}"
out="$(DATE=2026-10-22 bash "${SCRIPT}")"
check "any markdown heading skipped, first sentence kept" 'grep -q "^  Paces Meta budgets across the day.$" <<<"${out}" && ! grep -qE "^  (Risk|Context)" <<<"${out}"'

# ENG id precedence: title, then a Linear-Issue / Linear issue line, then first mention.
jq '.[1].title = "fix(models): prepare upgrade" | .[1].body = "Out of scope: ENG-1606 stays open.\nRetries GA4 sync on 429.\n\nLinear-Issue: ENG-3016"' \
  "${MOCK_PRS}" >"${WORKDIR}/id.json"
cp "${WORKDIR}/id.json" "${MOCK_PRS}"
out="$(DATE=2026-10-22 bash "${SCRIPT}")"
check "Linear-Issue line beats an earlier body mention" 'grep -q "prepare upgrade (ENG-3016, @harshmoney123, #12)" <<<"${out}"'
check "Linear-Issue line is not the summary" '! grep -q "^  Linear-Issue" <<<"${out}"'

jq '.[1].body = "Follow-up to ENG-1606.\nRetries GA4 sync on 429.\n\n## Linear issue\nENG-3016 (also in the PR title)"' \
  "${MOCK_PRS}" >"${WORKDIR}/id2.json"
cp "${WORKDIR}/id2.json" "${MOCK_PRS}"
out="$(DATE=2026-10-22 bash "${SCRIPT}")"
check "Linear issue heading form beats an earlier body mention" 'grep -q "prepare upgrade (ENG-3016, @harshmoney123, #12)" <<<"${out}"'

jq '.[1].title = "fix(models): prepare upgrade (ENG-102)"' "${MOCK_PRS}" >"${WORKDIR}/id3.json"
cp "${WORKDIR}/id3.json" "${MOCK_PRS}"
out="$(DATE=2026-10-22 bash "${SCRIPT}")"
check "title id beats the Linear issue line" 'grep -q "(ENG-102) (ENG-102, @harshmoney123, #12)" <<<"${out}"'

jq '.[1].title = "fix(models): prepare upgrade" | .[1].body = "Follow-up to ENG-1606."' "${MOCK_PRS}" >"${WORKDIR}/id4.json"
cp "${WORKDIR}/id4.json" "${MOCK_PRS}"
out="$(DATE=2026-10-22 bash "${SCRIPT}")"
check "no title id and no Linear issue line: first body mention" 'grep -q "prepare upgrade (ENG-1606, @harshmoney123, #12)" <<<"${out}"'

exit "${FAILED}"
