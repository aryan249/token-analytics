# ── AWS Secrets Manager ───────────────────────────────────────────────────────

resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.project}/app-secrets"
  recovery_window_in_days = 7

  tags = { Name = "${var.project}-app-secrets" }
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    POSTGRES_URL   = "postgresql://${var.rds_username}:${var.rds_password}@${aws_db_instance.postgres.endpoint}/${var.rds_db_name}"
    REDIS_URL      = "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:${aws_elasticache_cluster.redis.port}"
    ALCHEMY_WS_URL = var.alchemy_ws_url
    JWT_SECRET     = var.jwt_secret
  })
}

# ── IAM policy for External Secrets Operator to read from Secrets Manager ────

resource "aws_iam_policy" "external_secrets" {
  name = "${var.project}-external-secrets"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
      ]
      Resource = aws_secretsmanager_secret.app.arn
    }]
  })
}

# IRSA (IAM Roles for Service Accounts) for External Secrets Operator
resource "aws_iam_role" "external_secrets" {
  name = "${var.project}-external-secrets-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = aws_eks_cluster.main.identity[0].oidc[0].issuer != "" ? "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}" : ""
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}:sub" = "system:serviceaccount:token-analytics:external-secrets-sa"
          "${replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "external_secrets" {
  role       = aws_iam_role.external_secrets.name
  policy_arn = aws_iam_policy.external_secrets.arn
}

# OIDC provider for EKS (needed for IRSA)
data "tls_certificate" "eks" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
}
