# ── Argo CD — GitOps controller ──────────────────────────────────────────────
#
# Watches Git repository and auto-syncs Helm charts to EKS.
# Replaces CI/CD deploy job with pull-based GitOps model.
#
# Features:
#   - Drift detection: reverts manual kubectl changes within 3 minutes
#   - Audit trail: every sync recorded with git SHA + diff
#   - Multi-env: staging (staging branch) + production (main branch)
#   - Promotion: merge PR staging → main = deploy to production
#
# Access: kubectl port-forward svc/argocd-server -n argocd 8080:443

resource "kubernetes_namespace" "argocd" {
  metadata {
    name = "argocd"
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }
}

resource "helm_release" "argocd" {
  name       = "argocd"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argo-cd"
  version    = var.argocd_version
  namespace  = kubernetes_namespace.argocd.metadata[0].name

  # ClusterIP — access via port-forward only (secure)
  set {
    name  = "server.service.type"
    value = "ClusterIP"
  }

  # Reconciliation interval — how often Argo checks git
  set {
    name  = "server.config.timeout\\.reconciliation"
    value = "180s"
  }

  # Disable Dex (SSO) — use admin password
  set {
    name  = "dex.enabled"
    value = "false"
  }

  # Notifications for Slack/GitHub
  set {
    name  = "notifications.enabled"
    value = "true"
  }

  # Minimal resources for t3.small nodes
  set {
    name  = "server.resources.requests.cpu"
    value = "50m"
  }
  set {
    name  = "server.resources.requests.memory"
    value = "128Mi"
  }
  set {
    name  = "controller.resources.requests.cpu"
    value = "50m"
  }
  set {
    name  = "controller.resources.requests.memory"
    value = "128Mi"
  }
  set {
    name  = "repoServer.resources.requests.cpu"
    value = "50m"
  }
  set {
    name  = "repoServer.resources.requests.memory"
    value = "128Mi"
  }

  wait    = true
  timeout = 600

  depends_on = [kubernetes_namespace.argocd]
}
