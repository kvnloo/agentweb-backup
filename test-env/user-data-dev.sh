#!/bin/bash
# EC2 user-data script for dev mode — installs Node.js, Claude Code CLI, and dev tools
# (no Docker needed — dev servers run directly on the instance)
set -euxo pipefail

# Create swap space (prevents OOM when tsc + Claude + services run together)
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile swap swap defaults 0 0' >> /etc/fstab

# Install dev tools: git, tmux, rsync, cron, build tools for native npm modules
# Also install Playwright system dependencies for browser MCP
dnf install -y git tmux rsync cronie gcc-c++ make \
  alsa-lib at-spi2-atk atk at-spi2-core cairo cups-libs dbus-libs \
  libdrm mesa-libgbm glib2 nspr nss pango libX11 libxcb libXcomposite \
  libXdamage libXext libXfixes libxkbcommon libXrandr
systemctl enable crond
systemctl start crond

# Install Node.js 20 via NodeSource
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# Install Claude Code CLI globally
npm install -g @anthropic-ai/claude-code

# Install GitHub CLI
dnf install -y dnf-plugins-core
dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
dnf install -y gh

# Install Google Chrome for Playwright MCP (npx playwright install chrome only works on Ubuntu/Debian)
curl -o /tmp/chrome.rpm https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm
dnf localinstall -y /tmp/chrome.rpm
rm -f /tmp/chrome.rpm

# Install Playwright browser for MCP
sudo -u ec2-user npx playwright install chromium

# Create app and logs directories
mkdir -p /home/ec2-user/agentweb/logs
chown -R ec2-user:ec2-user /home/ec2-user/agentweb

# Set up git config for ec2-user (use john-the-dev identity for commit attribution)
sudo -u ec2-user git config --global user.name "john-the-dev"
sudo -u ec2-user git config --global user.email "52230987+john-the-dev@users.noreply.github.com"

# Signal readiness — the launch script polls for this file
touch /home/ec2-user/.test-env-dev-ready
