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
# Why "any file under .github/ or greptile.json changed" is the right,
# narrow signal: a genuine automated Dependabot dependency bump NEVER
# touches CI configuration or scripts — only a hand-pushed commit onto a
# Dependabot branch would. Guarding the whole `.github/` tree (rather than
# enumerating specific scripts) means a NEW script this bypass comes to rely
# on later is covered automatically, with no separate list to keep in sync.
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
#   0   no CI-security-relevant path differs from the PR's base — untampered.
#   1   at least one CI-security-relevant path differs, OR the check itself
#       could not be completed (API failure, unparseable response, zero
#       files found for a nonzero-commit PR). Fails CLOSED: any ambiguity is
#       "cannot confirm untampered", never treated as safe.

set -euo pipefail

# Guarded prefixes/paths — anything starting with one of these, changed on a
# Dependabot-authored PR, fails this check.
GUARDED_PATHS=(".github/" "greptile.json")

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

is_guarded() {
  local path="$1" prefix
  for prefix in "${GUARDED_PATHS[@]}"; do
    case "${path}" in
      "${prefix}"*) return 0 ;;
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
  # this repo's Greptile tooling (see greptile-request-review.sh's header):
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

  local filenames
  filenames="$(printf '%s' "${files_json}" | jq -sr '[.[]] | flatten | .[].filename' 2>/dev/null)"
  if [ -z "${filenames}" ]; then
    fail "could not extract filenames from the changed-files list for ${REPO}#${PR_NUMBER}."
  fi

  local guarded_hits=()
  local f
  while IFS= read -r f; do
    [ -z "${f}" ] && continue
    if is_guarded "${f}"; then
      guarded_hits+=("${f}")
    fi
  done <<<"${filenames}"

  if [ "${#guarded_hits[@]}" -gt 0 ]; then
    echo "[dependabot-integrity-check] ${REPO}#${PR_NUMBER}: ${#guarded_hits[@]} CI-security-relevant path(s) changed on a Dependabot-authored PR — not untampered:"
    printf '  %s\n' "${guarded_hits[@]}"
    fail "a Dependabot-authored PR modified CI-security-relevant path(s): ${guarded_hits[*]}. A genuine automated dependency bump never touches these — this fails closed regardless of what the Dependabot-only-commit classifier itself reports."
  fi

  echo "[dependabot-integrity-check] ${REPO}#${PR_NUMBER}: none of ${total} changed file(s) touch a guarded CI-security path. Untampered."
}

main "$@"
