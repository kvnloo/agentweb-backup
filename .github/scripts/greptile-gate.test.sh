#!/usr/bin/env bash
#
# Tests for .github/scripts/greptile-gate.sh (ENG-754).
#
# `gh` is replaced with a scripted mock on PATH, so every branch of the gate
# runs for real without touching GitHub. Run with:
#
#   bash .github/scripts/greptile-gate.test.sh
#
# The final case is a regression proof: it runs the *previous* inline workflow
# logic (the check-run poller) against a mock where Greptile's check-run is
# `success` while its comment says 3/5, and asserts that the old code exited 0.
# That is the false green this change removes — the shape ENG-754 describes.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE_SCRIPT="${SCRIPT_DIR}/greptile-gate.sh"

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

HEAD='0123456789abcdef0123456789abcdef01234567'
STALE='fedcba9876543210fedcba9876543210fedcba98'

# ---------------------------------------------------------------------------
# Mock gh
# ---------------------------------------------------------------------------
#
# Fixtures live in $GREPTILE_MOCK_DIR:
#   comments_<n>.json  the body returned for the Nth `gh api .../comments` call
#                      (the highest-numbered file repeats once exhausted, which
#                      is how an in-place comment edit is simulated: the same
#                      comment id/createdAt with a new body)
#   comments_exit      optional exit code for the comments call (default 0)
#   checkruns.json     the body returned for `gh api .../check-runs` (used only
#                      by the old-logic regression case)

install_mock_gh() {
  mkdir -p "${WORKDIR}/bin"
  cat >"${WORKDIR}/bin/gh" <<'MOCK'
#!/usr/bin/env bash
MOCK_DIR="${GREPTILE_MOCK_DIR:?GREPTILE_MOCK_DIR must be set}"

# Find the request path among the args (skips flags like --paginate/--jq).
url=''
jq_filter=''
prev=''
for arg in "$@"; do
  case "$arg" in
    repos/*) [ -z "$url" ] && url="$arg" ;;
  esac
  if [ "$prev" = "--jq" ]; then jq_filter="$arg"; fi
  prev="$arg"
done

emit() {
  if [ -n "$jq_filter" ]; then
    printf '%s' "$1" | jq -r "$jq_filter"
  else
    printf '%s' "$1"
  fi
}

case "$url" in
  *check-runs*)
    emit "$(cat "${MOCK_DIR}/checkruns.json" 2>/dev/null || printf '{"check_runs":[]}')"
    ;;
  *comments*)
    code=0
    [ -f "${MOCK_DIR}/comments_exit" ] && code=$(cat "${MOCK_DIR}/comments_exit")
    if [ "$code" != "0" ]; then
      printf 'mock gh: simulated API failure\n' >&2
      exit "$code"
    fi
    # A successful call that still writes to stderr (gh warnings, deprecation
    # notices). Must not contaminate the JSON on stdout.
    [ -f "${MOCK_DIR}/comments_stderr" ] && cat "${MOCK_DIR}/comments_stderr" >&2
    n=0
    [ -f "${MOCK_DIR}/comments_calls" ] && n=$(cat "${MOCK_DIR}/comments_calls")
    n=$(( n + 1 ))
    echo "$n" >"${MOCK_DIR}/comments_calls"
    file="${MOCK_DIR}/comments_${n}.json"
    if [ ! -f "$file" ]; then
      # Highest-numbered fixture repeats.
      file="$(ls "${MOCK_DIR}"/comments_[0-9]*.json 2>/dev/null | sort -V | tail -n 1)"
    fi
    emit "$(cat "$file" 2>/dev/null || printf '[]')"
    ;;
  *)
    printf 'mock gh: unhandled url %s\n' "$url" >&2
    exit 64
    ;;
esac
MOCK
  chmod +x "${WORKDIR}/bin/gh"
}

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

new_mock_dir() { mktemp -d "${WORKDIR}/mock.XXXXXX"; }

# greptile_body <score-line> <footer-line>
# Reproduces the real comment shape verified on agentweb#2215/#2219.
greptile_body() {
  printf '<h3>Greptile Summary</h3>\n\nSome prose about the change.\n\n%s\n\nThe PR appears safe to merge.\n\n<!-- greptile_other_comments_section -->\n\n%s' \
    "$1" "$2"
}

score_line() { printf '<h3>Confidence Score: %s</h3>' "$1"; }

# footer <sha> [review-count]
footer() {
  printf '<sub>Reviews (%s): Last reviewed commit: ["fix: something..."](https://github.com/agentwebpro/agentweb/commit/%s) | [Re-trigger Greptile](https://app.greptile.com/api/retrigger?id=1)</sub>' \
    "${2:-2}" "$1"
}

# set_comments <mock_dir> <call_index> <json>
set_comments() { printf '%s' "$3" >"$1/comments_$2.json"; }

# comments_json <login> <type> <body>  -> a one-comment array, plus noise
# comments from a human and another bot so the selector is actually exercised.
comments_json() {
  jq -n --arg login "$1" --arg type "$2" --arg body "$3" '
    [
      {id: 1, created_at: "2026-07-29T15:00:00Z", updated_at: "2026-07-29T15:00:00Z",
       user: {login: "harshmoney123", type: "User"}, body: "looks good to me"},
      {id: 2, created_at: "2026-07-29T15:01:00Z", updated_at: "2026-07-29T15:01:00Z",
       user: {login: "linear-code[bot]", type: "Bot"}, body: "ENG-754 linked"},
      {id: 3, created_at: "2026-07-29T15:39:33Z", updated_at: "2026-07-29T15:47:46Z",
       user: {login: $login, type: $type}, body: $body}
    ]'
}

# greptile_comments <score> <sha> -> the standard single-Greptile-comment array
greptile_comments() {
  comments_json 'greptile-apps[bot]' 'Bot' \
    "$(greptile_body "$(score_line "$1")" "$(footer "$2")")"
}

# ---------------------------------------------------------------------------
# Runner + assertions
# ---------------------------------------------------------------------------

run_gate() {
  local dir="$1"
  shift
  set +e
  env \
    PATH="${WORKDIR}/bin:${PATH}" \
    GREPTILE_MOCK_DIR="${dir}" \
    REPO='AgentWebPro/agentweb' \
    PR_NUMBER='2222' \
    HEAD_SHA="${HEAD}" \
    GREPTILE_GATE_POLL_SECONDS='1' \
    GREPTILE_GATE_TIMEOUT_SECONDS='1' \
    "$@" \
    bash "${GATE_SCRIPT}" >"${WORKDIR}/out.txt" 2>&1
  LAST_EXIT=$?
  set -e
  LAST_OUTPUT="$(cat "${WORKDIR}/out.txt")"
}

pass() { printf '  ok   %s\n' "$1"; }

check() {
  # check <description> <expected_exit> <expected substring>
  local desc="$1" expected_exit="$2" needle="$3"
  TESTS_RUN=$(( TESTS_RUN + 1 ))

  if [ "${LAST_EXIT}" -ne "${expected_exit}" ]; then
    printf '  FAIL %s\n       expected exit %s, got %s\n       output:\n%s\n' \
      "${desc}" "${expected_exit}" "${LAST_EXIT}" "${LAST_OUTPUT}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    return
  fi

  if [ -n "${needle}" ] && ! printf '%s' "${LAST_OUTPUT}" | grep -qF "${needle}"; then
    printf '  FAIL %s\n       output did not contain: %s\n       output:\n%s\n' \
      "${desc}" "${needle}" "${LAST_OUTPUT}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    return
  fi

  pass "${desc}"
}

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

install_mock_gh
printf 'greptile-gate.sh\n'

# AC1 — a below-5/5 verdict on the current head fails, naming the real score.
# This is the exact shape of agentweb#2219 (3/5) and #2215 (4/5): the check-run
# was green for both.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments '3/5' "${HEAD}")"
run_gate "$M"
check 'AC1: 3/5 on the current head fails the gate' 1 'Greptile scored 3/5'
check 'AC1: the failure names the required score too' 1 'required: 5/5'

M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments '4/5' "${HEAD}")"
run_gate "$M"
check 'AC1: 4/5 on the current head fails the gate' 1 'Greptile scored 4/5'

# AC1 — a true 5/5 on the current head passes.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments '5/5' "${HEAD}")"
run_gate "$M"
check 'AC1: a true 5/5 on the current head passes' 0 'PASS'
check 'AC1: the pass names the head it was verified against' 0 "${HEAD}"

# AC2 — 5/5 against a superseded commit is NOT a pass. It reads as pending
# (Greptile is presumably still reviewing the new head) and then times out.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments '5/5' "${STALE}")"
run_gate "$M"
check 'AC2: 5/5 on a superseded SHA does not pass' 1 'superseded'
check 'AC2: the failure names both SHAs' 1 "${STALE}"

# AC2 — the in-place edit. Greptile never posts a second comment; it rewrites
# the same one, advancing `Reviews (N)` and `Last reviewed commit`. Poll 1 sees
# the stale pointer, poll 2 sees the same comment id now pointing at our head.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments '5/5' "${STALE}")"
set_comments "$M" 2 "$(greptile_comments '5/5' "${HEAD}")"
run_gate "$M" GREPTILE_GATE_TIMEOUT_SECONDS='10'
check 'AC2: an in-place re-review of the same comment is picked up' 0 'PASS'

# AC2 — and the reverse: the re-review lands at 3/5 on our head. Must fail,
# not keep pending.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments '5/5' "${STALE}")"
set_comments "$M" 2 "$(greptile_comments '3/5' "${HEAD}")"
run_gate "$M" GREPTILE_GATE_TIMEOUT_SECONDS='10'
check 'AC2: an in-place re-review that drops to 3/5 fails' 1 'Greptile scored 3/5'

# AC3 — no Greptile comment at all is pending, never a pass.
M=$(new_mock_dir)
set_comments "$M" 1 '[]'
run_gate "$M"
check 'AC3: no Greptile review yet never passes' 1 'no Greptile review comment'

# AC3 — a comment exists but carries no verdict footer yet (Greptile posts a
# placeholder while reviewing). Pending, never a pass.
M=$(new_mock_dir)
set_comments "$M" 1 "$(comments_json 'greptile-apps[bot]' 'Bot' 'Greptile is reviewing this pull request...')"
run_gate "$M"
check 'AC3: a placeholder comment with no verdict footer never passes' 1 \
  'no '"'"'Last reviewed commit'"'"' verdict footer yet'

# AC3 — an impostor: a non-bot account posting a perfect-looking Greptile body
# must not satisfy the gate.
M=$(new_mock_dir)
set_comments "$M" 1 "$(comments_json 'greptile-fan' 'User' \
  "$(greptile_body "$(score_line '5/5')" "$(footer "${HEAD}")")")"
run_gate "$M"
check 'AC3: a non-bot impostor comment does not satisfy the gate' 1 \
  'no Greptile review comment'

# AC4 — a verdict footer for OUR head whose score is missing: fail closed
# immediately, surfacing the raw body. Never fall back to "no score = fine".
M=$(new_mock_dir)
set_comments "$M" 1 "$(comments_json 'greptile-apps[bot]' 'Bot' \
  "$(greptile_body 'Confidence Score: unavailable' "$(footer "${HEAD}")")")"
run_gate "$M" GREPTILE_GATE_TIMEOUT_SECONDS='120'
check 'AC4: a missing score on a reviewed head fails closed' 1 'unparseable Greptile verdict'
check 'AC4: the raw body is surfaced on an unparseable verdict' 1 'Greptile comment body (raw)'
check 'AC4: it fails immediately rather than burning the timeout' 1 'Confidence Score: unavailable'

# AC4 — two Confidence Score values in one body is ambiguous: fail closed
# rather than guessing which one is the verdict.
M=$(new_mock_dir)
set_comments "$M" 1 "$(comments_json 'greptile-apps[bot]' 'Bot' \
  "$(printf '%s\n\n%s\n\n%s' "$(score_line '5/5')" "$(score_line '2/5')" "$(footer "${HEAD}")")")"
run_gate "$M" GREPTILE_GATE_TIMEOUT_SECONDS='120'
check 'AC4: two scores in one body fail closed instead of picking one' 1 \
  'found 2 '"'"'Confidence Score: N/M'"'"' values'

# AC4 — the footer is present but carries no commit pointer. The parser must
# NOT fall back to the score it can see; without a pointer it cannot know which
# commit that score belongs to.
M=$(new_mock_dir)
set_comments "$M" 1 "$(comments_json 'greptile-apps[bot]' 'Bot' \
  "$(greptile_body "$(score_line '5/5')" \
    '<sub>Reviews (2): Last reviewed commit: ["fix: something..."](https://github.com/agentwebpro/agentweb/commit/deadbee) | [Re-trigger Greptile](x)</sub>')")"
run_gate "$M" GREPTILE_GATE_TIMEOUT_SECONDS='120'
check 'AC4: a footer with no 40-hex commit pointer fails closed' 1 \
  'carries no commit/<40-hex> pointer'
check 'AC4: it refuses to fall back to the visible score' 1 'Refusing to fall back'

# AC4 — an off-scale score (Greptile changing its scale) is unexpected, not a
# pass, even though 7 >= 5.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments '7/10' "${HEAD}")"
run_gate "$M" GREPTILE_GATE_TIMEOUT_SECONDS='120'
check 'AC4: an off-scale score fails closed rather than passing on 7 >= 5' 1 \
  'unexpected Greptile scale'

# AC4 — a score above the scale is equally unexpected.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments '6/5' "${HEAD}")"
run_gate "$M" GREPTILE_GATE_TIMEOUT_SECONDS='120'
check 'AC4: a 6/5 score fails closed' 1 'outside the 0-5 range'

# AC4 — a malformed API payload fails closed with the raw response surfaced.
M=$(new_mock_dir)
set_comments "$M" 1 'this is not json'
run_gate "$M" GREPTILE_GATE_TIMEOUT_SECONDS='120'
check 'AC4: a non-JSON API response fails closed' 1 'unparseable response'
check 'AC4: the raw non-JSON response is surfaced' 1 'this is not json'

# AC4 — a GitHub API failure is retried, then fails closed. It never passes.
M=$(new_mock_dir)
printf '1\n' >"${M}/comments_exit"
run_gate "$M"
check 'AC4: a failing GitHub API call never passes' 1 'timed out'
check 'AC4: the API error text is surfaced, not swallowed' 1 'simulated API failure'

# A successful `gh` call that also writes to stderr (warnings, deprecation
# notices) must not be misread as an unparseable response. Folding stderr into
# stdout would turn a healthy 5/5 into a self-inflicted red on a gate whose
# whole design is to fail closed.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments '5/5' "${HEAD}")"
printf 'gh: a warning on stderr\n' >"${M}/comments_stderr"
run_gate "$M"
check 'stderr noise on a successful call does not break parsing' 0 'PASS'

# Config guard — a truncated HEAD_SHA would make every comparison fail for the
# wrong reason, so it is rejected up front rather than silently pending.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments '5/5' "${HEAD}")"
run_gate "$M" HEAD_SHA='0123456'
check 'config: a short HEAD_SHA is rejected up front' 1 'not a full 40-character commit SHA'

# ---------------------------------------------------------------------------
# Regression proof: what the OLD inline logic did with the same inputs.
#
# The previous `Require Greptile Review` step polled the Greptile *check-run*
# and exited 0 on conclusion=success. Greptile marks that check-run success
# regardless of confidence score, so a 3/5 review passed. This case runs that
# old code verbatim against a check-run fixture that is `success` while the
# comment says 3/5, and asserts it exited 0 — the false green ENG-754 removes.
# ---------------------------------------------------------------------------

old_logic() {
  local dir="$1"
  cat >"${WORKDIR}/old-logic.sh" <<'OLD'
set -euo pipefail
for attempt in {1..60}; do
  check_json="$(gh api "repos/${REPO}/commits/${SHA}/check-runs?check_name=Greptile%20Review" --jq '.check_runs[0] // empty')"
  if [ -n "$check_json" ]; then
    status="$(printf '%s' "$check_json" | jq -r '.status')"
    conclusion="$(printf '%s' "$check_json" | jq -r '.conclusion // ""')"
    echo "Greptile Review status=${status} conclusion=${conclusion:-pending} attempt=${attempt}"
    if [ "$status" = "completed" ]; then
      if [ "$conclusion" = "success" ]; then
        exit 0
      fi
      echo "Greptile Review completed with conclusion=${conclusion}"
      exit 1
    fi
  else
    echo "Waiting for Greptile Review check attempt=${attempt}"
  fi
  sleep 0
done
echo "Greptile Review did not complete within 20 minutes."
exit 1
OLD
  set +e
  env PATH="${WORKDIR}/bin:${PATH}" GREPTILE_MOCK_DIR="${dir}" \
    REPO='AgentWebPro/agentweb' SHA="${HEAD}" \
    bash "${WORKDIR}/old-logic.sh" >"${WORKDIR}/out.txt" 2>&1
  LAST_EXIT=$?
  set -e
  LAST_OUTPUT="$(cat "${WORKDIR}/out.txt")"
}

M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments '3/5' "${HEAD}")"
printf '%s' '{"check_runs":[{"status":"completed","conclusion":"success","name":"Greptile Review"}]}' \
  >"${M}/checkruns.json"
old_logic "$M"
check 'regression: the OLD check-run poller passed a 3/5 review (the bug)' 0 'conclusion=success'

# ...and the new gate fails on exactly the same fixture.
run_gate "$M"
check 'regression: the NEW gate fails on the identical 3/5 fixture' 1 'Greptile scored 3/5'

# ---------------------------------------------------------------------------

printf '\n%s test(s), %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ]
