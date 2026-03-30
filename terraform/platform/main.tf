# ── Platform Layer ────────────────────────────────────────────────────────────
#
# Installs platform services ON TOP of the EKS cluster created by ../
# Separate state file so `terraform destroy` on infra doesn't orphan apps.
#
# Depends on: terraform/ (infra) outputs — EKS endpoint, CA data
#
# Contains:
#   - Argo CD (GitOps controller)
#   - External Secrets Operator (secrets sync)
#
# Usage:
#   cd terraform/platform
#   terraform init
#   terraform apply -var="eks_cluster_name=token-analytics"

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.0"
    }
  }

  backend "s3" {
    bucket         = "token-analytics-tfstate"
    key            = "platform/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}

variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "eks_cluster_name" {
  type    = string
  default = "token-analytics"
}

provider "aws" {
  region = var.aws_region
}

# Read EKS cluster info from AWS (no dependency on infra state)
data "aws_eks_cluster" "main" {
  name = var.eks_cluster_name
}

data "aws_eks_cluster_auth" "main" {
  name = var.eks_cluster_name
}

provider "kubernetes" {
  host                   = data.aws_eks_cluster.main.endpoint
  cluster_ca_certificate = base64decode(data.aws_eks_cluster.main.certificate_authority[0].data)
  token                  = data.aws_eks_cluster_auth.main.token
}

provider "helm" {
  kubernetes {
    host                   = data.aws_eks_cluster.main.endpoint
    cluster_ca_certificate = base64decode(data.aws_eks_cluster.main.certificate_authority[0].data)
    token                  = data.aws_eks_cluster_auth.main.token
  }
}
