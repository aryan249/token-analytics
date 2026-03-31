# ── Argo CD Image Updater ─────────────────────────────────────────────────────
#
# Watches ECR for new image tags and auto-deploys via Argo CD.
# Production app: only picks tags matching prod-*
# Staging app: only picks tags matching staging-*
#
# Flow:
#   Merge to main    → CI pushes prod-<sha>    → Image Updater deploys to production
#   Merge to staging → CI pushes staging-<sha> → Image Updater deploys to staging
#
# CI has zero cluster access. Image Updater handles deployment.

resource "helm_release" "argocd_image_updater" {
  name       = "argocd-image-updater"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argocd-image-updater"
  version    = "0.11.0"
  namespace  = kubernetes_namespace.argocd.metadata[0].name

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
  set {
    name  = "config.argocd.plaintext"
    value = "true"
  }

  set {
    name  = "resources.requests.cpu"
    value = "25m"
  }
  set {
    name  = "resources.requests.memory"
    value = "64Mi"
  }

  wait    = true
  timeout = 300

  depends_on = [helm_release.argocd]
}
