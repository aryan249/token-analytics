terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "token-analytics-tfstate"
    key            = "infra/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}

# Outputs consumed by terraform/platform/ for Argo CD + ESO install
output "eks_endpoint" {
  value = aws_eks_cluster.main.endpoint
}

output "eks_ca_data" {
  value     = aws_eks_cluster.main.certificate_authority[0].data
  sensitive = true
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "token-analytics"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
