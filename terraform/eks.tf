# ── Security Group ────────────────────────────────────────────────────────────

resource "aws_security_group" "eks_cluster" {
  name_prefix = "${var.project}-eks-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = var.eks_api_port
    to_port     = var.eks_api_port
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-eks-sg" }
}

# ── EKS Cluster ──────────────────────────────────────────────────────────────

resource "aws_eks_cluster" "main" {
  name     = var.project
  version  = var.eks_cluster_version
  role_arn = aws_iam_role.eks_cluster.arn

  vpc_config {
    subnet_ids              = concat(aws_subnet.private[*].id, aws_subnet.public[*].id)
    security_group_ids      = [aws_security_group.eks_cluster.id]
    endpoint_private_access = var.eks_private_access
    endpoint_public_access  = var.eks_public_access
  }

  access_config {
    authentication_mode                         = "API_AND_CONFIG_MAP"
    bootstrap_cluster_creator_admin_permissions = true
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator"]

  depends_on = [aws_iam_role_policy_attachment.eks_cluster_policy]
}

# ── Node Group ────────────────────────────────────────────────────────────────

resource "aws_eks_node_group" "workers" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.project}-workers"
  node_role_arn   = aws_iam_role.eks_nodes.arn
  subnet_ids      = aws_subnet.private[*].id
  instance_types  = [var.eks_node_instance_type]

  scaling_config {
    desired_size = var.eks_node_desired
    min_size     = var.eks_node_min
    max_size     = var.eks_node_max
  }

  labels = {
    role = "worker"
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_worker,
    aws_iam_role_policy_attachment.eks_cni,
    aws_iam_role_policy_attachment.ecr_read,
  ]
}

# ── EKS Access: runner gets read-only view (Argo CD handles deploys) ────────

resource "aws_eks_access_entry" "runner" {
  cluster_name  = aws_eks_cluster.main.name
  principal_arn = aws_iam_role.runner.arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "runner_view" {
  cluster_name  = aws_eks_cluster.main.name
  principal_arn = aws_iam_role.runner.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy"

  access_scope {
    type = "cluster"
  }

  depends_on = [aws_eks_access_entry.runner]
}
