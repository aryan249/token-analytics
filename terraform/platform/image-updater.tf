# ── Argo CD Image Updater ─────────────────────────────────────────────────────
#
# Watches ECR for new image tags and automatically updates Argo CD applications.
# Replaces the git commit + push pattern in CI pipeline.
#
# How it works:
#   1. CI pushes image to ECR with tag (git SHA)
#   2. Image Updater polls ECR every 2 minutes
#   3. Detects new tag → updates Argo CD Application's image override
#   4. Argo CD syncs the new image → pods roll
#
# No git commits from CI. No race conditions. No merge conflicts.

resource "helm_release" "argocd_image_updater" {
  name       = "argocd-image-updater"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argocd-image-updater"
  version    = "0.11.0"
  namespace  = kubernetes_namespace.argocd.metadata[0].name

  # ECR authentication — use AWS credential helper (node IAM role)
  set {
    name  = "config.registries[0].name"
    value = "ecr"
  }
  set {
    name  = "config.registries[0].api_url"
    value = "https://${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
  }
  set {
    name  = "config.registries[0].prefix"
    value = "${var.aws_account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
  }
  set {
    name  = "config.registries[0].default"
    value = "true"
  }
  set {
    name  = "config.registries[0].credentials"
    value = "pullsecret:argocd/ecr-credentials"
  }

  # Argo CD connection
  set {
    name  = "config.argocd.plaintext"
    value = "true"
  }

  # Minimal resources for t3.small
  set {
    name  = "resources.requests.cpu"
    value = "25m"
  }
  set {
    name  = "resources.requests.memory"
    value = "64Mi"
  }
  set {
    name  = "resources.limits.cpu"
    value = "100m"
  }
  set {
    name  = "resources.limits.memory"
    value = "128Mi"
  }

  wait    = true
  timeout = 300

  depends_on = [helm_release.argocd]
}
