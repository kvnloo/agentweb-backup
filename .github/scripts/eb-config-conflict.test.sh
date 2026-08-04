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

check() {
  local desc="$1" expected_exit="$2" needle="$3"
  TESTS_RUN=$(( TESTS_RUN + 1 ))
  if [ "${LAST_EXIT}" -ne "${expected_exit}" ]; then
    printf '  FAIL %s\n       expected exit %s, got %s\n       output:\n%s\n' \
      "${desc}" "${expected_exit}" "${LAST_EXIT}" "${LAST_OUTPUT}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    return
  fi
  if [ -n "${needle}" ] && ! printf '%s' "${LAST_OUTPUT}" | grep -qF "${needle}"; then
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
check 'ENG-836: a resource-only change passes (deploy 1 of 2)' 0 \
  'no instance-config change alongside'

# Instance-only: the SECOND deploy. Must also pass.
R=$(new_root); write_platform_conf "$R"
run_check "$R" backend/.platform/nginx/conf.d/agent-mode-timeout.conf
check 'ENG-836: an instance-only change passes (deploy 2 of 2)' 0 \
  'No Elastic Beanstalk resource-config change'

# Ordinary application code must never be flagged. A gate that fires on normal
# PRs gets switched off within a week and then protects nothing.
R=$(new_root)
run_check "$R" backend/src/services/agentModeService.ts backend/package.json README.md
check 'ENG-836: an ordinary code-only PR is not flagged' 0 \
  'No Elastic Beanstalk resource-config change'

# Code alongside a resource-only config change still passes. We have evidence
# that resource+INSTANCE-CONFIG fails; we do not have evidence that shipping app
# code with it does, and inventing that rule would block routine work.
R=$(new_root); write_resource_config "$R"
run_check "$R" backend/.ebextensions/timeout.config backend/src/index.ts
check 'ENG-836: app code alongside a resource-only change is not flagged' 0 \
  'Safe: an immutable deploy accepts a resource-only update'

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

# Greptile P1 on #2267. A deleted or renamed config has no content left to
# classify, but its REMOVAL is still a delta: deleting a file that declared
# `aws:elbv2:loadbalancer` is a resource change just as surely as editing it.
# The first version logged "not classified" and exited 0, so a delete paired
# with an instance change sailed through to the immutable deploy.
R=$(new_root); write_platform_conf "$R"
run_check "$R" \
  backend/.ebextensions/deleted.config \
  backend/.platform/nginx/conf.d/agent-mode-timeout.conf
check 'ENG-836: a DELETED config alongside an instance change is rejected' 1 \
  'EB_CONFIG_CONFLICT'
check 'ENG-836: and it is named as possibly-resource, not silently dropped' 1 \
  'deleted or renamed'

# On its own a deleted config is harmless — it is only a risk paired with an
# instance change. Failing here too would make the gate fire on ordinary
# cleanup, which is how a gate gets switched off.
R=$(new_root)
run_check "$R" backend/.ebextensions/deleted.config
check 'ENG-836: a deleted config on its own still passes' 0 \
  'no instance-config change alongside'

# The real repo must pass against itself — if this gate would fail main today,
# it is unshippable.
run_check "$(cd "${SCRIPT_DIR}/../.." && pwd)" \
  backend/.ebextensions/timeout.config
check 'ENG-836: the live repo timeout.config alone is not a conflict' 0 ''

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
