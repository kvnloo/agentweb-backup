#!/usr/bin/env bash
# Regression checks for the launch failure path. These remain shell-only because
# test-env.sh's AWS and SSH boundaries are intentionally exercised in cloud-dev.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$script_dir/test-env.sh"

require() {
  local pattern="$1"
  if ! grep -qE "$pattern" "$script"; then
    echo "missing expected launch safeguard: $pattern" >&2
    return 1
  fi
}

require '^cleanup_failed_launch\(\)'
require '^diagnose_ssh_failure\(\)'
require "trap 'cleanup_failed_launch' ERR"
require 'SSH endpoint did not become reachable'

# The ERR trap must be installed before the security group is created, so a
# failure creating the SG itself (not just an SSH timeout) is still cleaned
# up. Assert ordering, not just presence (CodeRabbit finding on PR #2690).
trap_line=$(grep -n "trap 'cleanup_failed_launch' ERR" "$script" | head -1 | cut -d: -f1)
sg_line=$(grep -n 'aws ec2 create-security-group' "$script" | head -1 | cut -d: -f1)
if [[ -z "$trap_line" || -z "$sg_line" || "$trap_line" -ge "$sg_line" ]]; then
  echo "ERR trap must be installed before aws ec2 create-security-group (trap_line=$trap_line sg_line=$sg_line)" >&2
  exit 1
fi

echo 'test-env launch safeguards: PASS'
