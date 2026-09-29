#!/usr/bin/env bash
#
# ENG-2195: run the deterministic offline eval suite on a pull request that
# changes prompt, model, skill or eval sources, and REPORT its verdict. This
# never fails the check on the verdict.
#
#   bash .github/scripts/offline-eval-report.sh        (from the repo root)
#
# Why a report and not a gate
# ---------------------------
# GitHub CI runs builds and short invariant checks; product suites never gate
# merges here (repo CLAUDE.md, ENG-1463), and merge-evidence.sh counts every
# failed check at the head as a failed merge gate. The regression gate itself
# (ENG-2145, backend/docs/evals/OFFLINE_EVAL_GATE.md) belongs to the Atem and
# staging runs, and it may block only when EVAL_GATE_BLOCKING=true and the
# metric's grader is validated. So this script:
#
#   - runs `runOfflineEvalSuite.ts --target local`: the committed baseline, no
#     credentials, no network, no LLM;
#   - removes EVAL_GATE_BLOCKING from the suite's environment, so the suite can
#     only ever report;
#   - writes the suite's Markdown report to the job summary;
#   - raises a warning annotation when the verdict is not `pass`, or when the
#     suite produced no verdict at all;
#   - exits 0 in every one of those cases.
#
# It exits non-zero only when it cannot write the job summary.

set -uo pipefail

BACKEND_DIR="${OFFLINE_EVAL_BACKEND_DIR:-backend}"
SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT
RESULT_JSON="${WORKDIR}/offline-eval-result.json"
REPORT_MD="${WORKDIR}/offline-eval-report.md"

(
  cd "${BACKEND_DIR}" || exit 70
  env -u EVAL_GATE_BLOCKING \
    npx --no-install ts-node --transpile-only src/loops/scripts/runOfflineEvalSuite.ts \
      --target local --out "${RESULT_JSON}"
) >"${REPORT_MD}"
suite_exit=$?

verdict=""
if [ -s "${RESULT_JSON}" ]; then
  verdict="$(jq -r '.verdict // empty' "${RESULT_JSON}" 2>/dev/null)" || verdict=""
fi

{
  printf '# Offline eval suite (report-only, ENG-2195)\n\n'
  printf 'Deterministic --target local run against the committed baseline. '
  printf 'This check never blocks a merge; the gate runs on Atem or staging (backend/docs/evals/OFFLINE_EVAL_GATE.md).\n\n'
  if [ -s "${REPORT_MD}" ]; then
    cat "${REPORT_MD}"
  else
    printf '_The suite printed no report (exit %s)._\n' "${suite_exit}"
  fi
} >>"${SUMMARY_FILE}" || {
  echo "offline-eval-report: cannot write the job summary to ${SUMMARY_FILE}" >&2
  exit 1
}

case "${verdict}" in
  pass)
    echo "Offline eval suite: pass (report-only)."
    ;;
  regression | unavailable)
    echo "::warning title=Offline eval suite::verdict ${verdict} against the committed baseline. Report-only: this check does not block. See the job summary."
    ;;
  *)
    echo "::warning title=Offline eval suite::the suite produced no verdict (exit ${suite_exit}). Report-only: this check does not block. See the job log."
    ;;
esac
exit 0
