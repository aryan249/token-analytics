variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "project" {
  type    = string
  default = "token-analytics"
}

# ── VPC ───────────────────────────────────────────────────────────────────────

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "availability_zones" {
  type    = list(string)
  default = ["ap-south-1a", "ap-south-1b"]
}

# ── EKS ───────────────────────────────────────────────────────────────────────

variable "eks_cluster_version" {
  type    = string
  default = "1.29"
}

variable "eks_node_instance_type" {
  type    = string
  default = "t3.small"
}

variable "eks_node_desired" {
  type    = number
  default = 3
}

variable "eks_node_min" {
  type    = number
  default = 1
}

variable "eks_node_max" {
  type    = number
  default = 4
}

# ── RDS ───────────────────────────────────────────────────────────────────────

variable "rds_instance_class" {
  type    = string
  default = "db.t3.micro"
}

variable "rds_db_name" {
  type    = string
  default = "flaunch"
}

variable "rds_username" {
  type    = string
  default = "postgres"
}

variable "rds_password" {
  type      = string
  sensitive = true
}

# ── ElastiCache ───────────────────────────────────────────────────────────────

variable "redis_node_type" {
  type    = string
  default = "cache.t3.micro"
}

# ── GitHub Runner ─────────────────────────────────────────────────────────────

variable "runner_instance_type" {
  type    = string
  default = "t3.small"
}

variable "runner_volume_size" {
  type    = number
  default = 30
}

variable "github_repo" {
  type    = string
  default = "aryan249/token-analytics"
}

variable "github_runner_token" {
  type      = string
  sensitive = true
  default   = ""
}

variable "alchemy_ws_url" {
  type      = string
  sensitive = true
}

variable "jwt_secret" {
  type      = string
  sensitive = true
}

# ── ECR ──────────────────────────────────────────────────────────────────────

variable "ecr_tag_mutability" {
  type    = string
  default = "IMMUTABLE"
}

variable "ecr_retention_days" {
  description = "Expire images not pushed within this many days"
  type        = number
  default     = 30
}

variable "ecr_keep_images" {
  description = "Description label for lifecycle policy"
  type        = number
  default     = 10
}

# ── RDS Extra ────────────────────────────────────────────────────────────────

variable "rds_backup_retention" {
  type    = number
  default = 7
}

variable "rds_storage_size" {
  type    = number
  default = 20
}

variable "rds_max_storage" {
  type    = number
  default = 50
}
