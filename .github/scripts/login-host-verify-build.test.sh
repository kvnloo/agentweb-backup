#!/usr/bin/env bash
# shellcheck disable=SC2015 # "A && B || C" is the assertion idiom here: C reports the failure
# Tests for login-host-verify-build.sh against tarballs made from the REAL files of this checkout. Run: bash .github/scripts/login-host-verify-build.test.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SCRIPT="$HERE/login-host-verify-build.sh"
D="$ROOT/backend/src/loginHost/deploy"
P="$D/prod"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0
ok() { pass=$((pass + 1)); echo "PASS $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }

SHA=0123456789abcdef0123456789abcdef01234567
NAME=login-host-${SHA:0:12}
RUN=123456789

mkpkg() { # mkpkg <dir>: a good package laid out like the real build
  local d=$1
  rm -rf "$d"; mkdir -p "$d/$NAME/files" "$d/$NAME/dist/loginHost/host"
  cp "$P/install.sh" "$P/deploy.sh" "$P/lib.sh" "$P/versions.env" "$d/$NAME/"
  cp "$D/claude-turn.sh" "$D/aw-net.sh" "$D/aw-write-file.sh" "$D/aw-relay-shim.js" "$D/aw-login-host@.service" "$D/aw-login-host-failed@.service" "$d/$NAME/files/"
  cp "$D/aw-env.slice.example" "$d/$NAME/files/aw-env.slice.template"
  cp "$P/host-config.template.json" "$P/system-prompt.txt" "$d/$NAME/files/"
  echo "// bundle" >"$d/$NAME/dist/loginHost/host/start.js"; echo "// c" >"$d/$NAME/check-config.js"; echo "// d" >"$d/$NAME/deployctl.js"
  printf 'name=%s\ngit_sha=%s\ndirty=\nallow_dirty=0\ntests=separate-job\nlockfile_check=ok\nbuild_seq=%s\n' "$NAME" "$SHA" "$RUN" >"$d/$NAME/MANIFEST"
}
pack() { (cd "$1" && tar -czf "$2" "$NAME"); }
verify() { GITHUB_SHA=$SHA GITHUB_RUN_ID=$RUN AW_REPO_ROOT="$ROOT" bash "$SCRIPT" "$1" >"$WORK/out" 2>&1; }
expect_fail() { # expect_fail <description> <needle>
  if verify "$WORK/$NAME.tar.gz"; then bad "$1 (was accepted!)"; elif grep -q "$2" "$WORK/out"; then ok "$1"; else bad "$1 (failed for another reason: $(tail -1 "$WORK/out"))"; fi
}

mkpkg "$WORK/p"; pack "$WORK/p" "$WORK/$NAME.tar.gz"
verify "$WORK/$NAME.tar.gz" && ok "a good build is accepted" || bad "good build rejected: $(tail -2 "$WORK/out")"

for f in install.sh deploy.sh lib.sh versions.env files/aw-net.sh files/aw-relay-shim.js files/aw-login-host@.service files/host-config.template.json; do
  mkpkg "$WORK/p"; echo "# tampered" >>"$WORK/p/$NAME/$f"; pack "$WORK/p" "$WORK/$NAME.tar.gz"
  expect_fail "a tampered $f is refused" "differs from the reviewed file"
done
mkpkg "$WORK/p"; rm "$WORK/p/$NAME/deploy.sh"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a missing deploy.sh is refused" "missing deploy.sh"
mkpkg "$WORK/p"; echo x >"$WORK/p/$NAME/extra.sh"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "an extra file is refused" "unexpected file"
mkpkg "$WORK/p"; echo x >"$WORK/p/$NAME/files/extra.sh"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "an extra file in files/ is refused" "unexpected file"
mkpkg "$WORK/p"; ln -s /etc/passwd "$WORK/p/$NAME/link"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a symlink is refused" "not a plain file"
mkpkg "$WORK/p"; sed -i "s/^git_sha=.*/git_sha=ffffffffffffffffffffffffffffffffffffffff/" "$WORK/p/$NAME/MANIFEST"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a MANIFEST for another commit is refused" "git_sha"
mkpkg "$WORK/p"; sed -i "s/^build_seq=.*/build_seq=99999999999999999999/" "$WORK/p/$NAME/MANIFEST"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a build number the build job chose is refused" "build_seq"
mkpkg "$WORK/p"; sed -i "s/^build_seq=.*/build_seq=/" "$WORK/p/$NAME/MANIFEST"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "an empty build number is refused" "build_seq"
mkpkg "$WORK/p"; sed -i "s/^tests=.*/tests=passed/" "$WORK/p/$NAME/MANIFEST"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "tests run inside the packaging job (not the separate job) are refused" "separate test job"
mkpkg "$WORK/p"; sed -i "s/^tests=.*/tests=SKIPPED (--skip-tests)/" "$WORK/p/$NAME/MANIFEST"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a build whose tests were skipped is refused" "separate test job"
mkpkg "$WORK/p"; sed -i "s/^allow_dirty=.*/allow_dirty=1/" "$WORK/p/$NAME/MANIFEST"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a --allow-dirty build is refused" "allow-dirty"
mkpkg "$WORK/p"; sed -i "s/^dirty=.*/dirty=yes/" "$WORK/p/$NAME/MANIFEST"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a dirty-tree build is refused" "dirty"
mkpkg "$WORK/p"; sed -i "s/^lockfile_check=.*/lockfile_check=MISMATCH/" "$WORK/p/$NAME/MANIFEST"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a lockfile mismatch is refused" "lockfile"
mkpkg "$WORK/p"; ln "$WORK/p/$NAME/deploy.sh" "$WORK/p/$NAME/hard.sh"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a hard link is refused" "not a plain file"
mkpkg "$WORK/p"; mkfifo "$WORK/p/$NAME/fifo"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a fifo is refused" "not a plain file"
mkpkg "$WORK/p"; printf x >"$WORK/p/$NAME/$(printf 'deploy.sh\nMANIFEST')"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a file name containing a newline is refused" "unusual characters"
mkpkg "$WORK/p"; printf x >"$WORK/p/$NAME/spa ce"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a file name with a space is refused" "unusual characters"
mkpkg "$WORK/p"; sed -i 's/$/\r/' "$WORK/p/$NAME/MANIFEST"; pack "$WORK/p" "$WORK/$NAME.tar.gz"; expect_fail "a CRLF MANIFEST is refused" "carriage returns"
mkpkg "$WORK/p"; (cd "$WORK/p" && tar -czf "$WORK/$NAME.tar.gz" --transform "s,^$NAME/install.sh,$NAME/../install.sh," "$NAME"); expect_fail "a parent-directory path in the archive is refused" "unsafe path"
mkpkg "$WORK/p"; mv "$WORK/p/$NAME" "$WORK/p/login-host-aaaaaaaaaaaa"; (cd "$WORK/p" && tar -czf "$WORK/$NAME.tar.gz" login-host-aaaaaaaaaaaa); expect_fail "an archive with another top directory is refused" "outside"
mkpkg "$WORK/p"; pack "$WORK/p" "$WORK/other-name.tar.gz"
verify "$WORK/other-name.tar.gz" && bad "a wrongly named tarball was accepted" || { grep -q "expected" "$WORK/out" && ok "a wrongly named tarball is refused" || bad "wrong name: $(tail -1 "$WORK/out")"; }
bash -n "$SCRIPT" && ok "parses" || bad "parse"
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
