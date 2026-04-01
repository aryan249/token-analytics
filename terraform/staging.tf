# ── Staging Environment ───────────────────────────────────────────────────────
#
# Separate RDS + Redis for staging. Shares VPC, subnets, security groups
# with production (same EKS cluster, different namespace).
#
# Enable: set var.staging_enabled = true
# Disable: set var.staging_enabled = false (default — no extra cost)

variable "staging_enabled" {
  description = "Create separate staging RDS + Redis instances"
  type        = bool
  default     = true
}

# ── Staging RDS ──────────────────────────────────────────────────────────────

resource "aws_db_instance" "staging_postgres" {
  count = var.staging_enabled ? 1 : 0

  identifier     = "${var.project}-staging-postgres"
  engine         = "postgres"
  engine_version = "16.6"
  instance_class = var.rds_instance_class

  db_name  = "flaunch_staging"
  username = var.rds_username
  password = var.rds_password

  allocated_storage     = var.rds_storage_size
  max_allocated_storage = var.rds_max_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az            = false
  publicly_accessible = false
  skip_final_snapshot = true

  backup_retention_period = 1
  backup_window           = var.rds_backup_window
  maintenance_window      = var.rds_maintenance_window

  tags = { Name = "${var.project}-staging-postgres" }
}

# ── Staging Redis ────────────────────────────────────────────────────────────

resource "aws_elasticache_parameter_group" "staging_redis" {
  count  = var.staging_enabled ? 1 : 0
  name   = "${var.project}-staging-redis-params"
  family = "redis7"

  tags = { Name = "${var.project}-staging-redis-params" }
}

resource "aws_elasticache_cluster" "staging_redis" {
  count = var.staging_enabled ? 1 : 0

  cluster_id      = "${var.project}-staging-redis"
  engine          = "redis"
  engine_version  = var.redis_engine_version
  node_type       = var.redis_node_type
  num_cache_nodes = 1
  port            = var.redis_port

  parameter_group_name = aws_elasticache_parameter_group.staging_redis[0].name
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]

  snapshot_retention_limit = 0
  maintenance_window       = var.redis_maintenance_window

  tags = { Name = "${var.project}-staging-redis" }
}

# ── Staging Secrets ──────────────────────────────────────────────────────────

resource "aws_secretsmanager_secret" "staging" {
  count                   = var.staging_enabled ? 1 : 0
  name                    = "${var.project}/staging-secrets"
  recovery_window_in_days = 7

  tags = { Name = "${var.project}-staging-secrets" }
}

resource "aws_secretsmanager_secret_version" "staging" {
  count     = var.staging_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.staging[0].id

  secret_string = jsonencode({
    POSTGRES_URL   = "postgresql://${var.rds_username}:${var.rds_password}@${aws_db_instance.staging_postgres[0].endpoint}/flaunch_staging?sslmode=no-verify"
    REDIS_URL      = "redis://${aws_elasticache_cluster.staging_redis[0].cache_nodes[0].address}:${var.redis_port}"
    ALCHEMY_WS_URL = var.alchemy_ws_url
    JWT_SECRET     = var.jwt_secret
  })
}

# ── Staging Outputs ──────────────────────────────────────────────────────────

output "staging_rds_endpoint" {
  value = var.staging_enabled ? aws_db_instance.staging_postgres[0].endpoint : ""
}

output "staging_redis_endpoint" {
  value = var.staging_enabled ? "${aws_elasticache_cluster.staging_redis[0].cache_nodes[0].address}:${var.redis_port}" : ""
}
