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
#   pull.json          the body returned for `gh api .../pulls/<n>` (ENG-1063).
#                      Defaults to an ordinary human-authored PR, so the many
#                      cases that never mention an override need no fixture.
#
# There is deliberately no collaborators/permission fixture: the gate authorizes
# an override from the `author_association` already on the comment, because this
# workflow's token is `contents: read` and cannot call that endpoint at all.
# Mocking an endpoint the gate never reaches would assert a capability
# production does not have.

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
  */pulls/*)
    code=0
    [ -f "${MOCK_DIR}/pull_exit" ] && code=$(cat "${MOCK_DIR}/pull_exit")
    if [ "$code" != "0" ]; then
      printf 'mock gh: simulated pulls API failure\n' >&2
      exit "$code"
    fi
    emit "$(cat "${MOCK_DIR}/pull.json" 2>/dev/null \
      || printf '{"user":{"login":"harshit-argusoft"},"head":{"ref":"harshit/some-fix"},"body":"An ordinary hand-written PR."}')"
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

# greptile_comments_with_reply <score> <sha> -> the verdict comment PLUS a later,
# footerless Greptile reply. Replying to a Greptile finding makes it answer in
# thread, so the newest Greptile comment is not the verdict — the shape that
# stalled agentweb#2266 until the 20-minute timeout despite a landed 5/5.
greptile_comments_with_reply() {
  jq -n --arg body "$(greptile_body "$(score_line "$1")" "$(footer "$2")")" '
    [
      {id: 1, created_at: "2026-07-29T15:00:00Z", updated_at: "2026-07-29T15:00:00Z",
       user: {login: "harshmoney123", type: "User"}, body: "looks good to me"},
      {id: 3, created_at: "2026-07-29T15:39:33Z", updated_at: "2026-07-29T15:47:46Z",
       user: {login: "greptile-apps[bot]", type: "Bot"}, body: $body},
      {id: 4, created_at: "2026-07-29T16:10:00Z", updated_at: "2026-07-29T16:10:00Z",
       user: {login: "greptile-apps[bot]", type: "Bot"},
       body: "That is a good, well-reasoned explanation. I am satisfied — no further action needed on that thread."}
    ]'
}

# --- ENG-1063 override fixtures --------------------------------------------

# The reason string every valid-override case uses. Long enough to clear the
# minimum, and phrased the way a real override actually reads.
REASON='accepting two P2 nits, shipping now'

# override_line <sha-token> <reason>
override_line() { printf '/greptile-override %s %s' "$1" "$2"; }

# add_comment <comments-json> <login> <type> <body> [author_association]
# -> that array plus one more comment, newest last (the gate takes the newest
# override candidate). The association defaults to MEMBER, which is what every
# human on this repo actually comments as — verified against live comments on
# #2290/#2300/#2310/#2315/#2318, including Harsha's own.
# Passing an explicit empty association omits the key entirely, which is the
# real shape of "absent" — `${5:-...}` would have substituted the default for
# it and silently turned the fail-closed case into a passing one.
add_comment() {
  jq -n --argjson base "$1" --arg login "$2" --arg type "$3" --arg body "$4" \
        --arg assoc "${5-MEMBER}" '
    $base + [ {id: 99, created_at: "2026-07-29T16:30:00Z", updated_at: "2026-07-29T16:30:00Z",
               user: {login: $login, type: $type}, body: $body}
              + (if $assoc == "" then {} else {author_association: $assoc} end) ]'
}

# pull_json <author-login> <head-ref> <body>
pull_json() {
  jq -n --arg login "$1" --arg ref "$2" --arg body "$3" \
    '{user: {login: $login}, head: {ref: $ref}, body: $body}'
}

# set_pull <mock_dir> <json>
set_pull() { printf '%s' "$2" >"$1/pull.json"; }

# override_case <mock_dir> <greptile-comments-json> <login> <type> <sha-token> <reason> [assoc]
override_case() {
  local dir="$1" base="$2" login="$3" type="$4" sha="$5" reason="$6" assoc="${7-MEMBER}"
  set_comments "${dir}" 1 "$(add_comment "${base}" "${login}" "${type}" \
    "$(override_line "${sha}" "${reason}")" "${assoc}")"
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

# Regression (agentweb#2266): a landed 5/5 must still be found when Greptile has
# posted a later, footerless reply in thread. Selecting the newest Greptile
# comment locked onto the reply, reported "no verdict footer yet", and polled to
# the 20-minute timeout on a PR Greptile had already passed.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments_with_reply '5/5' "${HEAD}")"
run_gate "$M"
check 'reply-after-verdict: a 5/5 behind a threaded reply still passes' 0 'Greptile 5/5'

# The same shape must not become a way to sneak a bad score through: the verdict
# comment is still the one that decides.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments_with_reply '3/5' "${HEAD}")"
run_gate "$M"
check 'reply-after-verdict: a 3/5 behind a threaded reply still fails' 1 'Greptile scored 3/5'

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
# ENG-915 anti-misfire: a landed verdict for ANOTHER commit proves Greptile is
# working, so timing out here is a slow re-review and must NOT be reported as
# an outage. If this ever returns 75 the caller would run the suite on a PR
# whose review is seconds away — the exact case the gate exists to skip.
check 'ENG-915: a superseded verdict proves Greptile is alive, so never UNAVAILABLE' 1 \
  'NOT reporting this as UNAVAILABLE'

# ---------------------------------------------------------------------------
# ENG-915 — REFUSED and UNAVAILABLE must never be confusable
# ---------------------------------------------------------------------------
#
# The whole outage bypass rests on one property: a review Greptile actually
# scored can never present as an outage. These pin it from both directions.
#
# Every scored verdict for our head decides immediately and exits before the
# deadline is consulted, so no score can reach the UNAVAILABLE path.
for bad_score in '0/5' '1/5' '2/5' '3/5' '4/5'; do
  M=$(new_mock_dir)
  set_comments "$M" 1 "$(greptile_comments "${bad_score}" "${HEAD}")"
  run_gate "$M"
  check "ENG-915: ${bad_score} on our head is REFUSED (1), never UNAVAILABLE (75)" 1 \
    "Greptile scored ${bad_score%%/*}/5"
done

# An unparseable verdict is a refusal too: it is evidence we cannot read, not
# evidence that never arrived. Letting it bypass would turn a malformed comment
# into a way of skipping review.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments 'not-a-score' "${HEAD}")"
run_gate "$M"
check 'ENG-915: an unparseable verdict for our head is REFUSED, never UNAVAILABLE' 1 ''

# And the genuine outage: nothing from Greptile at all, for any commit.
M=$(new_mock_dir)
set_comments "$M" 1 '[]'
run_gate "$M"
check 'ENG-915: a total absence of Greptile is UNAVAILABLE' 75 'verdict=unavailable'
check 'ENG-915: the outage verdict says no verdict was seen for ANY commit' 75 \
  'for ANY commit on this PR'

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
check 'AC3: no Greptile review yet never passes (UNAVAILABLE, not a pass)' 75 'no Greptile review comment'

# AC3 — a comment exists but carries no verdict footer yet (Greptile posts a
# placeholder while reviewing). Pending, never a pass.
M=$(new_mock_dir)
set_comments "$M" 1 "$(comments_json 'greptile-apps[bot]' 'Bot' 'Greptile is reviewing this pull request...')"
run_gate "$M"
check 'AC3: a placeholder comment with no verdict footer never passes' 75 \
  'no '"'"'Last reviewed commit'"'"' verdict footer yet'

# AC3 — an impostor: a non-bot account posting a perfect-looking Greptile body
# must not satisfy the gate.
M=$(new_mock_dir)
set_comments "$M" 1 "$(comments_json 'greptile-fan' 'User' \
  "$(greptile_body "$(score_line '5/5')" "$(footer "${HEAD}")")")"
run_gate "$M"
check 'AC3: a non-bot impostor comment does not satisfy the gate' 75 \
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
check 'AC4: a failing GitHub API call never passes' 75 'timed out'
check 'AC4: the API error text is surfaced, not swallowed' 75 'simulated API failure'

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
# ENG-1063 — the human override
# ---------------------------------------------------------------------------
#
# Measured 2026-07-27..08-10: 35 gate failures to 32 passes, none of them an
# outage — ten of fourteen sampled were 4/5. A 4/5 carrying only P2s is a
# judgement call, and there was no way to make it: `enforce_admins` is on, and
# the only admins are harshmoney123 and agentwebdeployer, so the Argusoft team
# (push) had no lever at all. The override lives here rather than in branch
# protection precisely so it reaches write-level collaborators without handing
# anyone a bypass over the *test* checks too.

printf '\nENG-1063 override\n'

# AC1 — a valid override passes a real refusal, and says who authorized it.
M=$(new_mock_dir)
override_case "$M" "$(greptile_comments '4/5' "${HEAD}")" \
  'harshit-argusoft' 'User' "${HEAD:0:12}" "${REASON}"
run_gate "$M"
check 'AC1: a valid override passes a 4/5' 0 'OVERRIDE ACCEPTED'
check 'AC1: the override names who authorized it' 0 'harshit-argusoft'
check 'AC1: the override names the score it overrode' 0 '4/5'
check 'AC1: the override records the stated reason' 0 "${REASON}"
check 'AC1: the override names the head it was pinned to' 0 "${HEAD}"

# AC1 — it also rescues an outage. A gate that can only forgive a landed
# verdict leaves the team hard-blocked on the days Greptile never answers,
# which is the failure this whole issue is about.
M=$(new_mock_dir)
override_case "$M" '[]' 'harshit-argusoft' 'User' "${HEAD:0:12}" "${REASON}"
run_gate "$M"
check 'AC1: an override also rescues a Greptile outage' 0 'OVERRIDE ACCEPTED'
check 'AC1: ...and records that no verdict had landed' 0 'no Greptile verdict had landed'

# AC1 — every association meaning "has access to this repo" is sufficient.
for assoc in 'OWNER' 'MEMBER' 'COLLABORATOR'; do
  M=$(new_mock_dir)
  override_case "$M" "$(greptile_comments '3/5' "${HEAD}")" \
    'harshit-argusoft' 'User' "${HEAD:0:12}" "${REASON}" "${assoc}"
  run_gate "$M"
  check "AC1: ${assoc} may override" 0 'OVERRIDE ACCEPTED'
done

# AC2 — pinned to the head. An override naming a superseded commit is exactly
# the shape that would otherwise let a human bless commit A and someone push
# commit B underneath it.
M=$(new_mock_dir)
override_case "$M" "$(greptile_comments '4/5' "${HEAD}")" \
  'harshit-argusoft' 'User' "${STALE:0:12}" "${REASON}"
run_gate "$M"
check 'AC2: an override pinned to a superseded commit does not pass' 1 'Greptile scored 4/5'
check 'AC2: ...and says why it was rejected' 1 'does not match the current head'

# AC2 — a too-short prefix is rejected rather than prefix-matched loosely. Six
# hex characters collide often enough across a repo this size to be no proof at
# all that the human was looking at this head.
M=$(new_mock_dir)
override_case "$M" "$(greptile_comments '4/5' "${HEAD}")" \
  'harshit-argusoft' 'User' "${HEAD:0:6}" "${REASON}"
run_gate "$M"
check 'AC2: a 6-character SHA prefix is too short to pin an override' 1 'at least 7 hex characters'

# AC2 — the full 40-char SHA works, and case does not matter.
M=$(new_mock_dir)
upper_head="$(printf '%s' "${HEAD}" | tr '[:lower:]' '[:upper:]')"
override_case "$M" "$(greptile_comments '4/5' "${HEAD}")" \
  'harshit-argusoft' 'User' "${upper_head}" "${REASON}"
run_gate "$M"
check 'AC2: an uppercase full SHA still pins the override' 0 'OVERRIDE ACCEPTED'

# AC3 — automation cannot override itself. The swarm authors PRs as
# harshmoney123, the same principal as human-Harsha, so "who commented" cannot
# separate them. The PR does: a swarm/autofix head branch, or an
# Execution-Actor attribution line, marks the work as machine-authored, and
# machine-authored work has to earn its 5/5.
for ref in 'swarm/eng-1063-x' 'autofix/eng-999-y'; do
  M=$(new_mock_dir)
  override_case "$M" "$(greptile_comments '4/5' "${HEAD}")" \
    'harshmoney123' 'User' "${HEAD:0:12}" "${REASON}"
  set_pull "$M" "$(pull_json 'harshmoney123' "${ref}" 'a machine-authored PR')"
  run_gate "$M"
  check "AC3: a ${ref%%/*}/* PR cannot be overridden" 1 'Greptile scored 4/5'
  check "AC3: ...naming the automation signal for ${ref%%/*}/*" 1 'automation-authored'
done

# AC3 — the attribution block is the second, independent signal: a machine
# branch renamed by hand must not become overridable.
M=$(new_mock_dir)
override_case "$M" "$(greptile_comments '4/5' "${HEAD}")" \
  'harshmoney123' 'User' "${HEAD:0:12}" "${REASON}"
set_pull "$M" "$(pull_json 'harshmoney123' 'harsha/looks-hand-written' \
  'Some description.

Accountable-Owner: Harsha Vankayalapati
Execution-Actor: claude-code
Linear-Issue: ENG-1063')"
run_gate "$M"
check 'AC3: an Execution-Actor attribution block blocks the override' 1 'automation-authored'
check 'AC3: ...even on a hand-looking branch name' 1 'Execution-Actor'

# AC4 — a Bot cannot override, however well-formed the comment is.
M=$(new_mock_dir)
override_case "$M" "$(greptile_comments '4/5' "${HEAD}")" \
  'some-app[bot]' 'Bot' "${HEAD:0:12}" "${REASON}"
run_gate "$M"
check 'AC4: a Bot account cannot override' 1 'Greptile scored 4/5'
check 'AC4: ...naming it as a non-human account' 1 'not a human account'

# AC4 — an outsider cannot override. CONTRIBUTOR means "has landed a commit
# here at some point", which is not access, and NONE is a passer-by.
for assoc in 'CONTRIBUTOR' 'FIRST_TIME_CONTRIBUTOR' 'NONE'; do
  M=$(new_mock_dir)
  override_case "$M" "$(greptile_comments '4/5' "${HEAD}")" \
    'drive-by' 'User' "${HEAD:0:12}" "${REASON}" "${assoc}"
  run_gate "$M"
  check "AC4: ${assoc} cannot override" 1 'is not an org member or repository collaborator'
done

# AC4 — the deploy identity is an admin, and is exactly the kind of shared
# machine account that must never be able to wave work through.
M=$(new_mock_dir)
override_case "$M" "$(greptile_comments '4/5' "${HEAD}")" \
  'agentwebdeployer' 'User' "${HEAD:0:12}" "${REASON}"
run_gate "$M"
check 'AC4: a known automation account cannot override despite being admin' 1 \
  'a known automation account'

# AC4 — an absent or unrecognised association fails closed rather than being
# read as "probably fine". An override is only as good as the proof that its
# author was entitled to make it, so no proof means no override.
for assoc in '' 'SOMETHING_NEW'; do
  M=$(new_mock_dir)
  override_case "$M" "$(greptile_comments '4/5' "${HEAD}")" \
    'nobody-knows' 'User' "${HEAD:0:12}" "${REASON}" "${assoc}"
  run_gate "$M"
  check "AC4: association '${assoc:-absent}' fails the override closed" 1 \
    'is not an org member or repository collaborator'
done

# AC3/AC4 — if the PR metadata cannot be read at all, the automation check
# cannot be performed, so the override fails closed. Otherwise an API blip
# would be the one condition under which a swarm PR becomes overridable.
M=$(new_mock_dir)
override_case "$M" "$(greptile_comments '4/5' "${HEAD}")" \
  'harshit-argusoft' 'User' "${HEAD:0:12}" "${REASON}"
printf '1\n' >"${M}/pull_exit"
run_gate "$M"
check 'AC3: an unreadable PR fails the override closed' 1 'Greptile scored 4/5'
check 'AC3: ...saying the PR could not be shown to be human-authored' 1 \
  'could not be read'

# AC5 — a reason is mandatory, and a token one does not count. The reason is
# the whole audit value of the mechanism.
M=$(new_mock_dir)
set_comments "$M" 1 "$(add_comment "$(greptile_comments '4/5' "${HEAD}")" \
  'harshit-argusoft' 'User' "/greptile-override ${HEAD:0:12}")"
run_gate "$M"
check 'AC5: an override with no reason is rejected' 1 'no reason was given'

M=$(new_mock_dir)
override_case "$M" "$(greptile_comments '4/5' "${HEAD}")" \
  'harshit-argusoft' 'User' "${HEAD:0:12}" 'lgtm'
run_gate "$M"
check 'AC5: a one-word reason is too short to count' 1 'shorter than 12 characters'

# AC6 — the load-bearing safety property. Someone quoting the syntax in a
# review thread must not be able to fail a PR that Greptile scored 5/5. An
# invalid override is a no-op plus a log line, never a verdict.
M=$(new_mock_dir)
set_comments "$M" 1 "$(add_comment "$(greptile_comments '5/5' "${HEAD}")" \
  'harshit-argusoft' 'User' \
  'To force this through you would comment:

/greptile-override <sha> <why you are accepting the findings>

...but here we should just fix it.')"
run_gate "$M"
check 'AC6: a quoted override in prose does not break a passing 5/5' 0 'PASS'

# AC6 — and the same stray text on a failing PR still fails, with the reason
# the override was ignored visible in the log rather than silently swallowed.
M=$(new_mock_dir)
set_comments "$M" 1 "$(add_comment "$(greptile_comments '4/5' "${HEAD}")" \
  'harshit-argusoft' 'User' '/greptile-override <sha> <why>')"
run_gate "$M"
check 'AC6: a malformed override still fails the gate' 1 'Greptile scored 4/5'
check 'AC6: ...and says why it was not honoured' 1 'override ignored'

# AC6 — an override mid-sentence is not a command. Only a line that begins with
# the marker counts, so ordinary prose mentioning it stays inert.
M=$(new_mock_dir)
set_comments "$M" 1 "$(add_comment "$(greptile_comments '4/5' "${HEAD}")" \
  'harshit-argusoft' 'User' "we could use /greptile-override ${HEAD:0:12} but let us not")"
run_gate "$M"
check 'AC6: a mid-sentence mention is not an override' 1 'Greptile scored 4/5'

# AC6 — an override must not rescue evidence the gate cannot read. An
# unparseable Greptile comment means this script does not understand what it is
# looking at, which is a gate defect to fix, not a review finding to accept.
M=$(new_mock_dir)
override_case "$M" "$(comments_json 'greptile-apps[bot]' 'Bot' \
  "$(greptile_body 'Confidence Score: unavailable' "$(footer "${HEAD}")")")" \
  'harshit-argusoft' 'User' "${HEAD:0:12}" "${REASON}"
run_gate "$M" GREPTILE_GATE_TIMEOUT_SECONDS='120'
check 'AC6: an override does not rescue an unparseable verdict' 1 'unparseable Greptile verdict'

# AC8 — the normal path is untouched: with no override anywhere, a 5/5 still
# passes and a 4/5 still fails, and neither consults the PR or permission APIs.
M=$(new_mock_dir)
set_comments "$M" 1 "$(greptile_comments '5/5' "${HEAD}")"
run_gate "$M"
check 'AC8: a 5/5 with no override present still passes' 0 'PASS'

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
