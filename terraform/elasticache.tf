# ── ElastiCache Subnet Group ──────────────────────────────────────────────────

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.project}-redis-subnet"
  subnet_ids = aws_subnet.private[*].id
}

# ── ElastiCache Security Group ───────────────────────────────────────────────

resource "aws_security_group" "redis" {
  name_prefix = "${var.project}-redis-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = var.redis_port
    to_port         = var.redis_port
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_cluster.id]
    description     = "Redis from EKS"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-redis-sg" }
}

# ── Redis Parameter Group (enable AOF persistence) ──────────────────────────
#
# AOF (append-only file) persists every write to disk. On Redis restart,
# the AOF is replayed to restore state — no data loss for streams, caches,
# or persisted processor state (makerCache, pendingPoolState, tokenMeta).
#
# Without AOF, a Redis restart loses all in-memory data (streams, cache, etc.)
# and processors must re-derive state from the blockchain — causing minutes of
# stale data and missed WebSocket updates.

resource "aws_elasticache_parameter_group" "redis" {
  name   = "${var.project}-redis-params"
  family = "redis7"

  parameter {
    name  = "appendonly"
    value = "yes"
  }

  parameter {
    name  = "appendfsync"
    value = "everysec" # fsync every second — max 1s data loss on crash, good perf
  }

  tags = { Name = "${var.project}-redis-params" }
}

# ── ElastiCache Redis ────────────────────────────────────────────────────────

resource "aws_elasticache_cluster" "redis" {
  cluster_id      = "${var.project}-redis"
  engine          = "redis"
  engine_version  = var.redis_engine_version
  node_type       = var.redis_node_type
  num_cache_nodes = 1
  port            = var.redis_port

  parameter_group_name = aws_elasticache_parameter_group.redis.name
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]

  snapshot_retention_limit = 1
  snapshot_window          = var.redis_snapshot_window
  maintenance_window       = var.redis_maintenance_window

  tags = { Name = "${var.project}-redis" }
}
