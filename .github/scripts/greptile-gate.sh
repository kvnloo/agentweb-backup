#!/usr/bin/env bash
#
# Require a true Greptile 5/5 on the CURRENT pull-request head (ENG-754).
#
# Why this exists
# ---------------
# Greptile's own `Greptile Review` check-run reports conclusion=success for
# every completed review regardless of confidence score. The previous version
# of this gate polled that check-run, so it went green on 3/5 and 4/5 reviews
# that carried live P1 findings (agentweb#2215, #2219, portal#985 twice, all on
# 2026-07-29). The 5/5 bar was enforced only by an agent choosing to open the
# comment and read the score. That is discipline, not a control.
#
# Where the score lives
# ---------------------
# Nowhere structured. Verified against live data on this repo:
#   - check-run `Greptile Review`: conclusion=success, output.summary is
#     "Greptile has reviewed the Pull Request.\n\nN files reviewed, M comments
#     added.", output.text is null. No score, no commit pointer.
#   - the PR review object: state=COMMENTED with an empty body.
#   - the commit status API: no Greptile context.
# So the comment body is the only source, and it is parsed strictly here.
#
# The mechanism detail that breaks naive implementations
# ------------------------------------------------------
# Greptile EDITS ITS ORIGINAL COMMENT IN PLACE. It does not post a new comment
# per review; a single comment advances `Reviews (2)` -> `Reviews (3)`, each
# with a different `Last reviewed commit`. Consequences, all load-bearing here:
#   - never wait for a *new* comment: the comment count never changes.
#   - never key on comment id, count or createdAt: all stable across reviews.
#   - the body's `Last reviewed commit` pointer is the only authority on which
#     commit a score belongs to. A stale read is otherwise indistinguishable
#     from a pending review.
#
# Fail-closed contract (ENG-754 acceptance criteria 1-4)
#   1. score < MIN on the current head            -> exit 1, naming the score
#   2. score for a superseded commit              -> pending, never a pass
#   3. no review / no verdict footer yet          -> pending, never a pass
#   4. verdict present for our head but the score or the commit pointer cannot
#      be parsed, or the payload is not JSON      -> exit 1 immediately, with
#      the raw response surfaced. Never fall back to "the score I found".
#
# Environment:
#   REPO                             owner/repo (e.g. AgentWebPro/agentweb)
#   PR_NUMBER                        pull request number
#   HEAD_SHA                         full 40-char head SHA of the PR
#   GH_TOKEN                         token for `gh api`
#   GREPTILE_GATE_MIN_SCORE          default 5
#   GREPTILE_GATE_TIMEOUT_SECONDS    default 1200 (keep below the job's
#                                    timeout-minutes so the gate fails loudly
#                                    instead of being killed by the runner)
#   GREPTILE_GATE_POLL_SECONDS       default 20

set -uo pipefail

REPO="${REPO:?REPO must be set}"
PR_NUMBER="${PR_NUMBER:?PR_NUMBER must be set}"
HEAD_SHA="${HEAD_SHA:?HEAD_SHA must be set}"
MIN_SCORE="${GREPTILE_GATE_MIN_SCORE:-5}"
TIMEOUT_SECONDS="${GREPTILE_GATE_TIMEOUT_SECONDS:-1200}"
POLL_SECONDS="${GREPTILE_GATE_POLL_SECONDS:-20}"

log() { printf 'greptile-gate: %s\n' "$*"; }

surface() {
  # Print the raw response so a parse failure is diagnosable from the log
  # alone, per acceptance criterion 4.
  printf '::group::%s\n%s\n::endgroup::\n' "$1" "$2"
}

fail() {
  printf '::error::greptile-gate: %s\n' "$1" >&2
  exit 1
}

if ! printf '%s' "${MIN_SCORE}" | grep -qE '^[0-9]+$'; then
  fail "GREPTILE_GATE_MIN_SCORE must be an integer, got '${MIN_SCORE}'"
fi

head_sha="$(printf '%s' "${HEAD_SHA}" | tr '[:upper:]' '[:lower:]')"
if ! printf '%s' "${head_sha}" | grep -qE '^[0-9a-f]{40}$'; then
  # A truncated SHA would make every pointer comparison mismatch, and the gate
  # would sit pending until timeout for entirely the wrong reason.
  fail "HEAD_SHA is not a full 40-character commit SHA: '${HEAD_SHA}'"
fi

log "requiring Greptile ${MIN_SCORE}/5 on head ${head_sha} of ${REPO}#${PR_NUMBER}"

# stderr is captured separately rather than folded into stdout: a warning from
# `gh` printed onto the JSON would make a healthy response unparseable, and this
# gate fails closed on unparseable, so that would be a self-inflicted red.
stderr_file="$(mktemp)"
trap 'rm -f "${stderr_file}"' EXIT

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
last_state="no Greptile review comment found on the pull request yet"
last_body=''

while :; do
  comments_json="$(gh api --paginate "repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100" 2>"${stderr_file}")"
  gh_exit=$?

  if [ "${gh_exit}" -ne 0 ]; then
    # Transient GitHub failures are retried, but they can only ever end in the
    # timeout below. There is no path from "the API is down" to a pass.
    last_state="GitHub API call failed (exit ${gh_exit}): $(tr '\n' ' ' <"${stderr_file}")"
    last_body="$(cat "${stderr_file}")"
  else
    # Prefer the newest Greptile comment that actually carries a verdict footer,
    # falling back to the newest Greptile comment of any kind so the "exists but
    # no verdict yet" pending message still works.
    #
    # The header above assumed Greptile only ever edits one comment in place, so
    # `last` was safe. That is not true: replying to a Greptile finding makes it
    # post a threaded REPLY, which is newer than the edited-in-place summary and
    # carries no footer. `last` then locked onto the reply and the gate polled
    # for the full 20 minutes and timed out — on a PR Greptile had already
    # scored 5/5. Any PR whose author converses with Greptile hit this.
    #
    # No loss of strictness: the selected body is still required to carry a
    # footer pointing at THIS head, exactly one Confidence Score, denominator 5,
    # and a score at or above the minimum.
    body="$(printf '%s' "${comments_json}" | jq -r '
        [ .[]
          | select((.user.type // "") == "Bot")
          | select(((.user.login // "") | ascii_downcase | startswith("greptile")))
          | (.body // "")
        ] as $bodies
        | ( [ $bodies[] | select(test("last reviewed commit"; "i")) ] | last )
          // ( $bodies | last )
          // ""
      ' 2>/dev/null)"
    jq_exit=$?

    if [ "${jq_exit}" -ne 0 ]; then
      surface 'GitHub API response (raw)' "${comments_json}"
      fail "unparseable response from repos/${REPO}/issues/${PR_NUMBER}/comments — expected a JSON array of comments"
    fi

    if [ -z "${body}" ]; then
      last_state="no Greptile review comment found on the pull request yet"
      # Keep last_body in step with last_state, so the timeout dump never shows
      # a stale error from an earlier poll next to an unrelated final state.
      last_body=''
    else
      last_body="${body}"

      # `Last reviewed commit` is the marker of a landed verdict. Its absence
      # means Greptile is still working (or posted a placeholder) — pending.
      footer_count="$(printf '%s\n' "${body}" | grep -oiE 'last reviewed commit' | wc -l | tr -d '[:space:]')"

      if [ "${footer_count}" = "0" ]; then
        last_state="a Greptile comment exists but has no 'Last reviewed commit' verdict footer yet"
      elif [ "${footer_count}" != "1" ]; then
        surface 'Greptile comment body (raw)' "${body}"
        fail "unparseable Greptile comment: found ${footer_count} 'Last reviewed commit' markers, expected exactly 1"
      else
        footer_line="$(printf '%s\n' "${body}" | grep -iE 'last reviewed commit' | head -n 1)"
        reviewed_sha="$(printf '%s' "${footer_line}" \
          | grep -oiE 'commit/[0-9a-f]{40}' \
          | head -n 1 \
          | cut -d/ -f2 \
          | tr '[:upper:]' '[:lower:]')"

        if [ -z "${reviewed_sha}" ]; then
          surface 'Greptile comment body (raw)' "${body}"
          fail "unparseable Greptile comment: the 'Last reviewed commit' footer carries no commit/<40-hex> pointer, so the score cannot be attributed to a commit. Refusing to fall back to the score found elsewhere in the body."
        fi

        if [ "${reviewed_sha}" != "${head_sha}" ]; then
          # Criterion 2. Greptile re-reviews by editing this same comment, so
          # the next poll re-reads it and sees the pointer move to our head.
          last_state="Greptile's latest review is for ${reviewed_sha}, not the current head ${head_sha} — superseded, treating as pending"
        else
          # A verdict exists for OUR head. Decide now; never pend again.
          score_count="$(printf '%s\n' "${body}" \
            | grep -oE 'Confidence Score:[[:space:]]*[0-9]+/[0-9]+' \
            | wc -l | tr -d '[:space:]')"

          if [ "${score_count}" != "1" ]; then
            surface 'Greptile comment body (raw)' "${body}"
            fail "unparseable Greptile verdict for head ${head_sha}: found ${score_count} 'Confidence Score: N/M' values, expected exactly 1"
          fi

          score_raw="$(printf '%s\n' "${body}" \
            | grep -oE 'Confidence Score:[[:space:]]*[0-9]+/[0-9]+' | head -n 1)"
          fraction="$(printf '%s' "${score_raw}" | grep -oE '[0-9]+/[0-9]+' | head -n 1)"
          score="${fraction%%/*}"
          denominator="${fraction##*/}"

          if [ "${denominator}" != "5" ]; then
            surface 'Greptile comment body (raw)' "${body}"
            fail "unexpected Greptile scale for head ${head_sha}: '${score_raw}' (expected a /5 scale). Not treating an unknown scale as a pass."
          fi

          if [ "${score}" -gt 5 ]; then
            surface 'Greptile comment body (raw)' "${body}"
            fail "unexpected Greptile score for head ${head_sha}: ${score}/5 is outside the 0-5 range"
          fi

          if [ "${score}" -lt "${MIN_SCORE}" ]; then
            surface 'Greptile comment body (raw)' "${body}"
            fail "Greptile scored ${score}/5 on the current head ${head_sha} (required: ${MIN_SCORE}/5). Address the findings and push; Greptile rewrites the same comment in place and this gate re-reads it."
          fi

          log "PASS — Greptile scored ${score}/5 on the current head ${head_sha}."
          exit 0
        fi
      fi
    fi
  fi

  if [ "$(date +%s)" -ge "${deadline}" ]; then
    [ -n "${last_body}" ] && surface 'Last observed response (raw)' "${last_body}"
    fail "timed out after ${TIMEOUT_SECONDS}s without a Greptile ${MIN_SCORE}/5 verdict for head ${head_sha}. Last observed state: ${last_state}"
  fi

  log "pending — ${last_state}; retrying in ${POLL_SECONDS}s"
  sleep "${POLL_SECONDS}"
done
