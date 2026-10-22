#!/usr/bin/env bash
# ENG-2110: the ONE-TIME AWS setup of the automatic login-worker deploy. Run by a person with IAM/KMS/SSM administration (not by CI, not by the build
# pipeline, never again for ordinary deploys). Prints what it will do and changes nothing unless --apply is given. Safe to re-run.
#
#   setup-once.sh                       show every command (dry run)
#   setup-once.sh --apply               do it
#   setup-once.sh --apply --worker-role eng1816-worker-role      the worker's instance role (default shown)
#   setup-once.sh --apply --github-env-checked                   you verified the GitHub environment by hand (no `gh` here); see below
#
# ORDER MATTERS: the GitHub environment `login-host-prod` must already exist and accept deployments from `main` ONLY (README.md, step 1). GitHub creates an
# UNRESTRICTED environment on the fly when a workflow names one that does not exist, and the role below trusts that environment's name: with the role in place and
# the environment unrestricted, a workflow on ANY branch could assume the role, sign and deploy. So --apply refuses until it has checked the restriction.
#
# Creates: (1) the GitHub OIDC identity provider if the account has none, (2) the role `aw-login-host-ci` that ONLY the `login-host-prod` GitHub environment
# of this repo can assume (that environment only accepts runs from main), (3) one KMS signing key (ECC_NIST_P256) that ONLY that role can sign with,
# (4) read access to the builds prefix for the worker, (5) the SSM document AW-LoginHost-Deploy-Signed, rendered from the repo with the key's public half.
# It does NOT touch the worker, run a deploy, or grant anything to any person. See README.md for the GitHub-side step and for what to remove afterwards.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APPLY=0
GH_CHECKED=0
WORKER_ROLE=eng1816-worker-role
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --worker-role) shift; WORKER_ROLE=${1:?--worker-role needs a name} ;;
    --github-env-checked) GH_CHECKED=1 ;;
    *) echo "setup-once: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

AWS=${AW_AWS:-aws}
GH=${AW_GH:-gh}
REGION=${AWS_REGION:-us-west-2}
REPO=AgentWebPro/agentweb
ENVIRONMENT=login-host-prod
BUCKET=agentweb-login-host-992382574572
DOCUMENT=AW-LoginHost-Deploy-Signed
INSTANCE=i-033394e5467b48e94
CI_ROLE=aw-login-host-ci
KEY_ALIAS=alias/aw-login-host-signing
OUT=${AW_SETUP_OUT:-$(mktemp -d)}

say() { printf '%s\n' "setup-once: $*"; }
run() { # run <description> <command...>: prints, and executes only with --apply
  say "$1"
  shift
  printf '    + %s\n' "$*"
  if [ "$APPLY" = 1 ]; then "$@"; fi
}
render() { # render <template> <out>
  sed -e "s|@@ACCOUNT@@|$ACCOUNT|g" -e "s|@@REPO@@|$REPO|g" -e "s|@@ENVIRONMENT@@|$ENVIRONMENT|g" -e "s|@@BUCKET@@|$BUCKET|g" -e "s|@@REGION@@|$REGION|g" \
    -e "s|@@DOCUMENT@@|$DOCUMENT|g" -e "s|@@INSTANCE@@|$INSTANCE|g" -e "s|@@CI_ROLE@@|$CI_ROLE|g" -e "s|@@KEY_ARN@@|${KEY_ARN:-arn:aws:kms:$REGION:$ACCOUNT:key/PENDING}|g" "$1" >"$2"
  if grep -q '@@' "$2"; then echo "setup-once: unfilled placeholder in $2" >&2; exit 1; fi
}

# The environment must accept deployments from `main` only, BEFORE anything is created that trusts it.
github_env_restricted() {
  local env_json branches
  env_json=$("$GH" api "repos/$REPO/environments/$ENVIRONMENT" 2>/dev/null) || return 1
  [ "$(printf '%s' "$env_json" | python3 -c 'import json,sys; d=json.load(sys.stdin).get("deployment_branch_policy") or {}; print(d.get("custom_branch_policies") is True and d.get("protected_branches") is False)')" = True ] || return 1
  # exactly one policy, of type BRANCH (a tag named `main` would also match by name), named main
  branches=$("$GH" api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" --jq '.branch_policies[] | "\(.type // "branch"):\(.name)"' 2>/dev/null) || return 1
  [ "$branches" = branch:main ]
}
if [ "$APPLY" = 1 ] && [ "$GH_CHECKED" != 1 ]; then
  github_env_restricted || { echo "setup-once: REFUSED: the GitHub environment '$ENVIRONMENT' of $REPO is missing, unrestricted, or allows more than 'main' (or the 'gh' CLI is not available/authenticated here). Do README step 1 first; pass --github-env-checked only if you verified it by hand." >&2; exit 1; }
  say "the GitHub environment '$ENVIRONMENT' accepts deployments from main only"
fi

ACCOUNT=$("$AWS" sts get-caller-identity --query Account --output text)
[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || { echo "setup-once: cannot tell which AWS account this is" >&2; exit 1; }
say "account $ACCOUNT, region $REGION, repo $REPO, environment $ENVIRONMENT, worker $INSTANCE ($([ "$APPLY" = 1 ] && echo APPLY || echo 'DRY RUN: nothing will change'))"

# (1) the GitHub OIDC provider
if "$AWS" iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text | tr '\t' '\n' | grep -qx "arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"; then
  say "the GitHub OIDC provider already exists"
else
  run "create the GitHub OIDC provider" "$AWS" iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com
fi

# (2) the CI role (trust: ONLY this environment of this repo)
mkdir -p "$OUT"
render "$HERE/policies/ci-role-trust.json.tpl" "$OUT/ci-trust.json"
if "$AWS" iam get-role --role-name "$CI_ROLE" >/dev/null 2>&1; then
  run "update the CI role's trust policy" "$AWS" iam update-assume-role-policy --role-name "$CI_ROLE" --policy-document "file://$OUT/ci-trust.json"
  run "make sure the role may be assumed for 4 hours (a deploy can wait for an idle host)" "$AWS" iam update-role --role-name "$CI_ROLE" --max-session-duration 14400
else
  run "create the CI role" "$AWS" iam create-role --role-name "$CI_ROLE" --assume-role-policy-document "file://$OUT/ci-trust.json" --max-session-duration 14400 --description "ENG-2110: builds, signs and deploys the login worker from GitHub Actions (environment $ENVIRONMENT only)"
fi

# (3) the signing key: created with a policy that lets only the CI role sign (the role must exist first: a key policy cannot name a principal that does not)
# Only "no such key" means create one. Any other failure (access denied, throttling) must stop the script: treating it as "no key" would create a SECOND key.
KEY_ERR=$(mktemp)
if KEY_ARN=$("$AWS" kms describe-key --key-id "$KEY_ALIAS" --query KeyMetadata.Arn --output text 2>"$KEY_ERR"); then :; else
  if grep -q -E 'NotFoundException|not found|does not exist' "$KEY_ERR"; then KEY_ARN=""; else
    echo "setup-once: could not look up the signing key ($(head -c 300 "$KEY_ERR")); nothing was created" >&2
    rm -f "$KEY_ERR"
    exit 1
  fi
fi
rm -f "$KEY_ERR"
render "$HERE/policies/kms-key-policy.json.tpl" "$OUT/kms-policy.json"
if [ -n "$KEY_ARN" ] && [ "$KEY_ARN" != None ]; then
  say "the signing key exists: $KEY_ARN"
  run "(re)apply the key policy" "$AWS" kms put-key-policy --key-id "$KEY_ARN" --policy-name default --policy "file://$OUT/kms-policy.json"
else
  say "create the signing key (ECC_NIST_P256, sign/verify only), with the policy that lets only the CI role sign"
  printf '    + %s\n' "$AWS kms create-key --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY --policy file://$OUT/kms-policy.json --description <...>" "$AWS kms create-alias --alias-name $KEY_ALIAS --target-key-id <the new key's id>"
  if [ "$APPLY" = 1 ]; then
    # The key policy names the role, which IAM may not have propagated yet: wait for it, and retry a few times.
    "$AWS" iam wait role-exists --role-name "$CI_ROLE"
    KEY_ID=""
    for attempt in 1 2 3 4 5 6; do
      if KEY_ID=$("$AWS" kms create-key --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY --policy "file://$OUT/kms-policy.json" --description "ENG-2110: signs login-host builds; only the deploy pipeline may use it" --query KeyMetadata.KeyId --output text 2>"$OUT/create-key.err"); then break; fi
      grep -q MalformedPolicyDocument "$OUT/create-key.err" || { cat "$OUT/create-key.err" >&2; exit 1; }
      say "IAM has not propagated the role yet (attempt $attempt); waiting"
      sleep "${AW_SETUP_RETRY_SLEEP:-10}"
    done
    [ -n "$KEY_ID" ] || { echo "setup-once: the key could not be created (see above)" >&2; exit 1; }
    "$AWS" kms create-alias --alias-name "$KEY_ALIAS" --target-key-id "$KEY_ID"
    KEY_ARN=$("$AWS" kms describe-key --key-id "$KEY_ALIAS" --query KeyMetadata.Arn --output text)
  else
    KEY_ARN="arn:aws:kms:$REGION:$ACCOUNT:key/<new-key-id>"
  fi
fi

# (4) the CI role's permissions and the worker's read access
render "$HERE/policies/ci-role-permissions.json.tpl" "$OUT/ci-permissions.json"
run "give the CI role exactly: write builds, sign with the key, run the one document on the one instance" "$AWS" iam put-role-policy --role-name "$CI_ROLE" --policy-name aw-login-host-ci --policy-document "file://$OUT/ci-permissions.json"
render "$HERE/policies/worker-builds-read.json.tpl" "$OUT/worker-read.json"
run "let the worker read the builds prefix (only)" "$AWS" iam put-role-policy --role-name "$WORKER_ROLE" --policy-name aw-login-host-builds-read --policy-document "file://$OUT/worker-read.json"

# (5) the deploy document, rendered from the repo with the key's public half
if [ "$APPLY" = 1 ]; then
  "$AWS" kms get-public-key --key-id "$KEY_ALIAS" --query PublicKey --output text | base64 -d >"$OUT/signer.pub.der"
  openssl pkey -pubin -inform DER -in "$OUT/signer.pub.der" -out "$OUT/signer.pub.pem"
  node "$HERE/render-ssm-doc.js" --public-key "$OUT/signer.pub.pem" --bucket "$BUCKET" >"$OUT/doc.json"
  if "$AWS" ssm describe-document --name "$DOCUMENT" >/dev/null 2>&1; then
    # Re-runnable: an identical document is not an error (AWS refuses a duplicate update), and the default version and the clean-up always end up right.
    ver=""
    for v in $("$AWS" ssm list-document-versions --name "$DOCUMENT" --query 'DocumentVersions[].DocumentVersion' --output text); do
      have=$("$AWS" ssm get-document --name "$DOCUMENT" --document-version "$v" --query Content --output text | python3 -c 'import json,sys; print(json.dumps(json.loads(sys.stdin.read()), indent=2, sort_keys=False))' | sha256sum | cut -d' ' -f1 || true)
      want_norm=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), indent=2, sort_keys=False))' "$OUT/doc.json" | sha256sum | cut -d' ' -f1)
      [ "$have" != "$want_norm" ] || ver=$v
    done
    if [ -z "$ver" ]; then
      ver=$("$AWS" ssm update-document --name "$DOCUMENT" --document-format JSON --document-version '$LATEST' --content "file://$OUT/doc.json" --query DocumentDescription.DocumentVersion --output text)
      say "updated the document $DOCUMENT to version $ver"
    else
      say "the document $DOCUMENT already has exactly this content (version $ver)"
    fi
    "$AWS" ssm update-document-default-version --name "$DOCUMENT" --document-version "$ver" >/dev/null
    say "version $ver is the default"
    # Older versions stay callable by number (`--document-version N`), so remove them: only the version rendered just now may ever run.
    for old in $("$AWS" ssm list-document-versions --name "$DOCUMENT" --query 'DocumentVersions[].DocumentVersion' --output text); do
      [ "$old" = "$ver" ] || "$AWS" ssm delete-document --name "$DOCUMENT" --document-version "$old" >/dev/null
    done
    say "deleted the older versions of $DOCUMENT"
  else
    "$AWS" ssm create-document --name "$DOCUMENT" --document-type Command --document-format JSON --content "file://$OUT/doc.json" >/dev/null
    say "created the document $DOCUMENT"
  fi
else
  say "create or update the SSM document $DOCUMENT from the repo (node render-ssm-doc.js --public-key <the key's public half> --bucket $BUCKET), then make that version the default"
fi

say "done. Next (GitHub admin): create the '$ENVIRONMENT' environment restricted to the main branch (README.md, step 1), then run the 'Login host deploy' workflow once by hand."
say "files written to $OUT"
