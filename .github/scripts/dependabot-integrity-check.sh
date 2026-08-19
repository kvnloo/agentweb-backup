#!/usr/bin/env bash
#
# For a Dependabot-authored PR, verify no CI-security-relevant path changed
# relative to the PR's base ref (ENG-1287).
#
# CAUGHT LIVE (Greptile 1/5, portal#1037 / ENG-1282): dependabot-only-pr.sh,
# and the workflow step that invokes it, are both sourced from the PR's own
# head under the `pull_request` trigger — a repo writer could modify either
# on their own push to a Dependabot-opened branch to self-approve unreviewed
# code, and dependabot-only-pr.sh cannot detect tampering with ITSELF (any
# self-check it performed would be exactly as tamperable as the check it
# guards). Closing that requires some piece of the pipeline sourced from a
# ref the PR cannot control.
#
# This script is invoked ONLY from a `pull_request_target`-triggered job
# (.github/workflows/dependabot-integrity-check.yml). `pull_request_target`
# reads its OWN workflow file, and — critically — this script's content via
# the job's default `actions/checkout` (no `ref:` override), from the PR's
# BASE ref, not the head. A PR cannot alter what this script does. It does
# NO checkout of PR-supplied code and needs no secrets beyond the default
# read-only token, so it does not reintroduce the secret-exfiltration risk
# `pull_request_target` normally carries when a workflow checks out and
# builds/tests untrusted PR content.
#
# CAUGHT LIVE A SECOND TIME (Greptile 3/5, portal#1037, "Verified signer is
# not identity-bound", reviewing the first version of this check): a human
# with write access can sign a commit with their OWN valid key while setting
# its author email to Dependabot's mapped noreply address — `.author.login`
# resolves to `dependabot[bot]` and `commit.verification.verified` is true
# even though the signer is human (tested live against real commit history,
# see dependabot-only-pr.sh's own header). dependabot-only-pr.sh's check
# cannot tell this apart from the real thing — no GitHub API field binds a
# signature to Dependabot's identity specifically, only to "some registered
# key". The first version of THIS check (a blocklist of `.github/` +
# `greptile.json`) didn't help: a forged commit disguised as Dependabot could
# still carry an arbitrary APPLICATION code change and sail through, since
# nothing here looked at anything other than the CI-relevant paths.
#
# Also discovered live, checking a REAL Dependabot PR on this repo
# (agentweb#2276): it touched `.github/workflows/tests.yml` and
# `.github/workflows/deploy.yml` directly — a genuine GitHub-Actions-
# ecosystem Dependabot update bumping pinned action SHAs. So blocking
# `.github/` outright (the first version's behavior) was actually already
# correct and safe for THAT PR type: it just declines the bypass for it
# (that PR just merges through the normal test gates instead of the bypass —
# a foregone cost saving, not a broken or unsafe outcome), which is the right
# conservative default
# for a file class that is also, legitimately, CI-security-relevant.
#
# The fix that actually closes the identity-binding gap: flip from a
# blocklist to an ALLOWLIST. A forged-identity commit can claim to be
# Dependabot, but it cannot hide WHAT FILES it touched — that's visible
# through this trusted, base-ref-sourced check regardless of any commit
# metadata. So instead of asking "did a suspicious path change", ask "does
# EVERY changed path match a recognized dependency-manifest file" (by
# basename, any depth). `.github/` is deliberately NOT on the allowlist
# either, per the discovery above — declining the bypass there too. ANY
# changed path outside the manifest allowlist — which is exactly what "an
# application-only change" (the scenario Greptile named) would require —
# fails closed. This does not attempt to verify manifest-file CONTENT is a
# pure version bump (a harder, separate problem); it bounds the blast
# radius of a successful forgery to dependency manifests only, never
# arbitrary source or CI config.
#
# CAUGHT LIVE A THIRD TIME (independent deep-dive re-verification,
# 2026-08-17): the allowlist check above only ever inspected the CURRENT
# filename. GitHub's PR-files API reports a renamed file by its NEW name,
# with a separate `status: "renamed"` field (and `previous_filename`) — so
# `git mv backend/src/evil.ts package.json` on a Dependabot branch reports
# filename=package.json and would have sailed through the basename check
# untouched, while the actual diff content is arbitrary attacker-controlled
# code wearing a manifest's name. A genuine automated dependency bump NEVER
# renames a file — it modifies an existing manifest in place. Fix: reject
# ANY file with `status` "renamed" or "copied" outright, independent of what
# its resulting name is.
#
# Also caught in the same pass: without `pull-requests: read` in the
# workflow's `permissions:` block, `gh api .../pulls/{n}/files` 403s for
# EVERY real Dependabot PR (verified live against three genuinely open ones)
# — an unconditional fail-closed caused by a missing scope, not a
# content-based decision, and indistinguishable from the intended behavior
# only by accident (both paths exit 1). See dependabot-integrity-check.yml.
#
# This job is made a REQUIRED branch-protection check. That is what actually
# closes the gap: even if dependabot-only-pr.sh is fully compromised and
# reports a false "bypass eligible", this check is independently produced
# from the trusted base ref and still fails, and GitHub blocks the merge
# regardless of what the (potentially compromised) `pull_request`-triggered
# job reports.
#
# Environment:
#   REPO         owner/repo, e.g. AgentWebPro/agentweb
#   PR_NUMBER    pull request number
#   GH_TOKEN     token for `gh api` (contents: read is sufficient)
#
# Exit status:
#   0   every changed path is a recognized dependency manifest — untampered.
#   1   at least one changed path is not, OR the check itself could not
#       be completed (API failure, unparseable response, zero files found
#       for a nonzero-commit PR). Fails CLOSED: any ambiguity is "cannot
#       confirm untampered", never treated as safe.

set -euo pipefail

# Recognized dependency-manifest basenames across the ecosystems Dependabot
# supports that this org could plausibly use. Matched by basename so any
# depth (root, backend/, partner-portal/, agent-engine/, etc.) is covered
# without enumerating every directory. Deliberately does NOT include
# anything under .github/: a genuine GitHub-Actions-ecosystem Dependabot
# update DOES touch .github/workflows/*.yml (verified live against
# agentweb#2276), but that same path is also the most CI-security-relevant
# one in the repo — the conservative, safe choice is to decline the bypass
# for that PR class (it merges through the normal test gates) rather than
# try to distinguish "Dependabot bumped a pinned SHA" from "a line was
# tampered with" via a content-level diff check, which is a harder, separate
# problem this does not attempt to solve.
ALLOWED_BASENAMES=(
  "package.json" "package-lock.json" "npm-shrinkwrap.json"
  "yarn.lock" "pnpm-lock.yaml"
  "requirements.txt" "Pipfile" "Pipfile.lock" "pyproject.toml" "poetry.lock"
  "go.mod" "go.sum"
  "Gemfile" "Gemfile.lock"
  "composer.json" "composer.lock"
  "Cargo.toml" "Cargo.lock"
)

fail() {
  echo "::error::DEPENDABOT_INTEGRITY_CHECK_FAILED: $*" >&2
  echo "[dependabot-integrity-check] DEPENDABOT_INTEGRITY_CHECK_FAILED: $*" >&2
  exit 1
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "required environment variable ${name} is empty or unset."
  fi
}

is_allowed() {
  local path="$1" base name
  base="$(basename -- "${path}")"
  for name in "${ALLOWED_BASENAMES[@]}"; do
    [ "${base}" = "${name}" ] && return 0
    # requirements-*.txt / requirements_*.txt variants (e.g. requirements-dev.txt)
    case "${base}" in
      requirements-*.txt|requirements_*.txt) return 0 ;;
    esac
  done
  return 1
}

main() {
  require_env REPO
  require_env PR_NUMBER

  if ! command -v gh >/dev/null 2>&1; then
    fail "the gh CLI is not on PATH."
  fi

  # Same partial-pagination hazard as every other paginated `gh api` call in
  # this repo's CI tooling:
  # `--paginate` can print early pages to stdout and still exit non-zero on a
  # later page. Non-empty output is not proof of a complete list — only exit
  # 0 is. Never treat a truncated file list as "here is everything changed".
  local files_json
  if ! files_json="$(gh api --paginate "repos/${REPO}/pulls/${PR_NUMBER}/files?per_page=100" 2>&1)"; then
    fail "could not list changed files for ${REPO}#${PR_NUMBER}: ${files_json}"
  fi

  local total
  total="$(printf '%s' "${files_json}" | jq -s '[.[]] | flatten | length' 2>/dev/null || echo -1)"
  if [ "${total}" -lt 0 ]; then
    fail "could not parse the changed-files list for ${REPO}#${PR_NUMBER}."
  fi
  if [ "${total}" -eq 0 ]; then
    fail "found zero changed files for ${REPO}#${PR_NUMBER} — cannot confirm an empty diff is untampered (a PR always has at least one changed file; a truly empty result means the fetch itself is suspect)."
  fi

  # Pull filename AND status together (tab-separated), not filename alone —
  # see the rename check below for why status matters.
  local file_rows
  file_rows="$(printf '%s' "${files_json}" | jq -sr '[.[]] | flatten | .[] | [.filename, (.status // "")] | @tsv' 2>/dev/null)"
  if [ -z "${file_rows}" ]; then
    fail "could not extract the changed-files list for ${REPO}#${PR_NUMBER}."
  fi

  local disallowed_hits=()
  local f status
  while IFS=$'\t' read -r f status; do
    [ -z "${f}" ] && continue
    # CAUGHT LIVE (deep-dive verification, 2026-08-17): is_allowed() only
    # ever looked at the CURRENT filename. GitHub's PR-files API reports a
    # renamed file with its NEW filename and a separate `status: "renamed"`
    # (plus `previous_filename`) — so `git mv backend/src/evil.ts
    # package.json` on a Dependabot branch would report filename=package.json
    # and sail through the basename allowlist untouched, while the actual
    # content is an arbitrary attacker-controlled file wearing a manifest's
    # name. A genuine automated dependency bump NEVER renames a file — it
    # modifies an existing manifest in place — so ANY renamed or copied file
    # fails closed here, regardless of what its new name is.
    if [ "${status}" = "renamed" ] || [ "${status}" = "copied" ]; then
      disallowed_hits+=("${f} (status=${status} — a rename/copy onto any path is never a genuine dependency bump)")
      continue
    fi
    if ! is_allowed "${f}"; then
      disallowed_hits+=("${f}")
    fi
  done <<<"${file_rows}"

  if [ "${#disallowed_hits[@]}" -gt 0 ]; then
    echo "[dependabot-integrity-check] ${REPO}#${PR_NUMBER}: ${#disallowed_hits[@]} changed path(s) are not a recognized dependency manifest — not bypass-eligible:"
    printf '  %s\n' "${disallowed_hits[@]}"
    fail "a Dependabot-authored PR changed path(s) outside the recognized dependency-manifest allowlist: ${disallowed_hits[*]}. A genuine automated dependency bump only ever touches manifest files — this fails closed regardless of what the Dependabot-only-commit classifier itself reports, and regardless of how convincingly commit metadata claims Dependabot authorship."
  fi

  echo "[dependabot-integrity-check] ${REPO}#${PR_NUMBER}: all ${total} changed file(s) are recognized dependency manifests. Untampered."
}

main "$@"
