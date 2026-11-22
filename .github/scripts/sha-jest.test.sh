#!/usr/bin/env bash
#
# Tests for .github/scripts/sha-jest.sh (ENG-2351). Uses a throwaway git repo
# and fake npm/node so no real install or jest run happens.
#
# Run with:  bash .github/scripts/sha-jest.test.sh

# shellcheck disable=SC2016,SC2034  # check() evals single-quoted asserts lazily; rc is read inside them

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/sha-jest.sh"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT
TESTS_RUN=0; TESTS_FAILED=0

REPO="${WORKDIR}/repo"
mkdir -p "${REPO}/backend/src/__tests__"
git -C "$REPO" init -q
echo '{"name":"x"}' >"${REPO}/backend/package.json"
echo '{"lockfileVersion":3}' >"${REPO}/backend/package-lock.json"
echo 'test' >"${REPO}/backend/src/__tests__/a.test.ts"
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm init
SHA="$(git -C "$REPO" rev-parse HEAD)"

FAKE_NPM="${WORKDIR}/npm"
cat >"$FAKE_NPM" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >>"$CALL_LOG"
mkdir -p node_modules/ts-jest node_modules/.bin
EOF
FAKE_NODE="${WORKDIR}/node"
cat >"$FAKE_NODE" <<'EOF'
#!/usr/bin/env bash
echo "node $* cwd=$(basename "$(dirname "$PWD")")/$(basename "$PWD") nm=$(readlink node_modules)" >>"$CALL_LOG"
exit "${FAKE_JEST_RC:-0}"
EOF
chmod +x "$FAKE_NPM" "$FAKE_NODE"

run() {
  : >"${WORKDIR}/log"
  REPO_DIR="$REPO" SHA_JEST_ROOT="${WORKDIR}/cache" NPM_CMD="$FAKE_NPM" NODE_CMD="$FAKE_NODE" \
    CALL_LOG="${WORKDIR}/log" bash "$SCRIPT" "$@" >"${WORKDIR}/out" 2>&1
  echo $?
}

check() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if eval "$2"; then echo "ok - $1"; else echo "FAIL - $1"; TESTS_FAILED=$((TESTS_FAILED + 1)); cat "${WORKDIR}/out" "${WORKDIR}/log"; fi
}

rc=$(run "$SHA" src/__tests__/a.test.ts)
check "cold run exits 0" '[[ $rc == 0 ]]'
check "cold run installs dev deps once" '[[ $(grep -c "npm ci --include=dev" "${WORKDIR}/log") == 1 ]]'
check "jest runs the named file in band" 'grep -q "node node_modules/.bin/jest --runInBand --forceExit src/__tests__/a.test.ts cwd=.*/backend nm=.*/nm-" "${WORKDIR}/log"'
check "worktree removed after run" '! ls -d "${WORKDIR}"/cache/wt-* >/dev/null 2>&1'

rc=$(run "$SHA" src/__tests__/a.test.ts)
check "warm run reuses lock-keyed cache (no npm)" '[[ $rc == 0 ]] && ! grep -q "^npm" "${WORKDIR}/log"'

rc=$(FAKE_JEST_RC=1 run "$SHA" src/__tests__/a.test.ts)
check "jest failure propagates" '[[ $rc == 1 ]]'

rc=$(run "$SHA" "")
check "empty test path refused (would run whole suite)" '[[ $rc == 2 ]] && ! grep -q "^node" "${WORKDIR}/log"'

rc=$(run "$SHA" src/__tests__/missing.test.ts)
check "test file absent at sha refused" '[[ $rc == 2 ]] && grep -q "does not exist" "${WORKDIR}/out"'

rc=$(run "$SHA" ../etc/passwd)
check "path traversal refused" '[[ $rc == 2 ]]'

rc=$(run deadbeefdeadbeef src/__tests__/a.test.ts)
check "unknown sha refused" '[[ $rc == 2 ]] && grep -q "unknown commit" "${WORKDIR}/out"'

rc=$(run "$SHA")
check "missing test arg refused" '[[ $rc == 2 ]]'

echo "${TESTS_RUN} run, ${TESTS_FAILED} failed"
[[ $TESTS_FAILED == 0 ]]
