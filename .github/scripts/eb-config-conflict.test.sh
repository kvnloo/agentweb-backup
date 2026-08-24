#!/usr/bin/env bash
#
# Tests for .github/scripts/eb-config-conflict.sh (ENG-836 AC3).
#
# Fixtures are real .ebextensions/.platform files written into a temp repo root,
# so the classifier runs against genuine content rather than mocked answers.
#
# The headline case reconstructs PR #2237 exactly: `aws:elbv2:loadbalancer`
# IdleTimeout together with `.platform/nginx/*.conf`. That combination stranded
# production for ~29 hours, and staging reported green throughout.
#
# Run with:  bash .github/scripts/eb-config-conflict.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/eb-config-conflict.sh"

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

new_root() {
  local root
  root="$(mktemp -d "${WORKDIR}/root.XXXXXX")"
  mkdir -p "${root}/backend/.ebextensions" \
           "${root}/backend/.platform/nginx/conf.d"
  printf '%s' "${root}"
}

# The real timeout.config from the incident: ALB idle timeout = resource config.
write_resource_config() {
  cat >"$1/backend/.ebextensions/timeout.config" <<'EOF'
option_settings:
  aws:elbv2:loadbalancer:
    IdleTimeout: 720
  aws:elasticbeanstalk:environment:process:default:
    DeregistrationDelay: 600
EOF
}

# .platform nginx conf: instance config.
write_platform_conf() {
  cat >"$1/backend/.platform/nginx/conf.d/agent-mode-timeout.conf" <<'EOF'
proxy_read_timeout 660s;
EOF
}

# An .ebextensions file that runs commands on the box: instance config.
write_instance_config() {
  cat >"$1/backend/.ebextensions/chromium.config" <<'EOF'
files:
  "/etc/yum.repos.d/google-chrome.repo":
    mode: "000644"
commands:
  01_install_chrome:
    command: "dnf install -y google-chrome-stable"
EOF
}

run_check() {
  local root="$1"
  shift
  set +e
  LAST_OUTPUT=$(EB_CONFLICT_REPO_ROOT="${root}" bash "${SCRIPT}" "$@" 2>&1)
  LAST_EXIT=$?
  set -e
}

# Commit the fixture root so deletions can be recovered from the base ref, the
# way CI does with the PR's base SHA.
commit_root() {
  git -C "$1" init -q 2>/dev/null
  git -C "$1" config user.email ci@example.com
  git -C "$1" config user.name CI
  git -C "$1" add -A
  git -C "$1" commit -q -m base
}

run_check_with_base() {
  local root="$1"
  shift
  set +e
  LAST_OUTPUT=$(EB_CONFLICT_REPO_ROOT="${root}" EB_CONFLICT_BASE_REF=HEAD bash "${SCRIPT}" "$@" 2>&1)
  LAST_EXIT=$?
  set -e
}

check() {
  local desc="$1" expected_exit="$2" needle="$3"
  TESTS_RUN=$(( TESTS_RUN + 1 ))
  if [ "${LAST_EXIT}" -ne "${expected_exit}" ]; then
    printf '  FAIL %s\n       expected exit %s, got %s\n       output:\n%s\n' \
      "${desc}" "${expected_exit}" "${LAST_EXIT}" "${LAST_OUTPUT}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    return
  fi
  # ENG-1277: a here-string, not a pipe. Under `set -o pipefail`, `grep -q`
  # exiting early on the first match can SIGPIPE the upstream printf, and
  # pipefail then reports THAT nonzero for the whole pipeline even though grep
  # genuinely matched — a race that passes locally and fails intermittently in
  # CI (see trunk-deploy-state.test.sh for the live incident). A here-string
  # has no live producer process for grep to SIGPIPE.
  if [ -n "${needle}" ] && ! grep -qF "${needle}" <<<"${LAST_OUTPUT}"; then
    printf '  FAIL %s\n       output did not contain: %s\n       output:\n%s\n' \
      "${desc}" "${needle}" "${LAST_OUTPUT}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    return
  fi
  printf '  ok   %s\n' "${desc}"
}

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

printf 'eb-config-conflict.sh\n'

# The incident itself: PR #2237's exact file pair must be rejected.
R=$(new_root); write_resource_config "$R"; write_platform_conf "$R"
run_check "$R" \
  backend/.ebextensions/timeout.config \
  backend/.platform/nginx/conf.d/agent-mode-timeout.conf
check 'ENG-836: PR #2237 (ALB IdleTimeout + .platform nginx) is rejected' 1 \
  'EB_CONFIG_CONFLICT'
check 'ENG-836: and the failure names both sides' 1 \
  'backend/.platform/nginx/conf.d/agent-mode-timeout.conf'
check 'ENG-836: and tells the author how to fix it' 1 \
  'two sequential'
check 'ENG-836: and warns that staging will not reproduce it' 1 \
  'staging is AllAtOnce'
check 'ENG-836: and emits a GitHub error annotation' 1 \
  '::error::EB_CONFIG_CONFLICT'

# Resource-only: this is the FIRST of the two sequential deploys and must pass.
R=$(new_root); write_resource_config "$R"
run_check "$R" backend/.ebextensions/timeout.config
check 'ENG-836: a resource-only change is not blocked by the file check' 0 \
  'no instance-config change alongside'
# ENG-818 #2277: a PR of exactly this shape passed this gate and was then
# REJECTED in production, leaving main undeployable for ~50 minutes. The pass is
# real (it is not the known-bad file pair) but it is not a clearance, and the
# output must say so or the next person merges on it exactly as I did.
check 'ENG-818: and it warns instead of declaring the deploy safe' 0 \
  'NOT PASSING THIS AS SAFE'
check 'ENG-818: and it names how to check the live value' 0 \
  'describe-configuration-settings'
# Greptile P1 on #2280: the example query used to hardcode
# aws:elbv2:loadbalancer, so a PR changing aws:autoscaling:asg was told to look
# somewhere its setting could not appear — misleading guidance, the exact thing
# this PR removes elsewhere.
check 'ENG-818: and the live query targets the namespace THIS diff touches' 0 \
  "starts_with(Namespace, 'aws:elbv2:')"

# A non-load-balancer resource namespace must be named instead, not in addition.
R=$(new_root)
cat >"$R/backend/.ebextensions/asg.config" <<'EOF'
option_settings:
  aws:autoscaling:asg:
    MinSize: 2
EOF
run_check "$R" backend/.ebextensions/asg.config
check 'ENG-836: an autoscaling-only change queries the autoscaling namespace' 0 \
  "starts_with(Namespace, 'aws:autoscaling:asg')"
check 'ENG-836: and does NOT send them to the load-balancer namespace' 0 \
  'NOT PASSING THIS AS SAFE'
LB_IN_OUTPUT=$(printf '%s' "${LAST_OUTPUT}" | grep -c "aws:elbv2" || true)
TESTS_RUN=$(( TESTS_RUN + 1 ))
if [ "${LB_IN_OUTPUT}" -eq 0 ]; then
  printf '  ok   %s\n' 'ENG-836: the load-balancer namespace is absent from an autoscaling-only warning'
else
  printf '  FAIL %s\n       output mentioned aws:elbv2 %s times\n' \
    'ENG-836: the load-balancer namespace is absent from an autoscaling-only warning' "${LB_IN_OUTPUT}"
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

# Instance-only: the SECOND deploy. Must also pass.
R=$(new_root); write_platform_conf "$R"
run_check "$R" backend/.platform/nginx/conf.d/agent-mode-timeout.conf
check 'ENG-836: an instance-only change passes (deploy 2 of 2)' 0 \
  'No Elastic Beanstalk resource-config file changed'

# Ordinary application code must never be flagged. A gate that fires on normal
# PRs gets switched off within a week and then protects nothing.
R=$(new_root)
run_check "$R" backend/src/services/agentModeService.ts backend/package.json README.md
check 'ENG-836: an ordinary code-only PR is not flagged' 0 \
  'No Elastic Beanstalk resource-config file changed'
check 'ENG-818: and a clean pass still refuses to claim deployability' 0 \
  'does NOT verify deployability'

# Code alongside a resource-only config change still passes. We have evidence
# that resource+INSTANCE-CONFIG fails; we do not have evidence that shipping app
# code with it does, and inventing that rule would block routine work.
R=$(new_root); write_resource_config "$R"
run_check "$R" backend/.ebextensions/timeout.config backend/src/index.ts
check 'ENG-836: app code alongside a resource-only change is not blocked' 0 \
  'NOT PASSING THIS AS SAFE'

# Two .ebextensions files, one of each class, is the same conflict.
R=$(new_root); write_resource_config "$R"; write_instance_config "$R"
run_check "$R" \
  backend/.ebextensions/timeout.config \
  backend/.ebextensions/chromium.config
check 'ENG-836: resource config + a commands:/files: config is rejected' 1 \
  'EB_CONFIG_CONFLICT'

# A single file carrying BOTH classes is a conflict on its own — splitting the
# PR would not help, the file itself has to be split.
R=$(new_root)
cat >"$R/backend/.ebextensions/mixed.config" <<'EOF'
option_settings:
  aws:elbv2:loadbalancer:
    IdleTimeout: 720
commands:
  01_touch:
    command: "touch /tmp/x"
EOF
run_check "$R" backend/.ebextensions/mixed.config
check 'ENG-836: one file carrying both classes is rejected by itself' 1 \
  'EB_CONFIG_CONFLICT'

# Reads from stdin too, which is how CI will feed it `git diff --name-only`.
R=$(new_root); write_resource_config "$R"; write_platform_conf "$R"
set +e
LAST_OUTPUT=$(printf 'backend/.ebextensions/timeout.config\nbackend/.platform/nginx/conf.d/agent-mode-timeout.conf\n' \
  | EB_CONFLICT_REPO_ROOT="$R" bash "${SCRIPT}" 2>&1)
LAST_EXIT=$?
set -e
check 'ENG-836: reads the changed-file list from stdin' 1 'EB_CONFIG_CONFLICT'

# An empty diff is not a conflict.
R=$(new_root)
set +e
LAST_OUTPUT=$(printf '' | EB_CONFLICT_REPO_ROOT="$R" bash "${SCRIPT}" 2>&1)
LAST_EXIT=$?
set -e
check 'ENG-836: an empty changed-file list passes' 0 'nothing to check'

# Greptile P1 on #2267, and its follow-up. A DELETED config still carries a
# delta: removing a file that declared `aws:elbv2:loadbalancer` is a resource
# change, and removing one that declared `commands:` is an instance change.
# Rather than guess, the content is recovered from the base ref and the removal
# is classified by exactly what it removed.

# Direction 1: a deleted RESOURCE config alongside an instance change.
R=$(new_root); write_resource_config "$R"; write_platform_conf "$R"
commit_root "$R"
rm "$R/backend/.ebextensions/timeout.config"
run_check_with_base "$R" \
  backend/.ebextensions/timeout.config \
  backend/.platform/nginx/conf.d/agent-mode-timeout.conf
check 'ENG-836: a DELETED resource config alongside an instance change is rejected' 1 \
  'EB_CONFIG_CONFLICT'
check 'ENG-836: and it is classified from its removed content' 1 \
  'deleted — classified from its removed content'

# Direction 2 — the case that kept #2267 at 4/5. Deleting an INSTANCE-ONLY
# config (chromium.config carries files:/commands:) alongside a RESOURCE edit.
# Counting every absent file as possibly-resource left instance_hits empty, so
# this returned success and preserved the exact failure path being guarded.
R=$(new_root); write_resource_config "$R"; write_instance_config "$R"
commit_root "$R"
rm "$R/backend/.ebextensions/chromium.config"
run_check_with_base "$R" \
  backend/.ebextensions/timeout.config \
  backend/.ebextensions/chromium.config
check 'ENG-836: a DELETED instance-only config alongside a resource edit is rejected' 1 \
  'EB_CONFIG_CONFLICT'
check 'ENG-836: and the deleted file is named on the INSTANCE side' 1 \
  'chromium.config (instance config) (deleted'

# A deleted resource config on its own is still resource-only, so it passes.
# Failing here would fire on ordinary cleanup, which is how a gate gets
# switched off within a week.
R=$(new_root); write_resource_config "$R"
commit_root "$R"
rm "$R/backend/.ebextensions/timeout.config"
run_check_with_base "$R" backend/.ebextensions/timeout.config
check 'ENG-836: a deleted resource config on its own still passes' 0 \
  'no instance-config change alongside'

# Greptile's third finding on #2267: an IN-PLACE removal. The file still
# exists, so head-only classification sees no resource declaration — but the
# edit deleted the `aws:elbv2:loadbalancer` block, which is a resource delta
# just as much as adding one. Paired with an instance change that is the
# forbidden combination, and it passed.
R=$(new_root); write_resource_config "$R"; write_platform_conf "$R"
commit_root "$R"
cat >"$R/backend/.ebextensions/timeout.config" <<'EOF'
# the resource declaration was removed in place; the file lives on.
option_settings:
  aws:elasticbeanstalk:application:environment:
    SOME_FLAG: "1"
EOF
run_check_with_base "$R" \
  backend/.ebextensions/timeout.config \
  backend/.platform/nginx/conf.d/agent-mode-timeout.conf
check 'ENG-836: a declaration removed IN PLACE still counts as a resource delta' 1 \
  'EB_CONFIG_CONFLICT'
check 'ENG-836: and the output says it was classified from base+head' 1 \
  'removed declarations count too'

# The mirror: an in-place removal of instance config paired with a resource edit.
R=$(new_root); write_resource_config "$R"; write_instance_config "$R"
commit_root "$R"
cat >"$R/backend/.ebextensions/chromium.config" <<'EOF'
# the instance-side declarations were removed in place; the file lives on.
# NB: this comment deliberately avoids naming those keys - the classifier
# matches on literal text, so writing them here would make the fixture
# classify as instance config and the test would pass for the wrong reason.
option_settings:
  aws:elasticbeanstalk:application:environment:
    CHROME: "0"
EOF
run_check_with_base "$R" \
  backend/.ebextensions/timeout.config \
  backend/.ebextensions/chromium.config
check 'ENG-836: an in-place instance removal beside a resource edit is rejected' 1 \
  'EB_CONFIG_CONFLICT'
# Pin WHY it fails: the removed files:/commands: must be attributed to the
# instance side. Without this the check could pass for an unrelated reason.
check 'ENG-836: and the in-place removal is attributed to the instance side' 1 \
  'chromium.config (instance config)'

# Greptile's fourth finding on #2267: a RENAME. `git diff --name-only` applies
# rename detection and reports only the DESTINATION path, so looking that path
# up in base finds nothing and every declaration at the source is lost. The
# workflow now passes --no-renames, which reports a rename as a delete plus an
# add. This proves the classifier handles that two-path form: the source is
# recovered from base, and the pair is caught alongside an instance change.
R=$(new_root); write_resource_config "$R"; write_platform_conf "$R"
commit_root "$R"
git -C "$R" mv backend/.ebextensions/timeout.config backend/.ebextensions/alb.config
cat >"$R/backend/.ebextensions/alb.config" <<'EOF'
# renamed AND the resource declaration dropped in the same edit
option_settings:
  aws:elasticbeanstalk:application:environment:
    RENAMED: "1"
EOF
run_check_with_base "$R" \
  backend/.ebextensions/timeout.config \
  backend/.ebextensions/alb.config \
  backend/.platform/nginx/conf.d/agent-mode-timeout.conf
check 'ENG-836: a renamed config (delete+add form) is classified from its source' 1 \
  'EB_CONFIG_CONFLICT'
check 'ENG-836: and the rename SOURCE is named on the resource side' 1 \
  'timeout.config (resource namespace)'

# The failure mode --no-renames prevents: given only the destination path, the
# source declarations are invisible and the conflict is missed. Documented as a
# test so nobody "simplifies" the flag away.
R=$(new_root); write_resource_config "$R"; write_platform_conf "$R"
commit_root "$R"
git -C "$R" mv backend/.ebextensions/timeout.config backend/.ebextensions/alb.config
cat >"$R/backend/.ebextensions/alb.config" <<'EOF'
option_settings:
  aws:elasticbeanstalk:application:environment:
    RENAMED: "1"
EOF
run_check_with_base "$R" \
  backend/.ebextensions/alb.config \
  backend/.platform/nginx/conf.d/agent-mode-timeout.conf
check 'ENG-836: destination-only (rename detection ON) is why --no-renames is required' 0 \
  'No Elastic Beanstalk resource-config file changed'

# Content genuinely unrecoverable (deleted, and no base ref supplied). We
# cannot tell which side it was, so it counts as BOTH rather than neither.
R=$(new_root); write_resource_config "$R"
run_check "$R" \
  backend/.ebextensions/gone.config \
  backend/.ebextensions/timeout.config
check 'ENG-836: an unrecoverable config counts as both sides, not neither' 1 \
  'counted as BOTH resource and instance'

# The real repo must pass against itself — if this gate would fail main today,
# it is unshippable.
run_check "$(cd "${SCRIPT_DIR}/../.." && pwd)" \
  backend/.ebextensions/timeout.config
check 'ENG-836: the live repo timeout.config alone is not a conflict' 0 ''

# ENG-1412's structural assertion used to live here. It now lives in
# .github/scripts/pipefail-hygiene.test.sh, which is where a rule about every
# script in the directory belongs — this file's subject is EB resource/instance
# config conflicts, and it was only the host because that is where the bug was
# first caught.
#
# The move is also a widening. Measured head-to-head on a 12-shape corpus, the
# pattern here caught 4 and the replacement catches 12, with no false positives
# either side. It matched only pipelines that BEGIN with printf and END in grep,
# so `jq ... | head -n 1` — which aborts deploy-failure-alert.sh outright under
# set -e — was invisible to it, along with every other `head` case,
# `grep --silent`, `grep -e X -q`, and any writer that is not printf.
#
# What it did better, and what the replacement now also handles: it regexed the
# whole file, so it spanned a blank or comment line between `|` and the reader.
# The line-joining replacement missed that until this comparison surfaced it.

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
