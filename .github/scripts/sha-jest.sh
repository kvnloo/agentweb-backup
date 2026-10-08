#!/usr/bin/env bash
#
# sha-jest.sh — run backend jest files at an exact commit (ENG-2351).
#
# The post-merge verifier needs to prove "this test passes at the merge sha",
# but a detached worktree has no backend/node_modules and the shared checkout's
# node_modules is not guaranteed to contain dev deps (ts-jest). This script:
#
#   1. creates a detached worktree of REPO_DIR at <sha>,
#   2. links backend/node_modules to a cache dir keyed by the sha256 of that
#      commit's backend/package-lock.json, running `npm ci` (dev deps included)
#      into the cache only when the key is new,
#   3. runs `jest --runInBand <files>` from backend/ and exits with jest's code,
#   4. removes the worktree (unless KEEP_WORKTREE=1).
#
# Usage:  bash .github/scripts/sha-jest.sh <sha> <backend-relative test path>...
#   e.g.  bash .github/scripts/sha-jest.sh 6529233 src/services/__tests__/toolDispatch.test.ts
#
# Env:
#   REPO_DIR        git repo to read the commit from (default: this script's repo)
#   SHA_JEST_ROOT   cache root (default: ~/.cache/agentweb-sha-jest)
#   NPM_CMD         npm binary (default: npm)   — overridable for tests
#   NODE_CMD        node binary (default: node) — overridable for tests
#   KEEP_WORKTREE=1 leave the worktree in place for debugging

set -euo pipefail

die() { echo "sha-jest: $*" >&2; exit 2; }

[[ $# -ge 2 ]] || die "usage: sha-jest.sh <sha> <test-file>..."
SHA_ARG="$1"; shift

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)}"
ROOT="${SHA_JEST_ROOT:-${HOME}/.cache/agentweb-sha-jest}"
NPM_CMD="${NPM_CMD:-npm}"
NODE_CMD="${NODE_CMD:-node}"

SHA="$(git -C "$REPO_DIR" rev-parse --verify --quiet "${SHA_ARG}^{commit}")" \
  || die "unknown commit: ${SHA_ARG} (fetch first?)"

for f in "$@"; do
  case "$f" in
    ''|-*) die "test path must be a non-empty file path (an empty arg would run the whole suite): '$f'" ;;
    /*|*..*) die "test path must be backend-relative without '..': $f" ;;
  esac
  git -C "$REPO_DIR" cat-file -e "${SHA}:backend/${f}" 2>/dev/null \
    || die "backend/${f} does not exist at ${SHA:0:12}"
done

LOCK_HASH="$(git -C "$REPO_DIR" show "${SHA}:backend/package-lock.json" | sha256sum | cut -c1-16)" \
  || die "backend/package-lock.json missing at ${SHA:0:12}"
CACHE="${ROOT}/nm-${LOCK_HASH}"
WT="${ROOT}/wt-${SHA:0:12}-$$"
mkdir -p "$ROOT"

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  if [[ "${KEEP_WORKTREE:-0}" != "1" ]]; then
    git -C "$REPO_DIR" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
    git -C "$REPO_DIR" worktree prune >/dev/null 2>&1 || true
  else
    echo "sha-jest: worktree kept at $WT" >&2
  fi
}
trap cleanup EXIT

git -C "$REPO_DIR" worktree add --detach --quiet "$WT" "$SHA"

if [[ ! -f "${CACHE}/.complete" ]]; then
  echo "sha-jest: building node_modules cache ${CACHE} (lock ${LOCK_HASH})" >&2
  rm -rf "${CACHE}.tmp"
  mkdir -p "${CACHE}.tmp"
  cp "${WT}/backend/package.json" "${WT}/backend/package-lock.json" "${CACHE}.tmp/"
  (cd "${CACHE}.tmp" && "$NPM_CMD" ci --include=dev --ignore-scripts --no-audit --no-fund >&2) \
    || { rm -rf "${CACHE}.tmp"; die "npm ci failed for lock ${LOCK_HASH}"; }
  [[ -e "${CACHE}.tmp/node_modules/ts-jest" ]] \
    || { rm -rf "${CACHE}.tmp"; die "ts-jest missing after npm ci (lock ${LOCK_HASH})"; }
  rm -rf "$CACHE"
  mv "${CACHE}.tmp" "$CACHE"
  touch "${CACHE}/.complete"
fi

ln -sfn "${CACHE}/node_modules" "${WT}/backend/node_modules"

echo "sha-jest: running jest at ${SHA:0:12}: $*" >&2
set +e
(cd "${WT}/backend" && "$NODE_CMD" node_modules/.bin/jest --runInBand --forceExit "$@")
rc=$?
set -e
echo "sha-jest: jest exit ${rc} at ${SHA}" >&2
exit "$rc"
