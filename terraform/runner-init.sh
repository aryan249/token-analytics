#!/bin/bash
set -euo pipefail

# Install dependencies (libicu needed by .NET runtime in GitHub runner)
dnf install -y docker git libicu openssl-libs krb5-libs zlib unzip tar gzip

systemctl enable docker
systemctl start docker

# Install Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# Create runner user
useradd -m runner || true
usermod -aG docker runner

# Install GitHub Actions runner
cd /home/runner
RUNNER_VERSION="2.321.0"
curl -o actions-runner.tar.gz -L "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
tar xzf actions-runner.tar.gz
rm actions-runner.tar.gz
chown -R runner:runner /home/runner

# Configure runner (skip installdependencies.sh — deps installed above)
su - runner -c "./config.sh --unattended \
  --url https://github.com/${github_repo} \
  --token ${runner_token} \
  --name ${runner_name} \
  --labels ${runner_labels} \
  --replace"

# Install as service
./svc.sh install runner
./svc.sh start
