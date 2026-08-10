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
# Exit codes (ENG-915 added the third; all non-zero, none is a pass)
#   0   PASS         a verdict for this head scored at or above MIN
#   1   REFUSED      a verdict for this head exists and does not clear the bar,
#                    or the evidence is unparseable
#   75  UNAVAILABLE  the deadline passed with no verdict for this head at all.
#                    Distinct from REFUSED so a caller can tell "Greptile said
#                    no" from "Greptile never answered". See unavailable().
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
#   GREPTILE_OVERRIDE_DENIED_ACCOUNTS
#                                    space-separated logins that may never
#                                    override (default: agentwebdeployer)
#
# The human override (ENG-1063)
# -----------------------------
# Measured 2026-07-27..08-10 on this repo: 35 gate failures to 32 passes, and
# NONE of them an outage — ten of fourteen sampled were 4/5. A 4/5 whose
# findings are all P2 is a judgement call, and there was no way to make it.
# `enforce_admins` is on, and the only admins are harshmoney123 and
# agentwebdeployer, so the Argusoft team (push) had no lever at all; loosening
# branch protection would have handed a bypass to the swarm, which shares
# harshmoney123, and to the *test* checks as well.
#
# So the override lives here, in the gate, where it can be scoped exactly:
#
#     /greptile-override <head-sha-prefix> <reason>
#
# posted as a PR comment. GitHub auto-merge is untouched and still fires only
# on a genuinely green required check, so "auto-merge needs 5/5, a human may
# decide otherwise" falls out without changing branch protection at all.
#
# What makes it a control rather than a formality:
#   - pinned to the head SHA, so blessing commit A cannot carry onto commit B;
#   - refused outright on automation-authored PRs, because the swarm commits as
#     harshmoney123 and "who posted it" therefore proves nothing;
#   - a human account that is an org member or repository collaborator;
#   - a written reason, which is the entire audit value of the mechanism;
#   - invalid overrides are logged and IGNORED, never fatal — quoting the
#     syntax in a review thread must not be able to fail a passing PR.
#
# Authorization uses `author_association`, which GitHub already includes on
# every comment, and NOT `GET /collaborators/{login}/permission`. That endpoint
# needs push access, and this workflow's token is deliberately
# `contents: read` — so the permission call 403s and every override would fail
# closed forever, a feature dead on arrival. Verified against live comments on
# #2290/#2300/#2310/#2315/#2318: the Argusoft team and Harsha all comment as
# MEMBER. Be precise about what this proves: org membership plus repository
# collaboration, not a repo write bit. In this org that set is the seven people
# in `orgs/AgentWebPro/members` minus the denied machine accounts, which is the
# intended audience. If the org ever grows past the point where every member is
# trusted to merge backend code, this check needs a real permission lookup and
# the token scope to make it — do not quietly widen the trusted set instead.
#
# It deliberately does NOT rescue an unparseable verdict: that means this script
# cannot read what it is looking at, which is a gate defect to fix, not a review
# finding a human can accept.

set -uo pipefail

REPO="${REPO:?REPO must be set}"
PR_NUMBER="${PR_NUMBER:?PR_NUMBER must be set}"
HEAD_SHA="${HEAD_SHA:?HEAD_SHA must be set}"
MIN_SCORE="${GREPTILE_GATE_MIN_SCORE:-5}"
TIMEOUT_SECONDS="${GREPTILE_GATE_TIMEOUT_SECONDS:-1200}"
POLL_SECONDS="${GREPTILE_GATE_POLL_SECONDS:-20}"

OVERRIDE_MARKER='/greptile-override'
# 6 hex characters collide often enough in a repo this size to prove nothing
# about which head the human was looking at.
OVERRIDE_MIN_SHA_CHARS=7
OVERRIDE_MIN_REASON_CHARS=12
# Shared machine accounts authenticate as ordinary Users, so `user.type` does
# not catch them and an explicit list is the only thing that does.
OVERRIDE_DENIED_ACCOUNTS="${GREPTILE_OVERRIDE_DENIED_ACCOUNTS:-agentwebdeployer}"

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

# ENG-915: a THIRD outcome, distinct from pass and from refused.
#
# `unavailable` means the deadline passed without Greptile ever returning a
# verdict for this head. The caller may use it to let the test suite run
# anyway, so that a Greptile outage costs test *feedback* rather than blocking
# every PR in both repos.
#
# Why this cannot misfire, which is the only reason it is safe to act on:
# every path that OBSERVES a verdict for this head exits before the deadline is
# ever consulted — at or above the bar exits 0, below the bar exits 1, and an
# unparseable verdict exits 1. So reaching the deadline is already proof that
# no verdict for this head was seen. `unavailable` therefore cannot be returned
# for a review Greptile actually scored; it is structurally impossible for a
# 3/5 to present as an outage.
#
# The weaker case it DOES cover is "Greptile is alive but never got to this PR
# within 20 minutes". Treating that as unavailable is deliberate: after a
# 20-minute wait the information value of continuing to block is nil, and the
# cost of being wrong is bounded to CI minutes, never to correctness — this
# still exits non-zero, so the job still fails, the merge gate is unchanged,
# and nothing becomes mergeable that was not mergeable before.
EXIT_UNAVAILABLE=75

unavailable() {
  printf '::error::greptile-gate: %s\n' "$1" >&2
  printf 'greptile-gate: verdict=unavailable\n'
  exit "${EXIT_UNAVAILABLE}"
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

# --- the human override (ENG-1063) -----------------------------------------
#
# Set by evaluate_override on every poll, because a human may post the comment
# while we are already waiting.
override_ok=''
override_login=''
override_reason=''

# PR metadata and permission lookups are cached: they cost an API call each and
# neither the head branch nor a collaborator's role changes mid-run. Nothing is
# fetched at all unless an override candidate actually appears, so the ordinary
# path — the overwhelming majority of runs — makes exactly the same API calls it
# made before this feature existed.
pr_meta_state=''
pr_head_ref=''
pr_body=''

fetch_pr_meta() {
  # Only success is cached. A transient blip must not disable the override for
  # the rest of the run: an override is a rare, deliberate act, and retrying
  # costs one call per poll and only when someone actually posted one.
  [ "${pr_meta_state}" = 'ok' ] && return 0

  local json
  if ! json="$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" 2>/dev/null)" || [ -z "${json}" ]; then
    return 1
  fi

  if ! pr_head_ref="$(printf '%s' "${json}" | jq -r '.head.ref // ""' 2>/dev/null)"; then
    return 1
  fi
  pr_body="$(printf '%s' "${json}" | jq -r '.body // ""' 2>/dev/null)"
  pr_meta_state='ok'
  return 0
}

# Echoes the reason this PR counts as machine-authored, or nothing.
#
# Two independent signals, because either alone is trivially defeated by
# accident: a branch renamed by hand still carries its attribution block, and a
# PR body rewritten by hand still sits on a swarm/* branch.
pr_automation_signal() {
  if ! fetch_pr_meta; then
    printf 'the PR metadata could not be read, so it cannot be shown to be human-authored'
    return 0
  fi
  case "${pr_head_ref}" in
    swarm/*|autofix/*)
      printf 'its head branch %s is an automation branch' "${pr_head_ref}"
      return 0
      ;;
  esac
  if printf '%s' "${pr_body}" | grep -qiE '^[[:space:]]*Execution-Actor:[[:space:]]*[^[:space:]]'; then
    printf 'the PR body carries an Execution-Actor attribution line'
    return 0
  fi
  return 0
}

# evaluate_override <comments-json>
#
# Sets override_ok / override_login / override_reason. Every rejection path logs
# why and leaves override_ok empty; none of them is fatal, so a stray marker in
# prose can never turn a passing PR red.
evaluate_override() {
  override_ok=''
  override_login=''
  override_reason=''

  local candidate login type assoc line rest sha_token reason signal

  # The newest comment carrying a line that BEGINS with the marker. Requiring
  # line-start is what keeps "we could use /greptile-override here" inert.
  if ! candidate="$(printf '%s' "$1" | jq -r '
      [ .[]
        | { login: (.user.login // ""),
            type:  (.user.type  // ""),
            assoc: (.author_association // ""),
            line:  ((.body // "")
                     | gsub("\r"; "")
                     | split("\n")
                     | map(select(test("^[ \t]*/greptile-override([ \t]|$)")))
                     | last) }
        | select(.line != null)
      ] | last // empty
      | [ .login, .type, .assoc, .line ] | @tsv
    ' 2>/dev/null)"; then
    return 0
  fi
  [ -z "${candidate}" ] && return 0

  login="$(printf '%s' "${candidate}" | cut -f1)"
  type="$(printf '%s' "${candidate}" | cut -f2)"
  assoc="$(printf '%s' "${candidate}" | cut -f3)"
  line="$(printf '%s' "${candidate}" | cut -f4-)"

  # Automation first: on a machine-authored PR the answer is no regardless of
  # who commented, so there is no reason to inspect the comment further.
  signal="$(pr_automation_signal)"
  if [ -n "${signal}" ]; then
    log "override ignored: this PR is automation-authored — ${signal}. Automated work earns its ${MIN_SCORE}/5 or it does not merge."
    return 0
  fi

  if [ "${type}" != 'User' ]; then
    log "override ignored: ${login} is not a human account (user.type=${type:-unknown})."
    return 0
  fi

  case " ${OVERRIDE_DENIED_ACCOUNTS} " in
    *" ${login} "*)
      log "override ignored: ${login} is a known automation account and may never authorize an override, whatever its repository role."
      return 0
      ;;
  esac

  rest="${line#"${line%%[![:space:]]*}"}"
  rest="${rest#"${OVERRIDE_MARKER}"}"
  sha_token="$(printf '%s' "${rest}" | awk '{print $1}')"
  reason="$(printf '%s' "${rest}" \
    | sed -E 's/^[[:space:]]*[^[:space:]]+[[:space:]]*//' \
    | sed -E 's/[[:space:]]+$//')"

  if [ -z "${sha_token}" ]; then
    log "override ignored: ${login} named no commit. The form is '${OVERRIDE_MARKER} <head-sha> <reason>'; the current head is ${head_sha}."
    return 0
  fi

  if ! printf '%s' "${sha_token}" | grep -qE "^[0-9a-fA-F]{${OVERRIDE_MIN_SHA_CHARS},40}$"; then
    log "override ignored: '${sha_token}' is not a commit SHA — an override must name at least ${OVERRIDE_MIN_SHA_CHARS} hex characters of the head it applies to. The current head is ${head_sha}."
    return 0
  fi

  sha_token="$(printf '%s' "${sha_token}" | tr '[:upper:]' '[:lower:]')"
  case "${head_sha}" in
    "${sha_token}"*) : ;;
    *)
      log "override ignored: it names ${sha_token}, which does not match the current head ${head_sha}. An override is pinned to the commit it was written for, so pushing new code retires it."
      return 0
      ;;
  esac

  if [ -z "${reason}" ]; then
    log "override ignored: no reason was given. The reason is the record of why these findings were accepted; without it the override is not auditable."
    return 0
  fi

  if [ "${#reason}" -lt "${OVERRIDE_MIN_REASON_CHARS}" ]; then
    log "override ignored: the reason '${reason}' is shorter than ${OVERRIDE_MIN_REASON_CHARS} characters. Say what is being accepted and why."
    return 0
  fi

  # Fails closed on anything unrecognised, including an absent field: an
  # override is only as good as the proof its author was entitled to make it.
  case "${assoc}" in
    OWNER|MEMBER|COLLABORATOR) : ;;
    *)
      log "override ignored: ${login} is not an org member or repository collaborator (author_association=${assoc:-absent})."
      return 0
      ;;
  esac

  override_ok='yes'
  override_login="${login}"
  override_reason="${reason}"
  return 0
}

# accept_override <what-is-being-overridden>
accept_override() {
  printf '::warning::greptile-gate: OVERRIDE ACCEPTED by %s on head %s — %s\n' \
    "${override_login}" "${head_sha}" "$1"
  log "OVERRIDE ACCEPTED — ${override_login} authorized this merge on head ${head_sha}: $1."
  log "OVERRIDE ACCEPTED — reason given: ${override_reason}"
  exit 0
}

log "requiring Greptile ${MIN_SCORE}/5 on head ${head_sha} of ${REPO}#${PR_NUMBER}"

# stderr is captured separately rather than folded into stdout: a warning from
# `gh` printed onto the JSON would make a healthy response unparseable, and this
# gate fails closed on unparseable, so that would be a self-inflicted red.
stderr_file="$(mktemp)"
trap 'rm -f "${stderr_file}"' EXIT

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
last_state="no Greptile review comment found on the pull request yet"
last_body=''

# ENG-915: proof that Greptile is FUNCTIONING, kept separate from whether it
# has answered for our head. Set only by observing a landed verdict — a
# `Last reviewed commit` footer carrying a real 40-hex pointer — for some
# commit on this PR. That is the strongest available sign of life and the
# hardest to fake: a placeholder comment, an impostor comment, or a failing
# API prove nothing.
#
# It exists so the deadline can tell two states apart that otherwise look
# identical from here: Greptile is down (no verdict ever seen -> UNAVAILABLE,
# and the caller may run the suite anyway) versus Greptile is alive and simply
# has not reached our head yet (-> a plain refusal, and the suite stays held,
# because a verdict really is imminent). Without this, a re-review still in
# flight would be reported as an outage.
greptile_alive=''
alive_sha=''

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

    # Re-read every poll: a human may post the override while we are waiting,
    # and may equally push a new commit that retires one already posted.
    evaluate_override "${comments_json}"

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
          #
          # This is also the sign of life described at greptile_alive: a landed
          # verdict for another commit proves the service is working, so if we
          # go on to time out it is a slow review and not an outage.
          greptile_alive='yes'
          alive_sha="${reviewed_sha}"
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
            # The case ENG-1063 exists for: a landed verdict below the bar that
            # a human with write access has explicitly decided to accept.
            if [ -n "${override_ok}" ]; then
              accept_override "overriding Greptile's ${score}/5"
            fi
            surface 'Greptile comment body (raw)' "${body}"
            fail "Greptile scored ${score}/5 on the current head ${head_sha} (required: ${MIN_SCORE}/5). Address the findings and push; Greptile rewrites the same comment in place and this gate re-reads it. To accept the findings instead, comment: ${OVERRIDE_MARKER} ${head_sha} <why you are accepting them>"
          fi

          log "PASS — Greptile scored ${score}/5 on the current head ${head_sha}."
          exit 0
        fi
      fi
    fi
  fi

  # Reaching here means no verdict for this head was observed — pending, stale,
  # or Greptile down. An override covers this too, deliberately: a gate that can
  # only forgive a landed verdict leaves the team hard-blocked on exactly the
  # days Greptile never answers.
  if [ -n "${override_ok}" ]; then
    accept_override "no Greptile verdict had landed for this head"
  fi

  if [ "$(date +%s)" -ge "${deadline}" ]; then
    [ -n "${last_body}" ] && surface 'Last observed response (raw)' "${last_body}"

    # Greptile demonstrably works — it returned a landed verdict for another
    # commit on this PR — so the timeout is a slow re-review, not an outage.
    # Refusing to call this UNAVAILABLE is the whole anti-misfire guarantee:
    # the bypass is reserved for a service that never answered at all.
    if [ -n "${greptile_alive}" ]; then
      fail "timed out after ${TIMEOUT_SECONDS}s without a Greptile ${MIN_SCORE}/5 verdict for head ${head_sha}. Last observed state: ${last_state}. NOT reporting this as UNAVAILABLE: Greptile returned a landed verdict for ${alive_sha} on this PR, so it is responding and a re-review of this head is outstanding."
    fi

    unavailable "timed out after ${TIMEOUT_SECONDS}s without a Greptile ${MIN_SCORE}/5 verdict for head ${head_sha}. Last observed state: ${last_state}. Reporting this as UNAVAILABLE rather than a refusal: no landed Greptile verdict was observed for ANY commit on this PR, so this is Greptile not answering, not Greptile saying no."
  fi

  log "pending — ${last_state}; retrying in ${POLL_SECONDS}s"
  sleep "${POLL_SECONDS}"
done
