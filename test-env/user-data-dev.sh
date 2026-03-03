#!/bin/bash
# EC2 user-data script for dev mode — installs Node.js, Claude Code CLI, and dev tools
# (no Docker needed — dev servers run directly on the instance)
set -euxo pipefail

# Install dev tools: git, tmux, rsync, cron, build tools for native npm modules
dnf install -y git tmux rsync cronie gcc-c++ make
systemctl enable crond
systemctl start crond

# Install Node.js 20 via NodeSource
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# Install Claude Code CLI globally
npm install -g @anthropic-ai/claude-code

# Create app and logs directories
mkdir -p /home/ec2-user/agentweb/logs
chown -R ec2-user:ec2-user /home/ec2-user/agentweb

# Set up minimal git config for ec2-user
sudo -u ec2-user git config --global user.name "ec2-user"
sudo -u ec2-user git config --global user.email "ec2-user@test-env"

# Signal readiness — the launch script polls for this file
touch /home/ec2-user/.test-env-dev-ready
