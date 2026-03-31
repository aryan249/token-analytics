#!/bin/bash
set -euo pipefail

# Install dependencies (libicu needed by .NET runtime in GitHub runner)
dnf install -y docker git libicu openssl-libs krb5-libs zlib unzip tar gzip

systemctl enable docker
systemctl start docker

# Install Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# Install kubectl
curl -LO "https://dl.k8s.io/release/v1.29.0/bin/linux/amd64/kubectl"
install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
rm kubectl

# Install Helm
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Install AWS CLI v2
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
unzip -q awscliv2.zip
./aws/install
rm -rf aws awscliv2.zip

# Create runner user
useradd -m runner || true
usermod -aG docker runner

# Install GitHub Actions runner
cd /home/runner
RUNNER_VERSION="2.325.0"
curl -o actions-runner.tar.gz -L "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
tar xzf actions-runner.tar.gz
rm actions-runner.tar.gz
chown -R runner:runner /home/runner

# Force actions to use node20 (self-hosted runners don't ship node24 binary)
echo "ACTIONS_RUNNER_FORCE_ACTIONS_NODE_VERSION=node20" >> /home/runner/.env

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

# ── Self-healing: watchdog cron + docker cleanup ─────────────────────────────

# Restart runner agent if it dies (check every 5 minutes)
cat > /etc/cron.d/runner-watchdog << 'CRON'
*/5 * * * * root systemctl is-active actions.runner.* || systemctl restart actions.runner.*
CRON

# Clean up docker daily at 3 AM to prevent disk full (keep last 24h of images)
cat > /etc/cron.d/docker-cleanup << 'CRON'
0 3 * * * root docker system prune -af --filter "until=24h" 2>/dev/null
CRON

chmod 644 /etc/cron.d/runner-watchdog /etc/cron.d/docker-cleanup
