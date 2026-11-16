#!/bin/bash
# ENG-2110: the BODY of the SSM document AW-LoginHost-Deploy-Signed. It is the root of trust of every worker deploy: it runs as root on the machine that
# holds customers' Claude logins, and decides whether a build is allowed to run there. render-ssm-doc.js embeds this file in the document; a person with
# IAM rights installs the document ONCE (deploy/aws/README.md). Changing this file changes nothing on the worker until that happens again.
#
# What it accepts: a build that the deploy pipeline signed with the KMS key whose PUBLIC half is embedded below. The signature is checked on the bytes
# already on local disk, BEFORE anything is unpacked or run; nothing else (not the bucket, not the file name, not a sha256 typed by a person) is trusted.
# What it refuses: an unsigned or wrongly signed file, a name that is not exactly login-host-<12 hex>.tar.gz, an archive with absolute or `..` paths, a
# top directory that is not the one named, a MANIFEST that names another build. Then deploy.sh (in the signed archive) does the rest, including refusing
# to go back to an older build, waiting for an idle moment and rolling back a bad one.
#
# Parameters (the document constrains both with allowedPattern; they are re-checked here because SSM substitutes them as plain text):
#   BuildKey  prod/builds/login-host-<12 hex>.tar.gz     MaxWait  seconds the deploy may wait for the host to be idle
#
# The @@...@@ markers are filled by render-ssm-doc.js (and by the tests, with scratch paths).
set -euo pipefail
umask 077

BUILD_KEY='{{ BuildKey }}'
MAX_WAIT='{{ MaxWait }}'
BUCKET='@@BUCKET@@'
WORK_BASE='@@WORK_BASE@@'
AWS=@@AWS@@
OPENSSL=@@OPENSSL@@

# Exit codes beyond deploy.sh's own: 20 = REFUSED (bad signature, name, layout: treat as a security event), 21 = could not prepare (download, unpack: nothing ran).
# Anything unexpected before deploy.sh starts is mapped to 21 by the EXIT trap, so a failing tool (tar and aws also exit 2) is never mistaken for deploy.sh's "host DOWN".
PHASE=prepare
WORK=""
on_exit() {
  local rc=$?
  if [ "$PHASE" = prepare ]; then
    [ -z "$WORK" ] || rm -rf "$WORK"
    if [ "$rc" != 0 ] && [ "$rc" != 20 ]; then echo "aw-deploy: could not prepare the build (exit $rc); nothing was run" >&2; exit 21; fi
  fi
}
trap on_exit EXIT
die() { echo "aw-deploy: REFUSED: $*" >&2; exit 20; }

# The tools it needs must be there; a missing one is "could not prepare" (21), never mistaken for a bad signature (20).
[ -x "$AWS" ] && [ -x "$OPENSSL" ] || { echo "aw-deploy: aws or openssl is missing on this machine; nothing was run" >&2; exit 21; }

[[ "$BUILD_KEY" =~ ^prod/builds/(login-host-[0-9a-f]{12})\.tar\.gz$ ]] || die "BuildKey is not prod/builds/login-host-<12 hex>.tar.gz"
NAME=${BASH_REMATCH[1]}
[[ "$MAX_WAIT" =~ ^(0|[1-9][0-9]{0,3})$ ]] && [ "$MAX_WAIT" -le 3000 ] || die "MaxWait is not a number of seconds between 0 and 3000"

WORK=$(mktemp -d "$WORK_BASE/aw-deploy.XXXXXX") # mode 0700, fresh, root-owned, never predictable or shared

# The public half of the pipeline's signing key (KMS asymmetric ECC_NIST_P256, SIGN_VERIFY). Rotating the key means installing the document again.
cat >"$WORK/signer.pub.pem" <<'PUBKEY'
@@PUBLIC_KEY@@
PUBKEY

"$AWS" s3 cp --only-show-errors "s3://$BUCKET/$BUILD_KEY" "$WORK/build.tar.gz"
"$AWS" s3 cp --only-show-errors "s3://$BUCKET/$BUILD_KEY.sig" "$WORK/build.sig"

# Size sanity before any parsing (a build is a few MB).
size=$(stat -c %s "$WORK/build.tar.gz")
[ "$size" -gt 0 ] && [ "$size" -lt 209715200 ] || die "the build is empty or implausibly large ($size bytes)"
sig_size=$(stat -c %s "$WORK/build.sig")
[ "$sig_size" -gt 0 ] && [ "$sig_size" -lt 1024 ] || die "the signature file has an implausible size"

# The signature over the sha256 of exactly these bytes. Anything but a clean "Verified OK" is a refusal.
verdict=$("$OPENSSL" dgst -sha256 -verify "$WORK/signer.pub.pem" -signature "$WORK/build.sig" "$WORK/build.tar.gz" 2>&1 || true)
[ "$verdict" = "Verified OK" ] || die "the signature does not verify (not built and signed by the deploy pipeline)"
echo "aw-deploy: signature verified for $NAME"

# The archive layout, checked as text before a single byte is extracted: only regular files and directories (no links, devices or fifos), one top directory
# with the expected name, no absolute or parent paths.
tar -tvzf "$WORK/build.tar.gz" >"$WORK/listing.v"
[ -s "$WORK/listing.v" ] || die "the archive is empty"
while IFS= read -r line; do
  case "${line:0:1}" in - | d) ;; *) die "the archive has an entry that is not a plain file or directory" ;; esac
done <"$WORK/listing.v"
tar -tzf "$WORK/build.tar.gz" >"$WORK/listing"
while IFS= read -r entry; do
  case "$entry" in
    /* | *..*) die "the archive has an unsafe path" ;;
    "$NAME" | "$NAME"/*) ;;
    *) die "the archive has an entry outside $NAME/" ;;
  esac
done <"$WORK/listing"

mkdir "$WORK/x"
tar -xzf "$WORK/build.tar.gz" -C "$WORK/x" --no-same-owner --no-overwrite-dir
PKG="$WORK/x/$NAME"
[ -d "$PKG" ] && [ ! -L "$PKG" ] || die "the archive does not unpack to $NAME/"
[ -f "$PKG/deploy.sh" ] && [ ! -L "$PKG/deploy.sh" ] || die "the build has no deploy.sh"
grep -qx "name=$NAME" "$PKG/MANIFEST" || die "the MANIFEST names a different build"
chmod -R go-w "$PKG"

# Not exec: deploy.sh must outlive nothing of ours, but its exit code is the document's result (and the lock inside it is released by it).
cd "$PKG"
PHASE=deploy
exec_rc=0
bash ./deploy.sh --max-wait "$MAX_WAIT" || exec_rc=$?
echo "aw-deploy: deploy.sh finished with exit code $exec_rc"
rm -rf "$WORK"
exit "$exec_rc"
