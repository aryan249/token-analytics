# ── External Secrets Operator ─────────────────────────────────────────────────
#
# Syncs secrets from AWS Secrets Manager into Kubernetes Secrets.
# Uses IRSA (IAM Role for Service Account) — no stored credentials.

resource "kubernetes_namespace" "external_secrets" {
  metadata {
    name = "external-secrets"
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }
}

resource "helm_release" "external_secrets" {
  name       = "external-secrets"
  repository = "https://charts.external-secrets.io"
  chart      = "external-secrets"
  namespace  = kubernetes_namespace.external_secrets.metadata[0].name

  set {
    name  = "installCRDs"
    value = "true"
  }

  # Minimal resources
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

  depends_on = [kubernetes_namespace.external_secrets]
}
