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
    if [ -f "$WORK/inv-error" ]; then cat "$WORK/inv-error" >&2; exit 254; fi
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
[ "$(run 4)" = 0 ] && [ "$(sends)" = 1 ] && grep -q "::warning::SKIPPED" "$WORK/out" && grep -q "HIGHER number" "$WORK/out" && ok "an older build is a loud warning and a skip, not a failure and not a quiet success" || bad "superseded"
[ "$(run 5)" = 5 ] && [ "$(sends)" = 1 ] && ok "a build with no pipeline number is a failure" || bad "no number"
[ "$(run 24)" = 24 ] && ok "a failure after the restart began is reported as such" || bad "24"
[ "$(run 1)" = 1 ] && [ "$(sends)" = 1 ] && grep -q "ROLLED BACK" "$WORK/out" && ok "bad build: fails, is NOT retried" || bad "bad build"
[ "$(run 2)" = 2 ] && [ "$(sends)" = 1 ] && grep -q "DOWN" "$WORK/out" && ok "worker down: fails loudly, not retried" || bad "down"
[ "$(run 3)" = 3 ] && [ "$(sends)" = 1 ] && ok "bridge url missing: fails" || bad "bridge"
[ "$(run 20)" = 20 ] && [ "$(sends)" = 1 ] && grep -q "security event" "$WORK/out" && ok "a refused build is reported as a security event, not retried" || bad "refused"
[ "$(run 21)" = 21 ] && ok "could not prepare" || bad "prepare"
[ "$(run 22)" = 22 ] && grep -q "BEFORE restarting" "$WORK/out" && ok "aborted before restart" || bad "pre-restart"
[ "$(run 76)" = 76 ] && ok "needs bootstrap" || bad "76"
printf '1\n' >"$WORK/rcs"; : >"$WORK/calls"; echo "An error occurred (ExpiredTokenException) when calling the GetCommandInvocation operation" >"$WORK/inv-error"
AW_AWS="$WORK/aws" INSTANCE_ID=i-123 POLL=0 RETRY_PAUSE=0 RETRIES=3 bash "$SCRIPT" prod/builds/login-host-0123456789ab.tar.gz 600 >"$WORK/out" 2>&1; rc=$?
[ "$rc" = 1 ] && grep -q "cannot read the deploy's status" "$WORK/out" && ok "expired credentials surface as an error, not an endless wait" || bad "expired creds (rc=$rc)"
echo "An error occurred (InvocationDoesNotExist) when calling the GetCommandInvocation operation" >"$WORK/inv-error"
( sleep 1; rm -f "$WORK/inv-error" ) & 
printf '0\n' >"$WORK/rcs"; : >"$WORK/calls"
AW_AWS="$WORK/aws" INSTANCE_ID=i-123 POLL=0.3 RETRY_PAUSE=0 RETRIES=3 bash "$SCRIPT" prod/builds/login-host-0123456789ab.tar.gz 600 >"$WORK/out" 2>&1; rc=$?
[ "$rc" = 0 ] && ok "a not-yet-existing invocation is treated as pending" || bad "pending (rc=$rc)"
wait
rm -f "$WORK/inv-error"
AW_AWS="$WORK/aws" INSTANCE_ID=i-123 bash "$SCRIPT" prod/builds/login-host-0123456789ab.tar.gz "1800; reboot" >/dev/null 2>&1; [ $? = 1 ] && ok "refuses a bad max wait" || bad "max wait"
AW_AWS="$WORK/aws" INSTANCE_ID=i-123 bash "$SCRIPT" prod/builds/login-host-0123456789ab.tar.gz 3001 >/dev/null 2>&1; [ $? = 1 ] && ok "refuses a max wait over 3000 s" || bad "max wait cap"
for v in 0800 0900 0700 00 01; do
  out=$(AW_AWS="$WORK/aws" INSTANCE_ID=i-123 bash "$SCRIPT" prod/builds/login-host-0123456789ab.tar.gz "$v" 2>&1); rc=$?
  if [ "$rc" = 1 ] && grep -q "without leading zeros" <<<"$out"; then ok "refuses a max wait with a leading zero ($v): bash would read it as octal"; else bad "leading zero $v (rc=$rc)"; fi
done
printf '75\n75\n75\n' >"$WORK/rcs"; : >"$WORK/calls"
AW_AWS="$WORK/aws" INSTANCE_ID=i-123 POLL=0 RETRY_PAUSE=0 RETRIES=3 AW_BUDGET_SEC=100 bash "$SCRIPT" prod/builds/login-host-0123456789ab.tar.gz 600 >"$WORK/out" 2>&1; rc=$?
[ "$rc" = 75 ] && [ "$(sends)" = 1 ] && ok "no further attempt is started that could outlive the AWS credentials" || bad "budget (rc=$rc sends=$(sends))"
printf '0\n' >"$WORK/rcs"; : >"$WORK/calls"
if AW_AWS="$WORK/aws" INSTANCE_ID=i-123 POLL=0 RETRY_PAUSE=0 bash "$SCRIPT" prod/builds/login-host-0123456789ab.tar.gz 0 >/dev/null 2>&1; then ok "a max wait of 0 is allowed"; else bad "zero wait"; fi
AW_AWS="$WORK/aws" INSTANCE_ID=i-123 bash "$SCRIPT" "prod/builds/../x" 60 >/dev/null 2>&1; [ $? = 1 ] && ok "refuses a bad build key" || bad "key"
[ "$(run 137)" = 1 ] && ok "an unknown exit code is a failure" || bad "unknown"
bash -n "$SCRIPT" && ok "parses" || bad "parse"
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
