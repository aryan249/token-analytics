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

variable "ecr_keep_images" {
  description = "Number of most recent images to keep in ECR (older ones expire)"
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

variable "rds_multi_az" {
  type    = bool
  default = false
}

variable "rds_backup_window" {
  type    = string
  default = "22:00-23:00"
}

variable "rds_maintenance_window" {
  type    = string
  default = "wed:03:00-wed:04:00"
}

# ── ElastiCache Extra ────────────────────────────────────────────────────────

variable "redis_engine_version" {
  type    = string
  default = "7.1"
}

variable "redis_snapshot_window" {
  type    = string
  default = "22:30-23:30"
}

variable "redis_maintenance_window" {
  type    = string
  default = "wed:04:00-wed:05:00"
}

# ── EKS Extra ────────────────────────────────────────────────────────────────

variable "eks_public_access" {
  description = "Enable public API endpoint (set false for private-only clusters)"
  type        = bool
  default     = true
}

variable "eks_private_access" {
  type    = bool
  default = true
}

# ── Runner Extra ─────────────────────────────────────────────────────────────

variable "runner_ssh_cidr" {
  description = "CIDR for SSH access to runner (default: open — restrict to your IP)"
  type        = string
  default     = "0.0.0.0/0"
}

variable "runner_disk_alert_threshold" {
  type    = number
  default = 85
}

# ── Ports & Protocols (AWS/K8s standards — rarely changed) ───────────────────

variable "eks_api_port" {
  description = "Kubernetes API server port (standard: 443)"
  type        = number
  default     = 443
}

variable "redis_port" {
  description = "Redis port (standard: 6379)"
  type        = number
  default     = 6379
}

variable "postgres_port" {
  description = "PostgreSQL port (standard: 5432)"
  type        = number
  default     = 5432
}

variable "ssh_port" {
  description = "SSH port (standard: 22)"
  type        = number
  default     = 22
}
