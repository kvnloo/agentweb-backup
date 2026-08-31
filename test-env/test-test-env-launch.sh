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

echo 'test-env launch safeguards: PASS'
