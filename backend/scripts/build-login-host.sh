#!/usr/bin/env bash
# ENG-2110: builds the production login-host tarball from THIS checkout.
#
#   backend/scripts/build-login-host.sh [--out DIR] [--skip-tests] [--allow-dirty]       (default DIR: backend/dist/login-host-builds)
#
# Output: DIR/login-host-<gitsha>.tar.gz and DIR/login-host-<gitsha>.tar.gz.sha256. The tarball is what the SSM document
# AW-LoginHost-Deploy-Signed downloads from s3://agentweb-login-host-992382574572/prod/builds/, verifies against the sha256 given to it,
# extracts into a fresh root-owned 0700 directory and runs (install.sh at its top level). Contents: install.sh, deploy.sh (install + idle gate + restart + health + rollback), lib.sh, versions.env, MANIFEST,
# check-config.js, deployctl.js, the esbuild bundle of the host, and files/ (wrapper scripts, systemd units, config and slice templates, system prompt).
# It never contains a secret and nothing machine-specific (the worker's address is read at install time); the build aborts if it sees private-key
# material. Reproducible for a given commit (mtime = commit time, sorted names, no gzip timestamp).
#
# THE BUILD IS THE GATE. It refuses to package when
#   - the repo's own gate tests fail (deploy scripts, host, tool relay, adapter, shim, wrapper, stream guards, mutual TLS, drain)                      override: --skip-tests   (recorded in the MANIFEST)
#   - anything under backend/ is uncommitted                                                    override: --allow-dirty (recorded in the MANIFEST)
#   - a package that ends up in the bundle is not the version package-lock.json pins            override: --allow-dirty (recorded in the MANIFEST)
set -euo pipefail

OUT=""
SKIP_TESTS=0
ALLOW_DIRTY=0
TESTS_ELSEWHERE=0
TESTS_ONLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) shift; OUT=${1:?--out needs a directory} ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --tests-run-elsewhere) TESTS_ELSEWHERE=1 ;;
    --tests-only) TESTS_ONLY=1 ;;
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

# (1) a clean tree: the commit hash must describe what is in the tarball. Everything under backend/ counts (the bundle pulls in modules from all over it).
DIRTY=""
if [ -n "$(git -C "$REPO" status --porcelain -- backend)" ]; then
  if [ "$ALLOW_DIRTY" = 1 ]; then
    DIRTY="-dirty"
    echo "build-login-host: WARNING: uncommitted changes under backend/ (--allow-dirty): this build is NOT reproducible from the commit" >&2
  else
    echo "build-login-host: ABORT: uncommitted changes under backend/ (commit them, or pass --allow-dirty for a throwaway build):" >&2
    git -C "$REPO" status --short -- backend | head -20 >&2
    exit 1
  fi
fi
NAME="login-host-$SHA$DIRTY"

cd "$BACKEND"

# (2) the gate tests.
# In the pipeline the tests run in their OWN job (--tests-only) that produces nothing, and the job that makes the tarball runs with --tests-run-elsewhere: jest
# loads every dev dependency, and code that runs in the same job as the packaging could rewrite the tarball afterwards. The signing job only runs once the test
# job has succeeded, which is what makes the MANIFEST value below true.
TESTS="passed"
if [ "$TESTS_ELSEWHERE" = 1 ]; then
  TESTS="separate-job"
elif [ "$SKIP_TESTS" = 1 ]; then
  TESTS="SKIPPED (--skip-tests)"
  echo "build-login-host: WARNING: the gate tests were SKIPPED (--skip-tests); this is recorded in the MANIFEST" >&2
else
  echo "build-login-host: running the gate tests"
  # Besides the deploy scripts, the host and mutual TLS, the gate runs the tool relay's tests: the relay (socket, limits, abuse; "__tests__/relay" also matches the shim and
  # protocol tests), the Claude adapter and its parser, the turn wrapper, the guards on the CLI's streams (with the fast, mocked-clock CPU meter pins), the connection manager and the HTTP server ("__tests__/connectionManager" and "__tests__/server"
  # also match their split files), and the ports (the systemd unit arguments of a customer unit: a mutant that turned a read-only bind into a writable one passed this gate). Without them a mutant that leaves a relay directory behind, drops a guard, un-meters the stdout scan or removes the manager tick's catch passed this gate. (The slow real-process CPU suite, cpuBudget.test.ts, stays in the normal test run.)
  npx --no-install jest src/loginHost/__tests__/deploy src/loginHost/__tests__/host src/loginHost/__tests__/relay src/loginHost/__tests__/claudeAdapter src/loginHost/__tests__/claudeParse src/loginHost/__tests__/wrapperManifest src/loginHost/__tests__/closePipes src/loginHost/__tests__/cpuPins src/loginHost/__tests__/drainAccount src/loginHost/__tests__/lineFuzz src/loginHost/__tests__/lineFlood src/loginHost/__tests__/deepLines src/loginHost/__tests__/connectionManager src/loginHost/__tests__/server src/loginHost/__tests__/ports src/services/funding/__tests__/loginHostMutualTls.test.ts --silent \
    || { echo "build-login-host: ABORT: the gate tests failed; nothing was packaged" >&2; exit 1; }
fi

if [ "$TESTS_ONLY" = 1 ]; then
  echo "build-login-host: the gate tests passed (--tests-only: nothing was packaged)"
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/$NAME"
mkdir -p "$STAGE/dist/loginHost/host" "$STAGE/files" "$OUT"

echo "build-login-host: bundling the host"
ESBUILD=(npx --no-install esbuild --bundle --platform=node --target=node22 --log-level=error --external:@react-email/render '--external:*.node')
ESBUILD_VERSION=$(npx --no-install esbuild --version)
"${ESBUILD[@]}" src/loginHost/host/start.ts --outfile="$STAGE/dist/loginHost/host/start.js" --metafile="$WORK/meta-start.json"
# The host's own config parser as a tiny stand-alone checker, so install.sh can validate the generated config before the host ever reads it.
"${ESBUILD[@]}" src/loginHost/deploy/prod/check-config.ts --outfile="$STAGE/check-config.js" --metafile="$WORK/meta-check.json"
# The deploy's window into the running host (idle gate, health check), run by deploy.sh over the host's unix socket.
"${ESBUILD[@]}" src/loginHost/deploy/prod/deployCtl.ts --outfile="$STAGE/deployctl.js" --metafile="$WORK/meta-ctl.json"

# (3) every npm package that ended up in the bundle must be the version package-lock.json pins (the build must be reproducible from the lockfile, not from
# whatever happens to be in node_modules).
LOCK_SHA=$(sha256sum package-lock.json | cut -d' ' -f1)
LOCK_CHECK="ok"
if ! node - "$WORK/meta-start.json" "$WORK/meta-check.json" "$WORK/meta-ctl.json" <<'JS'
const fs = require("fs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")).packages;
const pkgs = new Set();
for (const m of process.argv.slice(2)) {
  for (const input of Object.keys(JSON.parse(fs.readFileSync(m, "utf8")).inputs)) {
    const i = input.lastIndexOf("node_modules/");
    if (i < 0) continue;
    const rest = input.slice(i + "node_modules/".length).split("/");
    const name = rest[0].startsWith("@") ? rest.slice(0, 2).join("/") : rest[0];
    pkgs.add(input.slice(0, i + "node_modules/".length) + name);
  }
}
const bad = [];
for (const dir of pkgs) {
  const key = dir.slice(dir.indexOf("node_modules/")); // npm layout: node_modules/<pkg> or node_modules/<a>/node_modules/<b>, wherever the tree is rooted
  const entry = lock[key];
  let installed = null;
  try { installed = JSON.parse(fs.readFileSync(dir + "/package.json", "utf8")).version; } catch { /* a symlinked or missing package */ }
  if (!entry || entry.version !== installed) bad.push(`${key}: lockfile ${entry ? entry.version : "(absent)"} vs installed ${installed}`);
}
if (bad.length) { console.error(bad.slice(0, 20).join("\n")); process.exit(1); }
console.log(`lockfile check: ${pkgs.size} bundled packages match package-lock.json`);
JS
then
  if [ "$ALLOW_DIRTY" = 1 ]; then
    LOCK_CHECK="MISMATCH (--allow-dirty)"
    DIRTY="-dirty"
    NAME="login-host-$SHA$DIRTY"
    echo "build-login-host: WARNING: bundled packages differ from package-lock.json (--allow-dirty); recorded in the MANIFEST" >&2
  else
    echo "build-login-host: ABORT: node_modules does not match package-lock.json for the packages in the bundle (run npm ci, or --allow-dirty for a throwaway build)" >&2
    exit 1
  fi
fi
# The directory name may have changed above (dirty): rebuild the staging path.
if [ "$STAGE" != "$WORK/$NAME" ]; then mv "$STAGE" "$WORK/$NAME"; STAGE="$WORK/$NAME"; fi

cp "$PROD/install.sh" "$PROD/deploy.sh" "$PROD/lib.sh" "$PROD/versions.env" "$STAGE/"
cp "$DEPLOY/claude-turn.sh" "$DEPLOY/aw-net.sh" "$DEPLOY/aw-write-file.sh" "$DEPLOY/aw-relay-shim.js" "$DEPLOY/aw-login-host@.service" "$DEPLOY/aw-login-host-failed@.service" \
  "$PROD/host-config.template.json" "$PROD/system-prompt.txt" "$STAGE/files/"
cp "$DEPLOY/aw-env.slice.example" "$STAGE/files/aw-env.slice.template"
chmod 0755 "$STAGE/install.sh" "$STAGE/deploy.sh" "$STAGE/files/claude-turn.sh" "$STAGE/files/aw-net.sh" "$STAGE/files/aw-write-file.sh" "$STAGE/files/aw-relay-shim.js"
chmod 0644 "$STAGE/lib.sh"

# Never ship key material.
if grep -R -l -E -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$STAGE" >/dev/null 2>&1; then
  echo "build-login-host: ABORT: private-key material found in the build" >&2
  exit 1
fi

{
  echo "name=$NAME"
  echo "git_sha=$(git -C "$REPO" rev-parse HEAD)"
  echo "dirty=${DIRTY:+yes}"
  echo "allow_dirty=$ALLOW_DIRTY"
  echo "tests=$TESTS"
  echo "lockfile_check=$LOCK_CHECK"
  echo "package_lock_sha256=$LOCK_SHA"
  echo "esbuild=$ESBUILD_VERSION"
  echo "build_node=$(node --version)"
  echo "commit_time=$(date -u -d "@$EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
  # The pipeline's run id: set by GitHub (not by whoever authored the commit), repository-wide and not reset by renaming a workflow, increasing over time.
  # deploy.sh refuses a build whose number is lower than the last one deployed (a signed OLD build must not be a way to downgrade). The SIGNING job checks this
  # value against its own GITHUB_RUN_ID before it signs, because this script runs in the job that executes npm code. Empty for a build made by hand, which
  # deploy.sh refuses (exit 5).
  echo "build_seq=${GITHUB_RUN_ID:-}"
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
