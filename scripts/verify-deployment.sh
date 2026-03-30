#!/bin/bash
# ── Deployment Verification ──────────────────────────────────────────────────
# Called by CI after deploy. Read-only — checks cluster state, doesn't modify.
#
# Usage: ./scripts/verify-deployment.sh [IMAGE_TAG]

set -euo pipefail

IMAGE_TAG="${1:-unknown}"
NAMESPACE="${NAMESPACE:-token-analytics}"
ARGOCD_NS="${ARGOCD_NS:-argocd}"

echo "============================================"
echo "  Deployment Verification"
echo "  Image: $IMAGE_TAG"
echo "  Namespace: $NAMESPACE"
echo "============================================"
echo ""

echo "=== Argo CD Applications ==="
kubectl get applications -n "$ARGOCD_NS" 2>/dev/null || echo "Argo CD not accessible"
echo ""

echo "=== Pods ==="
kubectl get pods -n "$NAMESPACE"
echo ""

echo "=== Pod Images ==="
kubectl get pods -n "$NAMESPACE" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'
echo ""

echo "=== API Endpoint ==="
ENDPOINT=$(kubectl get ingress -n "$NAMESPACE" \
  -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
if [ -n "$ENDPOINT" ]; then
  echo "URL: http://$ENDPOINT"
else
  echo "No ingress found"
fi
echo ""

echo "=== Health Check ==="
if [ -n "$ENDPOINT" ]; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://$ENDPOINT/health" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "HEALTHY (HTTP $HTTP_CODE)"
    curl -s --max-time 5 "http://$ENDPOINT/health" 2>/dev/null | python3 -m json.tool 2>/dev/null || true
  else
    echo "UNHEALTHY (HTTP $HTTP_CODE)"
  fi
else
  echo "Skipped — no endpoint"
fi
echo ""

echo "=== Image Match ==="
if [ "$IMAGE_TAG" != "unknown" ]; then
  MATCH=$(kubectl get pods -n "$NAMESPACE" -o jsonpath='{.items[*].spec.containers[0].image}' 2>/dev/null | tr ' ' '\n' | grep -c "$IMAGE_TAG" || echo 0)
  TOTAL=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')
  echo "$MATCH / $TOTAL pods running image tag $IMAGE_TAG"
else
  echo "No image tag provided — skipping match check"
fi

echo ""
echo "============================================"
echo "  Verification complete"
echo "============================================"
