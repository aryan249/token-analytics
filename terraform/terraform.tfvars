# ── Terraform Configuration ──────────────────────────────────────────────────
# Single file for all non-sensitive values. Edit here, not in .tf files.
#
# SENSITIVE values — never commit these. Pass via environment:
#   export TF_VAR_rds_password="..."
#   export TF_VAR_alchemy_ws_url="..."
#   export TF_VAR_jwt_secret="..."
#   export TF_VAR_github_runner_token="..."

# Region & Project
aws_region  = "ap-south-1"
environment = "production"
project     = "token-analytics"

# VPC
vpc_cidr           = "10.0.0.0/16"
availability_zones = ["ap-south-1a", "ap-south-1b"]

# EKS
eks_cluster_version    = "1.29"
eks_node_instance_type = "t3.small"
eks_node_desired       = 3
eks_node_min           = 1
eks_node_max           = 4
eks_public_access      = true
eks_private_access     = true

# RDS
rds_instance_class     = "db.t3.micro"
rds_db_name            = "flaunch"
rds_username           = "postgres"
rds_multi_az           = false
rds_storage_size       = 20
rds_max_storage        = 50
rds_backup_retention   = 7
rds_backup_window      = "22:00-23:00"
rds_maintenance_window = "wed:03:00-wed:04:00"

# Redis
redis_node_type          = "cache.t3.micro"
redis_engine_version     = "7.1"
redis_snapshot_window    = "22:30-23:30"
redis_maintenance_window = "wed:04:00-wed:05:00"

# ECR
ecr_tag_mutability = "IMMUTABLE"
ecr_keep_images    = 10

# Runner
runner_instance_type        = "t3.small"
runner_volume_size          = 30
runner_ssh_cidr             = "0.0.0.0/0"
runner_disk_alert_threshold = 85

# GitHub
github_repo = "aryan249/token-analytics"

# Ports
eks_api_port  = 443
redis_port    = 6379
postgres_port = 5432
ssh_port      = 22
