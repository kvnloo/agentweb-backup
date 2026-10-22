#!/usr/bin/env bash
# ENG-2110: signs a login-host build with the pipeline's KMS key. Run by .github/workflows/login-host-deploy.yml; the CI role is the only principal the key
# policy lets call kms:Sign, and the worker's deploy document only runs builds this signature verifies for.
#
#   backend/scripts/sign-login-host.sh <login-host-XXXX.tar.gz> <kms-key-id-or-alias>      writes <tarball>.sig next to it
#
# KMS signs the sha256 DIGEST with ECDSA_SHA_256 (the tarball never leaves the runner); the result is verified here against the key's own public half
# before it is trusted, so a misconfigured key (wrong algorithm, wrong key) fails the pipeline instead of producing a build the worker will refuse.
set -euo pipefail

TAR=${1:?usage: sign-login-host.sh <tarball> <kms-key-id>}
KEY=${2:?usage: sign-login-host.sh <tarball> <kms-key-id>}
AWS=${AW_AWS:-aws}
[ -f "$TAR" ] || { echo "sign-login-host: $TAR does not exist" >&2; exit 1; }
case "$(basename "$TAR")" in
  login-host-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].tar.gz) ;;
  *) echo "sign-login-host: refusing to sign $(basename "$TAR"): only login-host-<12 hex>.tar.gz (a clean, committed build) is ever signed" >&2; exit 1 ;;
esac

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
openssl dgst -sha256 -binary "$TAR" >"$WORK/digest.bin"
"$AWS" kms sign --key-id "$KEY" --message "fileb://$WORK/digest.bin" --message-type DIGEST --signing-algorithm ECDSA_SHA_256 --output text --query Signature >"$WORK/sig.b64"
base64 -d "$WORK/sig.b64" >"$WORK/sig.bin"

# Self-check against the key's public half (what the worker's document holds a copy of).
"$AWS" kms get-public-key --key-id "$KEY" --output text --query PublicKey | base64 -d >"$WORK/pub.der"
openssl pkey -pubin -inform DER -in "$WORK/pub.der" -out "$WORK/pub.pem"
if [ "$(openssl dgst -sha256 -verify "$WORK/pub.pem" -signature "$WORK/sig.bin" "$TAR" 2>&1)" != "Verified OK" ]; then
  echo "sign-login-host: the KMS signature does not verify against the key's public half: wrong key or algorithm?" >&2
  exit 1
fi
cp "$WORK/sig.bin" "$TAR.sig"
echo "sign-login-host: signed $(basename "$TAR") ($(openssl pkey -pubin -in "$WORK/pub.pem" -noout -text | head -n1))"
