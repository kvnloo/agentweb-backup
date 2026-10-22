#!/usr/bin/env bash
# ENG-2110: asks the prod login worker to deploy an uploaded, signed build and waits for the verdict. Run by .github/workflows/login-host-deploy.yml.
#
#   login-host-run-deploy.sh <BuildKey> [max-wait-seconds]
#
# The worker's deploy waits for an idle moment (it never cuts a customer off), so "not idle" is expected sometimes and is retried here after a pause. What the
# worker's exit code means (worker deploy.sh):
#   0 deployed        75 host stayed busy: NOTHING changed, try again    4 a build with a higher number is already deployed: superseded (not a failure)
#   1 bad build, rolled back (FAIL)   2 bad build and rollback failed: host DOWN (FAIL, page)   3 bridge URL missing (FAIL)
#   20 the worker REFUSED the build (signature/name/layout: a security event, FAIL)   21 could not prepare (download/unpack; nothing ran, FAIL)
#   22 aborted before the restart (lock, install, gate: host not restarted, FAIL)   76 the running host cannot be gated (needs the one-time --force bootstrap, FAIL)
#   other: FAIL (the document itself failed: see the output)
# Env: INSTANCE_ID (required), AWS_REGION, DOC_NAME (default AW-LoginHost-Deploy-Signed), RETRIES (default 4), RETRY_PAUSE (default 300 s), POLL (default 15 s), AW_AWS.
set -euo pipefail

KEY=${1:?usage: login-host-run-deploy.sh <BuildKey> [max-wait-seconds]}
MAX_WAIT=${2:-1800}
if ! [[ "$MAX_WAIT" =~ ^[0-9]{1,4}$ ]] || [ "$MAX_WAIT" -gt 3600 ]; then
  echo "::error::max wait must be digits only, at most 3600 seconds"
  exit 1
fi
[[ "$KEY" =~ ^prod/builds/login-host-[0-9a-f]{12}\.tar\.gz$ ]] || { echo "::error::unexpected build key"; exit 1; }
INSTANCE_ID=${INSTANCE_ID:?INSTANCE_ID}
DOC=${DOC_NAME:-AW-LoginHost-Deploy-Signed}
RETRIES=${RETRIES:-4}
PAUSE=${RETRY_PAUSE:-300}
POLL=${POLL:-15}
AWS=${AW_AWS:-aws}
LIMIT_POLLS=${LIMIT_POLLS:-400} # ~100 minutes at 15 s; the document itself times out at 90

summary() { [ -z "${GITHUB_STEP_SUMMARY:-}" ] || printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"; }
annotate() { printf '::%s::%s\n' "$1" "$2"; }

errfile=$(mktemp)
trap 'rm -f "$errfile"' EXIT
errors=0
attempt=0
while :; do
  attempt=$((attempt + 1))
  echo "login-host-deploy: attempt $attempt of $RETRIES: $KEY on $INSTANCE_ID"
  cid=$("$AWS" ssm send-command --document-name "$DOC" --instance-ids "$INSTANCE_ID" \
    --parameters "BuildKey=$KEY,MaxWait=$MAX_WAIT" --comment "login-host deploy ${GITHUB_SHA:-manual}" \
    --query Command.CommandId --output text)
  [[ "$cid" =~ ^[0-9a-f-]{36}$ ]] || { annotate error "could not start the deploy command"; exit 1; }

  status=""
  for _ in $(seq 1 "$LIMIT_POLLS"); do
    sleep "$POLL"
    # Right after send-command the invocation may not exist yet (InvocationDoesNotExist): that is "pending". ANY other error (expired credentials, access
    # denied, throttling beyond a few tries) must surface, not be mistaken for a deploy that is still running.
    if ! status=$("$AWS" ssm get-command-invocation --command-id "$cid" --instance-id "$INSTANCE_ID" --query Status --output text 2>"$errfile"); then
      if grep -q InvocationDoesNotExist "$errfile"; then status=Pending; else
        errors=$((errors + 1))
        if [ "$errors" -ge 5 ]; then annotate error "cannot read the deploy's status ($(head -c 300 "$errfile")); the worker may have deployed: check it"; exit 1; fi
        status=Pending
      fi
    else
      errors=0
    fi
    case "$status" in Pending | InProgress | Delayed) continue ;; *) break ;; esac
  done
  inv=$("$AWS" ssm get-command-invocation --command-id "$cid" --instance-id "$INSTANCE_ID" --output json) || inv='{}'
  rc=$(printf '%s' "$inv" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ResponseCode", -1))' 2>/dev/null || echo -1)
  echo "----- worker output (exit $rc, status $status) -----"
  printf '%s' "$inv" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("StandardOutputContent") or "")[-20000:]); e=(d.get("StandardErrorContent") or "")[-6000:]; print(e) if e else None' 2>/dev/null || true

  case "$rc" in
    0)
      summary "Deployed \`$KEY\` to the login worker."
      exit 0
      ;;
    4)
      annotate notice "A build with a higher number is already deployed on the worker: this run was superseded, nothing changed."
      summary "Skipped: a newer build is already deployed."
      exit 0
      ;;
    75)
      if [ "$attempt" -ge "$RETRIES" ]; then
        annotate error "NOT DEPLOYED: the worker stayed busy for $attempt attempts. Nothing was changed. Re-run this workflow later (it waits for an idle moment again)."
        summary "NOT deployed: the worker was busy for the whole window. Nothing changed. Re-run later."
        exit 75
      fi
      echo "login-host-deploy: the worker was busy; nothing changed. Trying again in ${PAUSE}s."
      sleep "$PAUSE"
      ;;
    20)
      annotate error "The worker REFUSED this build (signature, name or layout did not check out). Treat this as a security event: nothing was run on the worker."
      summary "FAILED: the worker refused the build."
      exit 20
      ;;
    21)
      annotate error "The worker could not prepare the build (download or unpack failed); nothing was run. Read the output above."
      summary "FAILED: could not prepare."
      exit 21
      ;;
    22)
      annotate error "The deploy stopped BEFORE restarting the worker (lock held, install failed or the idle gate errored). The previous build is still serving. Read the output above."
      summary "FAILED before the restart."
      exit 22
      ;;
    76)
      annotate error "The running worker predates the drain protocol, so it cannot be gated. A person must do the one-time bootstrap with deploy.sh --force when nobody is using it."
      summary "FAILED: one-time bootstrap needed."
      exit 76
      ;;
    1)
      annotate error "The new build was NOT healthy on the worker and was ROLLED BACK. The previous build is serving. Read the worker output above."
      summary "FAILED: bad build, rolled back."
      exit 1
      ;;
    2)
      annotate error "The new build was not healthy AND the rollback failed: THE LOGIN WORKER MAY BE DOWN. Page someone now."
      summary "FAILED: worker down."
      exit 2
      ;;
    3)
      annotate error "Not installed: /etc/aw-login-host/bridge-url is missing on the worker."
      summary "FAILED: bridge url missing."
      exit 3
      ;;
    *)
      annotate error "The deploy command ended with status $status and exit code $rc (see the output above). The previous build is probably still serving."
      summary "FAILED: status $status / exit $rc."
      exit 1
      ;;
  esac
done
