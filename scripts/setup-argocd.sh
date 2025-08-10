#!/bin/bash
# ── Argo CD Setup ────────────────────────────────────────────────────────────
#
# Run this ONCE after Terraform creates the Argo CD installation.
# It applies the ApplicationSet that creates staging + production apps.
#
# Prerequisites:
#   - kubectl configured for the EKS cluster
#   - Argo CD running in the argocd namespace (via Terraform)
#
# Usage:
#   ./scripts/setup-argocd.sh

set -euo pipefail

echo "=== Waiting for Argo CD to be ready ==="
kubectl wait --for=condition=available deployment/argocd-server \
  -n argocd --timeout=300s

echo ""
echo "=== Applying Argo CD ApplicationSet ==="
kubectl apply -f helm/token-analytics/argocd/application.yaml

echo ""
echo "=== Getting initial admin password ==="
ARGOCD_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" 2>/dev/null | base64 --decode)

echo ""
echo "=== Argo CD Setup Complete ==="
echo ""
echo "Access the Argo CD UI:"
echo "  kubectl port-forward svc/argocd-server -n argocd 8080:443"
echo "  https://localhost:8080"
echo ""
echo "Login:"
echo "  Username: admin"
echo "  Password: $ARGOCD_PASSWORD"
echo ""
echo "CLI login:"
echo "  argocd login localhost:8080 --username admin --password '$ARGOCD_PASSWORD' --insecure"
echo ""
echo "Applications created:"
echo "  - token-analytics-staging    (watches staging branch)"
echo "  - token-analytics-production (watches main branch)"
echo ""
echo "Useful commands:"
echo "  argocd app list"
echo "  argocd app get token-analytics-staging"
echo "  argocd app get token-analytics-production"
echo "  argocd app sync token-analytics-staging"
echo "  argocd app history token-analytics-production"
echo "  argocd app diff token-analytics-production"
echo ""
