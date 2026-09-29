#!/usr/bin/env bash
#
# Tests for .github/scripts/offline-eval-report.sh and the workflow that runs
# it, .github/workflows/offline-eval.yml (ENG-2195).
#
# `npx` is replaced with a scripted mock on PATH, so every verdict branch runs
# for real without installing the backend.
#
# Run with:  bash .github/scripts/offline-eval-report.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/offline-eval-report.sh"
WORKFLOW="${SCRIPT_DIR}/../workflows/offline-eval.yml"
WORKFLOW_DIR="${SCRIPT_DIR}/../workflows"

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

pass() { TESTS_RUN=$((TESTS_RUN + 1)); printf 'ok    %s\n' "$1"; }
fail() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL  %s\n' "$1"
  shift
  for line in "$@"; do printf '      %s\n' "${line}"; done
}

# The mock stands in for `npx ts-node ... runOfflineEvalSuite.ts --target local
# --out <file>`: it records its arguments and whether EVAL_GATE_BLOCKING reached
# it, prints a report, writes MOCK_VERDICT as the result JSON (none when
# MOCK_VERDICT is empty) and exits MOCK_EXIT.
mkdir -p "${WORKDIR}/bin" "${WORKDIR}/backend"
cat >"${WORKDIR}/bin/npx" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >"${MOCK_ARGS}"
printf '%s\n' "${EVAL_GATE_BLOCKING-unset}" >"${MOCK_BLOCKING}"
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then out="$2"; shift; fi
  shift
done
printf '## Offline eval suite v1: MOCK REPORT\n'
if [ -n "${MOCK_VERDICT}" ] && [ -n "${out}" ]; then
  printf '{"verdict":"%s","mode":"report_only","blocks":false}\n' "${MOCK_VERDICT}" >"${out}"
fi
exit "${MOCK_EXIT}"
MOCK
chmod +x "${WORKDIR}/bin/npx"

# run_case <verdict> <suite exit> — sets RUN_EXIT, RUN_OUT, RUN_SUMMARY.
run_case() {
  local summary="${WORKDIR}/summary.md"
  : >"${summary}"
  RUN_OUT="$(
    PATH="${WORKDIR}/bin:${PATH}" \
      OFFLINE_EVAL_BACKEND_DIR="${WORKDIR}/backend" \
      GITHUB_STEP_SUMMARY="${summary}" \
      EVAL_GATE_BLOCKING=true \
      MOCK_ARGS="${WORKDIR}/args" MOCK_BLOCKING="${WORKDIR}/blocking" \
      MOCK_VERDICT="$1" MOCK_EXIT="$2" \
      bash "${SCRIPT}" 2>&1
  )"
  RUN_EXIT=$?
  RUN_SUMMARY="$(cat "${summary}")"
}

# --- the script ---------------------------------------------------------------

run_case pass 0
if [ "${RUN_EXIT}" -eq 0 ] && [[ "${RUN_SUMMARY}" == *"MOCK REPORT"* ]] && [[ "${RUN_OUT}" != *"::warning"* ]]; then
  pass "pass: exit 0, report in the job summary, no warning"
else
  fail "pass: exit 0, report in the job summary, no warning" "exit=${RUN_EXIT}" "out=${RUN_OUT}" "summary=${RUN_SUMMARY}"
fi

args="$(cat "${WORKDIR}/args")"
if [[ "${args}" == *"--no-install ts-node --transpile-only src/loops/scripts/runOfflineEvalSuite.ts --target local --out "* ]]; then
  pass "runs the suite with --target local and a JSON result file"
else
  fail "runs the suite with --target local and a JSON result file" "args=${args}"
fi

if [ "$(cat "${WORKDIR}/blocking")" = "unset" ]; then
  pass "EVAL_GATE_BLOCKING never reaches the suite, so it can only report"
else
  fail "EVAL_GATE_BLOCKING never reaches the suite, so it can only report" "suite saw EVAL_GATE_BLOCKING=$(cat "${WORKDIR}/blocking")"
fi

for verdict in regression unavailable; do
  run_case "${verdict}" 0
  if [ "${RUN_EXIT}" -eq 0 ] && [[ "${RUN_OUT}" == *"::warning title=Offline eval suite::verdict ${verdict}"* ]]; then
    pass "${verdict}: warning annotation, still exit 0"
  else
    fail "${verdict}: warning annotation, still exit 0" "exit=${RUN_EXIT}" "out=${RUN_OUT}"
  fi
done

for suite_exit in 2 64; do
  run_case "" "${suite_exit}"
  if [ "${RUN_EXIT}" -eq 0 ] && [[ "${RUN_OUT}" == *"produced no verdict (exit ${suite_exit})"* ]]; then
    pass "suite exit ${suite_exit} with no result: warning, still exit 0"
  else
    fail "suite exit ${suite_exit} with no result: warning, still exit 0" "exit=${RUN_EXIT}" "out=${RUN_OUT}"
  fi
done

summary_exit=0
PATH="${WORKDIR}/bin:${PATH}" OFFLINE_EVAL_BACKEND_DIR="${WORKDIR}/backend" \
  GITHUB_STEP_SUMMARY="${WORKDIR}/no-such-dir/summary.md" \
  MOCK_ARGS="${WORKDIR}/args" MOCK_BLOCKING="${WORKDIR}/blocking" MOCK_VERDICT=pass MOCK_EXIT=0 \
  bash "${SCRIPT}" >/dev/null 2>&1 || summary_exit=$?
if [ "${summary_exit}" -ne 0 ]; then
  pass "an unwritable job summary is the one failure"
else
  fail "an unwritable job summary is the one failure" "exit=${summary_exit}"
fi

# Whether workflow file $1 declares an actual dependency on the offline-eval job: a `needs:`
# naming it, inline or as a list item, or a workflow_run trigger naming its display name. A
# workflow that merely mentions the SCRIPT by name (tests.yml runs offline-eval-report.test.sh as
# a step) must not count — that shape was the CodeRabbit-caught false positive (ENG-2195, PR
# #3123 thread 4122002243): a bare `offline-eval-report` substring match flagged tests.yml as a
# dependent of the job it doesn't depend on, and this check could never pass.
depends_on_offline_eval() {
  grep -Eq 'needs:.*\boffline-eval\b|^[[:space:]]*-[[:space:]]*offline-eval[[:space:]]*$|Offline eval \(report-only\)' "$1"
}

# --- the workflow -------------------------------------------------------------

workflow="$(cat "${WORKFLOW}")"

if [[ "${workflow}" == *$'on:\n  pull_request:\n'* ]] && [[ "${workflow}" == *$'\n    paths:\n'* ]] && [[ "${workflow}" != *"push:"* ]] && [[ "${workflow}" != *"schedule:"* ]]; then
  pass "workflow runs on pull requests only, path-filtered"
else
  fail "workflow runs on pull requests only, path-filtered"
fi

for path in 'backend/src/docs/agentModeSystemPrompt.ts' 'backend/src/services/agentMode/llmModelRegistry.ts' \
  'backend/src/services/skillService.ts' 'backend/src/loops/eval/**'; do
  if [[ "${workflow}" == *"- '${path}'"* ]]; then
    pass "path filter covers ${path}"
  else
    fail "path filter covers ${path}"
  fi
done

if [[ "${workflow}" != *"secrets."* ]] && [[ "${workflow}" != *"EVAL_GATE_BLOCKING:"* ]] && [[ "${workflow}" != *"OKAREO"* ]]; then
  pass "workflow passes no secrets and never turns on blocking"
else
  fail "workflow passes no secrets and never turns on blocking"
fi

if [[ "${workflow}" != *"needs:"* ]]; then
  pass "the job waits on nothing"
else
  fail "the job waits on nothing"
fi

# ENG-1039: nothing may wait on this job; it must not sit in front of a build or suite.
dependents=""
for f in "${WORKFLOW_DIR}"/*.yml; do
  [ "${f}" = "${WORKFLOW}" ] && continue
  if depends_on_offline_eval "${f}"; then dependents="${dependents} $(basename "${f}")"; fi
done
if [ -z "${dependents}" ]; then
  pass "no other workflow depends on the offline eval job"
else
  fail "no other workflow depends on the offline eval job" "found in:${dependents}"
fi

# The same check, isolated from the real repo's workflow files: reproduces the exact false
# positive CodeRabbit caught (a workflow merely running the test script by name) and the real
# needs-based shapes it must still catch, so this stays covered even if tests.yml's own content
# changes later.
fixture_dir="${WORKDIR}/fixture-workflows"
mkdir -p "${fixture_dir}"

cat >"${fixture_dir}/mentions-script-name.yml" <<'YML'
jobs:
  ci-scripts-tests:
    steps:
      - name: Run CI/deploy control checks
        run: |
          bash .github/scripts/offline-eval-report.test.sh
YML
if ! depends_on_offline_eval "${fixture_dir}/mentions-script-name.yml"; then
  pass "a workflow that only runs the test script by name is not a dependent"
else
  fail "a workflow that only runs the test script by name is not a dependent" "false-positive reproduced"
fi

cat >"${fixture_dir}/needs-inline.yml" <<'YML'
jobs:
  downstream:
    needs: [detect-changes, offline-eval]
YML
if depends_on_offline_eval "${fixture_dir}/needs-inline.yml"; then
  pass "an inline needs: [...] naming the job is caught"
else
  fail "an inline needs: [...] naming the job is caught"
fi

cat >"${fixture_dir}/needs-list.yml" <<'YML'
jobs:
  downstream:
    needs:
      - offline-eval
YML
if depends_on_offline_eval "${fixture_dir}/needs-list.yml"; then
  pass "a block-style needs: list naming the job is caught"
else
  fail "a block-style needs: list naming the job is caught"
fi

cat >"${fixture_dir}/workflow-run-trigger.yml" <<'YML'
on:
  workflow_run:
    workflows: ["Offline eval (report-only)"]
    types: [completed]
YML
if depends_on_offline_eval "${fixture_dir}/workflow-run-trigger.yml"; then
  pass "a workflow_run trigger naming the job's display name is caught"
else
  fail "a workflow_run trigger naming the job's display name is caught"
fi

printf '\n%d tests, %d failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ]
