#!/usr/bin/env bash
# ENG-2110: run by the SIGNING job, before it signs, on the tarball the BUILD job produced.
#
#   login-host-verify-build.sh <login-host-XXXXXXXXXXXX.tar.gz>        (run from a checkout of the same commit; env GITHUB_SHA and GITHUB_RUN_ID)
#
# The build job runs npm (every dependency, install scripts disabled but test code and esbuild still run) and has no cloud credentials. This job has the
# credentials and runs no npm. Whatever the build job hands over is untrusted until proven otherwise, so before anything is signed:
#   - the name, MANIFEST git sha and MANIFEST build number must be THIS run's commit and run id (the number deploy.sh orders builds by);
#   - the MANIFEST must say the gate tests ran in the pipeline's SEPARATE test job (tests=separate-job; the signing job only runs after that job succeeded) on a clean
#     tree with a matching lockfile (a hand-made --skip-tests/--allow-dirty build is never signed). Running jest in the same job that packages the tarball would let
#     any dev dependency rewrite the tarball afterwards, which is why the pipeline does not;
#   - the scripts that run as root on the worker (install.sh, deploy.sh, lib.sh, versions.env, the wrapper scripts, units, config template) must be
#     byte-for-byte the files in THIS checkout, which is what the reviewed merge contains;
#   - nothing else may be in the archive except the two esbuild bundles, the dist/ directory and the MANIFEST. Only the bundle itself remains trusted to the
#     build job (it is the product of the build, and cannot be compared without rebuilding).
set -euo pipefail

TAR=${1:?usage: login-host-verify-build.sh <tarball>}
: "${GITHUB_SHA:?GITHUB_SHA}" "${GITHUB_RUN_ID:?GITHUB_RUN_ID}"
REPO_ROOT=${AW_REPO_ROOT:-.}
D="$REPO_ROOT/backend/src/loginHost/deploy"
P="$D/prod"

fail() { echo "::error::login-host-verify-build: $*" >&2; exit 1; }

NAME="login-host-${GITHUB_SHA:0:12}"
[ "$(basename "$TAR")" = "$NAME.tar.gz" ] || fail "the tarball is named $(basename "$TAR"), expected $NAME.tar.gz for commit $GITHUB_SHA"

# Entries: plain files and directories only, all inside $NAME/, no absolute or parent paths.
LIST_V=$(tar -tvzf "$TAR")
while IFS= read -r line; do
  case "${line:0:1}" in - | d) ;; *) fail "the archive has an entry that is not a plain file or directory" ;; esac
done <<<"$LIST_V"
while IFS= read -r entry; do
  # (plain names only: tar escapes a newline or control character in a name, which shows up as a backslash and is refused here)
  [[ "$entry" =~ ^[A-Za-z0-9._@/-]+$ ]] || fail "the archive has an entry with unusual characters in its name"
  case "$entry" in
    /* | *..*) fail "the archive has an unsafe path" ;;
    "$NAME" | "$NAME"/*) ;;
    *) fail "the archive has an entry outside $NAME/" ;;
  esac
done < <(tar -tzf "$TAR")

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$TAR" -C "$WORK" --no-same-owner
PKG="$WORK/$NAME"
[ -d "$PKG" ] || fail "the archive does not unpack to $NAME/"

# The MANIFEST.
M="$PKG/MANIFEST"
[ -f "$M" ] || fail "no MANIFEST"
grep -q $'\r' "$M" && fail "the MANIFEST has carriage returns"
val() { awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$M"; } # first value of key=value, no pipe (an early-exiting reader under pipefail inverts matches)
[ "$(val name)" = "$NAME" ] || fail "MANIFEST name is '$(val name)'"
[ "$(val git_sha)" = "$GITHUB_SHA" ] || fail "MANIFEST git_sha is '$(val git_sha)', this run is $GITHUB_SHA"
[ "$(val build_seq)" = "$GITHUB_RUN_ID" ] || fail "MANIFEST build_seq is '$(val build_seq)', this run id is $GITHUB_RUN_ID"
[ -z "$(val dirty)" ] || fail "MANIFEST says the tree was dirty"
[ "$(val allow_dirty)" = 0 ] || fail "MANIFEST says --allow-dirty was used"
[ "$(val tests)" = separate-job ] || fail "MANIFEST says the gate tests were not run by the pipeline's separate test job ('$(val tests)')"
[ "$(val lockfile_check)" = ok ] || fail "MANIFEST says the lockfile check did not pass ('$(val lockfile_check)')"

# The root-run scripts and templates, against this checkout.
declare -A SRC=(
  [install.sh]="$P/install.sh" [deploy.sh]="$P/deploy.sh" [lib.sh]="$P/lib.sh" [versions.env]="$P/versions.env"
  [files/claude-turn.sh]="$D/claude-turn.sh" [files/aw-net.sh]="$D/aw-net.sh" [files/aw-write-file.sh]="$D/aw-write-file.sh" [files/aw-relay-shim.js]="$D/aw-relay-shim.js"
  [files/aw-login-host@.service]="$D/aw-login-host@.service" [files/aw-login-host-failed@.service]="$D/aw-login-host-failed@.service"
  [files/aw-env.slice.template]="$D/aw-env.slice.example" [files/host-config.template.json]="$P/host-config.template.json" [files/system-prompt.txt]="$P/system-prompt.txt"
)
for rel in "${!SRC[@]}"; do
  if [ ! -f "$PKG/$rel" ] || [ -L "$PKG/$rel" ]; then fail "the build is missing $rel (or it is not a plain file)"; fi
  cmp -s "$PKG/$rel" "${SRC[$rel]}" || fail "$rel in the build differs from the reviewed file in this commit"
done

# Nothing else.
while IFS= read -r -d '' f; do
  rel=${f#"$PKG"/}
  [[ "$rel" =~ ^[A-Za-z0-9._@/-]+$ ]] || fail "a file in the build has unusual characters in its name"
  case "$rel" in
    MANIFEST | check-config.js | deployctl.js | dist/loginHost/host/start.js) ;;
    *) [ -n "${SRC[$rel]:-}" ] || fail "unexpected file in the build: $rel" ;;
  esac
done < <(find "$PKG" -type f -print0)
[ -z "$(find "$PKG" ! -type f ! -type d)" ] || fail "the build contains something that is not a plain file or directory"

echo "login-host-verify-build: $NAME matches commit $GITHUB_SHA, run $GITHUB_RUN_ID, and the reviewed scripts"
