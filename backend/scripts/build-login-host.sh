#!/usr/bin/env bash
# ENG-2110: builds the production login-host tarball from THIS checkout.
#
#   backend/scripts/build-login-host.sh [--out DIR]       (default DIR: backend/dist/login-host-builds)
#
# Output: DIR/login-host-<gitsha>.tar.gz and DIR/login-host-<gitsha>.tar.gz.sha256. The tarball is what the SSM document
# AW-LoginHost-Deploy-Prod downloads from s3://agentweb-login-host-992382574572/prod/builds/, verifies against the sha256 given to it,
# extracts and runs (install.sh at its top level). Contents: install.sh, versions.env, MANIFEST, check-config.js, the esbuild bundle of the
# host, and files/ (wrapper scripts, systemd unit, config template, system prompt). It never contains a secret; the build aborts if it sees
# private-key material. Reproducible for a given commit (mtime = commit time, sorted names, no gzip timestamp).
set -euo pipefail

OUT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) shift; OUT=${1:?--out needs a directory} ;;
    *) echo "build-login-host: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BACKEND=$(cd "$HERE/.." && pwd)
REPO=$(cd "$BACKEND/.." && pwd)
DEPLOY="$BACKEND/src/loginHost/deploy"
PROD="$DEPLOY/prod"
OUT=${OUT:-$BACKEND/dist/login-host-builds}

SHA=$(git -C "$REPO" rev-parse --short=12 HEAD)
EPOCH=$(git -C "$REPO" log -1 --format=%ct)
DIRTY=""
if [ -n "$(git -C "$REPO" status --porcelain -- backend/src/loginHost backend/scripts/build-login-host.sh)" ]; then
  DIRTY="-dirty"
  echo "build-login-host: WARNING: uncommitted changes under backend/src/loginHost: this build is NOT reproducible from the commit" >&2
fi
NAME="login-host-$SHA$DIRTY"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/$NAME"
mkdir -p "$STAGE/dist/loginHost/host" "$STAGE/files" "$OUT"

echo "build-login-host: bundling the host"
cd "$BACKEND"
ESBUILD=(npx --no-install esbuild --bundle --platform=node --target=node22 --log-level=error --external:@react-email/render '--external:*.node')
"${ESBUILD[@]}" src/loginHost/host/start.ts --outfile="$STAGE/dist/loginHost/host/start.js"

# The host's own config parser as a tiny stand-alone checker, so install.sh can validate the generated config before the host ever reads it.
"${ESBUILD[@]}" --loader=ts --sourcefile=check-config.ts --outfile="$STAGE/check-config.js" <<'TS'
import { readFileSync } from "fs";
import { parseHostConfig } from "./src/loginHost/host/hostConfig";
try {
  parseHostConfig(JSON.parse(readFileSync(process.argv[2], "utf8")));
  console.log("config ok");
} catch (e) {
  console.error(String((e as Error).message));
  process.exit(1);
}
TS

cp "$PROD/install.sh" "$PROD/versions.env" "$STAGE/"
cp "$DEPLOY/claude-turn.sh" "$DEPLOY/aw-net.sh" "$DEPLOY/aw-write-file.sh" "$DEPLOY/aw-login-host@.service" "$PROD/host-config.template.json" "$PROD/system-prompt.txt" "$STAGE/files/"
chmod 0755 "$STAGE/install.sh" "$STAGE/files/claude-turn.sh" "$STAGE/files/aw-net.sh" "$STAGE/files/aw-write-file.sh"

# Never ship key material.
if grep -R -l -E -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$STAGE" >/dev/null 2>&1; then
  echo "build-login-host: ABORT: private-key material found in the build" >&2
  exit 1
fi

{
  echo "name=$NAME"
  echo "git_sha=$(git -C "$REPO" rev-parse HEAD)"
  echo "dirty=${DIRTY:+yes}"
  echo "commit_time=$(date -u -d "@$EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
  echo "--- pinned versions (versions.env) ---"
  grep -E '^[A-Z0-9_]+=' "$PROD/versions.env"
  echo "--- sha256 of every file ---"
  (cd "$STAGE" && find . -type f ! -name MANIFEST | LC_ALL=C sort | while read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done)
} >"$STAGE/MANIFEST"

TAR="$OUT/$NAME.tar.gz"
(cd "$WORK" && tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner -cf - "$NAME" | gzip -n -9 >"$TAR")
(cd "$OUT" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256")
echo "build-login-host: wrote $TAR"
echo "build-login-host: $(cut -d' ' -f1 "$OUT/$NAME.tar.gz.sha256")  ($(du -h "$TAR" | cut -f1))"
