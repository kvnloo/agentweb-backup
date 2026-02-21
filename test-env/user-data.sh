#!/bin/bash
# EC2 user-data script — installs Docker and prepares the instance for test-env
set -euxo pipefail

# Install Docker
dnf install -y docker
systemctl start docker
systemctl enable docker
usermod -a -G docker ec2-user

# Install Docker Buildx and Compose plugins
mkdir -p /usr/local/lib/docker/cli-plugins

ARCH=$(uname -m); case $ARCH in x86_64) ARCH=amd64 ;; aarch64) ARCH=arm64 ;; esac
BUILDX_VERSION=$(curl -s https://api.github.com/repos/docker/buildx/releases/latest | grep -Po '"tag_name": "\K[^"]+')
curl -SL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-${ARCH}" \
  -o /usr/local/lib/docker/cli-plugins/docker-buildx
chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx

curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Install rsync and cron (needed for code sync and watchdog)
dnf install -y rsync cronie
systemctl enable crond
systemctl start crond

# Create app directory
mkdir -p /home/ec2-user/agentweb
chown ec2-user:ec2-user /home/ec2-user/agentweb

# Signal readiness — the launch script polls for this file
touch /home/ec2-user/.test-env-ready
