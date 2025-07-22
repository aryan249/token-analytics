# ── Cross-Region VPC Peering ──────────────────────────────────────────────────
#
# Enables the scanner (primary region) to reach Redis instances in peer regions
# for multi-region fan-out publishing (REDIS_REPLICA_URLS).
#
# Architecture:
#
#   Primary Region (ap-south-1)          Peer Region (e.g. eu-west-1)
#   ┌────────────────────────┐          ┌────────────────────────┐
#   │  VPC 10.0.0.0/16       │          │  VPC 10.1.0.0/16       │
#   │                        │          │                        │
#   │  Scanner ──xAdd──┐     │ peering  │     ┌── Redis (peer)  │
#   │  API pods        │     │◄────────►│     │  Processors     │
#   │  Processors      │     │  routes  │     │  API pods       │
#   │  Redis (primary) │     │          │     │                  │
#   │  Postgres        │     │          │     │  Postgres        │
#   └────────────────────────┘          └────────────────────────┘
#
# Traffic flow:
#   Scanner → private route table → peering connection → peer VPC → peer Redis:6379
#
# Security:
#   - Only Redis port (6379) is allowed across the peering connection
#   - DNS resolution enabled so scanner can use hostnames
#   - No internet traffic crosses the peering (private-to-private)
#
# To enable: set var.peer_regions with the peer VPC details.
# To disable: leave var.peer_regions empty (default).

# ── Variables ────────────────────────────────────────────────────────────────

variable "peer_regions" {
  description = "List of peer regions for VPC peering. Each entry creates a peering connection."
  type = list(object({
    region          = string  # e.g. "eu-west-1"
    vpc_id          = string  # VPC ID in the peer region
    vpc_cidr        = string  # CIDR of the peer VPC (e.g. "10.1.0.0/16")
    account_id      = string  # AWS account ID (same or cross-account)
  }))
  default = []
}

# ── Peering Connections ──────────────────────────────────────────────────────

resource "aws_vpc_peering_connection" "peer" {
  count = length(var.peer_regions)

  vpc_id      = aws_vpc.main.id
  peer_vpc_id = var.peer_regions[count.index].vpc_id
  peer_region = var.peer_regions[count.index].region
  peer_owner_id = var.peer_regions[count.index].account_id

  tags = {
    Name = "${var.project}-peering-${var.peer_regions[count.index].region}"
    Peer = var.peer_regions[count.index].region
  }
}

# ── Route Table Entries (primary → peer) ─────────────────────────────────────
# Add routes to the private route table so pods in private subnets
# can reach the peer VPC's CIDR via the peering connection.

resource "aws_route" "private_to_peer" {
  count = length(var.peer_regions)

  route_table_id            = aws_route_table.private.id
  destination_cidr_block    = var.peer_regions[count.index].vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.peer[count.index].id
}

# Also add to public route table (for the GitHub runner if it needs cross-region access)
resource "aws_route" "public_to_peer" {
  count = length(var.peer_regions)

  route_table_id            = aws_route_table.public.id
  destination_cidr_block    = var.peer_regions[count.index].vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.peer[count.index].id
}

# ── Security Group Rules (allow Redis traffic from peer) ─────────────────────

# Allow inbound Redis from peer VPCs (for the peer region's processors to read)
resource "aws_security_group_rule" "redis_from_peer" {
  count = length(var.peer_regions)

  type              = "ingress"
  from_port         = var.redis_port
  to_port           = var.redis_port
  protocol          = "tcp"
  cidr_blocks       = [var.peer_regions[count.index].vpc_cidr]
  security_group_id = aws_security_group.redis.id
  description       = "Redis from peer VPC ${var.peer_regions[count.index].region}"
}

# Allow outbound to peer Redis (for the scanner to publish to peer Redis)
resource "aws_security_group_rule" "eks_to_peer_redis" {
  count = length(var.peer_regions)

  type              = "egress"
  from_port         = var.redis_port
  to_port           = var.redis_port
  protocol          = "tcp"
  cidr_blocks       = [var.peer_regions[count.index].vpc_cidr]
  security_group_id = aws_security_group.eks_cluster.id
  description       = "EKS to peer Redis ${var.peer_regions[count.index].region}"
}

# ── DNS Resolution over Peering ──────────────────────────────────────────────
# Enable DNS resolution so the scanner can resolve peer Redis hostnames
# (e.g., token-analytics-redis.xxxxx.euw1.cache.amazonaws.com)

resource "aws_vpc_peering_connection_options" "peer_dns" {
  count = length(var.peer_regions)

  vpc_peering_connection_id = aws_vpc_peering_connection.peer[count.index].id

  requester {
    allow_remote_vpc_dns_resolution = true
  }

  depends_on = [aws_vpc_peering_connection.peer]
}

# ── Outputs ──────────────────────────────────────────────────────────────────

output "vpc_peering_ids" {
  description = "VPC peering connection IDs (need to be accepted in peer regions)"
  value = {
    for i, peer in var.peer_regions :
    peer.region => aws_vpc_peering_connection.peer[i].id
  }
}

output "vpc_peering_status" {
  description = "VPC peering connection statuses"
  value = {
    for i, peer in var.peer_regions :
    peer.region => aws_vpc_peering_connection.peer[i].status
  }
}
