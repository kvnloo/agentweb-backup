#!/usr/bin/env bash
#
# Tests for .github/scripts/dependabot-integrity-check.sh (ENG-1287).
#
# Run with:  bash .github/scripts/dependabot-integrity-check.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/dependabot-integrity-check.sh"

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

install_mock_gh() {
  mkdir -p "${WORKDIR}/bin"
  cat >"${WORKDIR}/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "api" ]; then
  exit_code="$(cat "${MOCK_EXIT}" 2>/dev/null || echo 0)"
  if [ "${exit_code}" = "1" ]; then
    echo "mock gh: simulated total transient failure" >&2
    exit 1
  fi
  if [ "${exit_code}" = "2" ]; then
    cat "${MOCK_PARTIAL}" 2>/dev/null || true
    echo "mock gh: simulated partial-pagination failure (later page errored)" >&2
    exit 1
  fi
  cat "${MOCK_FILES}"
  exit 0
fi
echo "mock gh: unhandled invocation: $*" >&2
exit 99
MOCK
  chmod +x "${WORKDIR}/bin/gh"
}

files_untouched() {
  cat <<'EOF'
[
  {"filename": "package.json"},
  {"filename": "package-lock.json"}
]
EOF
}

files_manifests_at_depth() {
  # Manifests are matched by basename regardless of directory depth.
  cat <<'EOF'
[
  {"filename": "backend/package.json"},
  {"filename": "backend/package-lock.json"},
  {"filename": "partner-portal/package-lock.json"},
  {"filename": "agent-engine/requirements.txt"}
]
EOF
}

files_requirements_variant() {
  cat <<'EOF'
[
  {"filename": "agent-engine/requirements-dev.txt"}
]
EOF
}

files_touches_scripts_dir() {
  cat <<'EOF'
[
  {"filename": "package.json"},
  {"filename": ".github/scripts/dependabot-only-pr.sh"}
]
EOF
}

files_touches_workflow() {
  # The REAL shape of a genuine GitHub-Actions-ecosystem Dependabot update
  # (verified live against agentweb#2276) -- must still fail, deliberately:
  # this check declines the bypass for that PR class rather than try to
  # verify the diff is a pure action-SHA bump.
  cat <<'EOF'
[
  {"filename": ".github/workflows/tests.yml"},
  {"filename": ".github/workflows/deploy.yml"}
]
EOF
}

files_touches_greptile_json() {
  cat <<'EOF'
[
  {"filename": "greptile.json"}
]
EOF
}

files_touches_unrelated_dotgithub_file() {
  # A path that merely STARTS with a similar string but isn't actually under
  # .github/ must still fail -- it's not a recognized manifest either way,
  # so this is really just confirming basename matching doesn't accidentally
  # treat an unrelated file as safe.
  cat <<'EOF'
[
  {"filename": ".github-actions-notes.md"}
]
EOF
}

files_application_code() {
  # THE exact scenario Greptile named: a forged-identity commit touching
  # application source, not a dependency manifest at all.
  cat <<'EOF'
[
  {"filename": "backend/src/services/authService.ts"}
]
EOF
}

files_mixed_manifest_and_application_code() {
  # A manifest change ALONGSIDE an application-code change must still fail
  # -- one allowed file does not excuse a disallowed one riding along.
  cat <<'EOF'
[
  {"filename": "package.json"},
  {"filename": "backend/src/routes/webhooks.ts"}
]
EOF
}

files_renamed_into_manifest_name() {
  # THE exact gap caught by independent deep-dive verification: an
  # application file renamed TO a manifest's name. filename alone would pass
  # the basename allowlist; status=renamed must still fail it closed.
  cat <<'EOF'
[
  {"filename": "package.json", "status": "renamed", "previous_filename": "backend/src/evil.ts"}
]
EOF
}

files_copied_into_manifest_name() {
  cat <<'EOF'
[
  {"filename": "requirements.txt", "status": "copied", "previous_filename": "agent-engine/payload.py"}
]
EOF
}

files_ordinary_manifest_modification() {
  # The overwhelmingly common real case -- status=modified on a manifest --
  # must NOT be caught by the new rename/copy check.
  cat <<'EOF'
[
  {"filename": "package.json", "status": "modified"}
]
EOF
}

files_empty() {
  echo '[]'
}

run_script() {
  set +e
  LAST_OUTPUT=$(
    PATH="${WORKDIR}/bin:${PATH}" \
    MOCK_FILES="${WORKDIR}/files.json" \
    MOCK_EXIT="${WORKDIR}/exit_code" \
    MOCK_PARTIAL="${WORKDIR}/files_partial.json" \
    REPO="${TEST_REPO:-}" \
    PR_NUMBER="${TEST_PR_NUMBER:-}" \
    bash "${SCRIPT}" 2>&1
  )
  LAST_RC=$?
  set -e
}

check() {
  local desc="$1" expect_rc="$2" expect_substr="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ "${LAST_RC}" -ne "${expect_rc}" ]; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf 'FAIL: %s\n  expected exit %s, got %s\n  output: %s\n' \
      "${desc}" "${expect_rc}" "${LAST_RC}" "${LAST_OUTPUT}"
    return
  fi
  if [ -n "${expect_substr}" ] && [[ "${LAST_OUTPUT}" != *"${expect_substr}"* ]]; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf 'FAIL: %s\n  expected output to contain: %s\n  actual output: %s\n' \
      "${desc}" "${expect_substr}" "${LAST_OUTPUT}"
    return
  fi
  printf 'PASS: %s\n' "${desc}"
}

install_mock_gh
echo 0 >"${WORKDIR}/exit_code"

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

TEST_REPO=''
run_script
check 'missing REPO fails loudly' 1 'REPO'

TEST_REPO='AgentWebPro/agentweb'
TEST_PR_NUMBER=''
run_script
check 'missing PR_NUMBER fails loudly' 1 'PR_NUMBER'

TEST_PR_NUMBER='2427'
files_untouched >"${WORKDIR}/files.json"
run_script
check 'an ordinary dependency-bump diff (only recognized manifests) passes' 0 'Untampered'

files_manifests_at_depth >"${WORKDIR}/files.json"
run_script
check 'manifests at any directory depth pass (matched by basename)' 0 'Untampered'

files_requirements_variant >"${WORKDIR}/files.json"
run_script
check 'a requirements-dev.txt variant passes' 0 'Untampered'

# THE exact scenario Greptile named (3/5, portal#1037, "Verified signer is
# not identity-bound"): a forged-identity commit touching application
# source must fail closed, regardless of what commit metadata claims.
files_application_code >"${WORKDIR}/files.json"
run_script
check 'application source code (the forged-identity scenario) fails closed' 1 \
  'not a recognized dependency manifest'
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "${LAST_OUTPUT}" == *'backend/src/services/authService.ts'* ]]; then
  printf 'PASS: %s\n' 'the specific disallowed path is named in the failure output'
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  output: %s\n' 'the specific disallowed path is named in the failure output' "${LAST_OUTPUT}"
fi

files_mixed_manifest_and_application_code >"${WORKDIR}/files.json"
run_script
check 'a manifest change alongside an application-code change still fails closed' 1 \
  'not a recognized dependency manifest'

# THE exact gap caught by independent deep-dive verification: filename alone
# passes the allowlist, but status=renamed/copied must still fail closed --
# a genuine dependency bump never renames or copies a file into existence.
files_renamed_into_manifest_name >"${WORKDIR}/files.json"
run_script
check 'a file renamed INTO a manifest name fails closed despite the name matching the allowlist' 1 \
  'status=renamed'
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "${LAST_OUTPUT}" == *'package.json'* ]]; then
  printf 'PASS: %s\n' 'the renamed-to path is named in the failure output'
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  output: %s\n' 'the renamed-to path is named in the failure output' "${LAST_OUTPUT}"
fi

files_copied_into_manifest_name >"${WORKDIR}/files.json"
run_script
check 'a file copied INTO a manifest name also fails closed' 1 \
  'status=copied'

files_ordinary_manifest_modification >"${WORKDIR}/files.json"
run_script
check 'an ordinary modified (not renamed/copied) manifest still passes -- the rename check is not overbroad' 0 \
  'Untampered'

files_touches_scripts_dir >"${WORKDIR}/files.json"
run_script
check 'a diff touching .github/scripts/ fails closed' 1 \
  'not a recognized dependency manifest'
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "${LAST_OUTPUT}" == *'.github/scripts/dependabot-only-pr.sh'* ]]; then
  printf 'PASS: %s\n' 'the specific disallowed path is named in the failure output'
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  output: %s\n' 'the specific disallowed path is named in the failure output' "${LAST_OUTPUT}"
fi

# The REAL shape of a genuine GitHub-Actions-ecosystem Dependabot update
# (verified live, agentweb#2276) must STILL fail this check, deliberately —
# declining the bypass for that PR class (it still gets a full, real
# Greptile review) rather than attempt to verify the diff is a pure
# action-SHA bump.
files_touches_workflow >"${WORKDIR}/files.json"
run_script
check 'a diff touching .github/workflows/ fails closed, even though this is what a real GH-Actions Dependabot bump looks like' 1 \
  'not a recognized dependency manifest'

files_touches_greptile_json >"${WORKDIR}/files.json"
run_script
check 'a diff touching greptile.json fails closed' 1 \
  'not a recognized dependency manifest'

files_touches_unrelated_dotgithub_file >"${WORKDIR}/files.json"
run_script
check 'an unrecognized file that merely starts with a similar string also fails closed (not a manifest either way)' 1 \
  'not a recognized dependency manifest'

files_empty >"${WORKDIR}/files.json"
run_script
check 'zero changed files fails loudly rather than vacuously passing' 1 \
  'zero changed files'

files_untouched >"${WORKDIR}/files.json"
echo 1 >"${WORKDIR}/exit_code"
run_script
check 'a total API failure fails closed, not treated as untampered' 1 \
  'DEPENDABOT_INTEGRITY_CHECK_FAILED'
echo 0 >"${WORKDIR}/exit_code"

# Partial-pagination failure: non-empty output, non-zero exit. Must be
# treated as a failure, never as "here is the complete file list" — same
# class of bug caught live in greptile-request-review.sh this same session.
files_touches_unrelated_dotgithub_file >"${WORKDIR}/files_partial.json"
files_untouched >"${WORKDIR}/files.json"
echo 2 >"${WORKDIR}/exit_code"
run_script
check 'a partial-pagination failure (non-empty output, non-zero exit) fails closed, not treated as a complete untampered list' 1 \
  'DEPENDABOT_INTEGRITY_CHECK_FAILED'
echo 0 >"${WORKDIR}/exit_code"

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
