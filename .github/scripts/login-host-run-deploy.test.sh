#!/usr/bin/env bash
# Tests for login-host-run-deploy.sh with a fake `aws`. Run: bash .github/scripts/login-host-run-deploy.test.sh
# shellcheck disable=SC2015 # "A && B || C" is the assertion idiom here: C reports the failure
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/login-host-run-deploy.sh"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0
ok() { pass=$((pass + 1)); echo "PASS $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }

# fake aws: send-command counts calls; get-command-invocation answers from $WORK/rcs (one exit code per command, in order)
cat >"$WORK/aws" <<FAKE
#!/bin/bash
echo "\$*" >> "$WORK/calls"
case "\$1 \$2" in
  "ssm send-command")
    n=\$(grep -c 'ssm send-command' "$WORK/calls")
    printf '%08d-0000-0000-0000-000000000000\n' "\$n"; exit 0 ;;
  "ssm get-command-invocation")
    n=\$(echo "\$*" | sed -n 's/.*--command-id 0*\([0-9]*\)-.*/\1/p')
    rc=\$(sed -n "\${n}p" "$WORK/rcs")
    case "\$*" in
      *"--query Status"*) [ "\$rc" = "0" ] && echo Success || echo Failed ;;
      *) echo "{\"ResponseCode\": \$rc, \"StandardOutputContent\": \"worker said hi\", \"StandardErrorContent\": \"\"}" ;;
    esac; exit 0 ;;
esac
exit 9
FAKE
chmod +x "$WORK/aws"

run() { # run <rcs...>; prints exit code
  printf '%s\n' "$@" >"$WORK/rcs"; : >"$WORK/calls"
  AW_AWS="$WORK/aws" INSTANCE_ID=i-123 POLL=0 RETRY_PAUSE=0 RETRIES=3 bash "$SCRIPT" prod/builds/login-host-0123456789ab.tar.gz 600 >"$WORK/out" 2>&1
  echo $?
}
sends() { grep -c 'ssm send-command' "$WORK/calls"; }

[ "$(run 0)" = 0 ] && [ "$(sends)" = 1 ] && ok "success on the first attempt" || bad "success"
grep -q "BuildKey=prod/builds/login-host-0123456789ab.tar.gz,MaxWait=600" "$WORK/calls" && ok "passes the key and wait limit" || bad "parameters"
grep -q "worker said hi" "$WORK/out" && ok "prints the worker output" || bad "output"
[ "$(run 75 75 0)" = 0 ] && [ "$(sends)" = 3 ] && ok "busy twice, then deployed" || bad "busy then ok"
[ "$(run 75 75 75)" = 75 ] && [ "$(sends)" = 3 ] && ok "always busy: gives up with 75 after the retries (nothing forced)" || bad "always busy"
[ "$(run 4)" = 0 ] && [ "$(sends)" = 1 ] && grep -q "newer build is already deployed" "$WORK/out" && ok "an older build is a skip, not a failure" || bad "superseded"
[ "$(run 1)" = 1 ] && [ "$(sends)" = 1 ] && grep -q "ROLLED BACK" "$WORK/out" && ok "bad build: fails, is NOT retried" || bad "bad build"
[ "$(run 2)" = 2 ] && [ "$(sends)" = 1 ] && grep -q "DOWN" "$WORK/out" && ok "worker down: fails loudly, not retried" || bad "down"
[ "$(run 3)" = 3 ] && [ "$(sends)" = 1 ] && ok "bridge url missing: fails" || bad "bridge"
[ "$(run 137)" = 1 ] && ok "an unknown exit code is a failure" || bad "unknown"
bash -n "$SCRIPT" && ok "parses" || bad "parse"
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
