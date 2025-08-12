# ── VPC Peer Acceptor ────────────────────────────────────────────────────────
#
# Run this module IN THE PEER REGION to accept a peering connection
# and configure routes back to the primary region.
#
# Usage (in the peer region's terraform):
#
#   module "accept_peering" {
#     source = "../modules/vpc-peer-acceptor"
#
#     peering_connection_id = "pcx-0123456789abcdef0"  # from primary region output
#     primary_vpc_cidr      = "10.0.0.0/16"
#     vpc_id                = aws_vpc.main.id
#     private_route_table_id = aws_route_table.private.id
#     public_route_table_id  = aws_route_table.public.id
#     redis_security_group_id = aws_security_group.redis.id
#     eks_security_group_id   = aws_security_group.eks_cluster.id
#   }

variable "peering_connection_id" {
  type        = string
  description = "VPC peering connection ID from the primary region"
}

variable "primary_vpc_cidr" {
  type        = string
  description = "CIDR of the primary VPC (e.g., 10.0.0.0/16)"
}

variable "vpc_id" {
  type        = string
  description = "VPC ID in this (peer) region"
}

variable "private_route_table_id" {
  type        = string
  description = "Private route table ID in this region"
}

variable "public_route_table_id" {
  type        = string
  description = "Public route table ID in this region"
}

variable "redis_security_group_id" {
  type        = string
  description = "Redis security group ID in this region"
}

variable "eks_security_group_id" {
  type        = string
  description = "EKS cluster security group ID in this region"
}

# Accept the peering connection
resource "aws_vpc_peering_connection_accepter" "accept" {
  vpc_peering_connection_id = var.peering_connection_id
  auto_accept               = true

  tags = {
    Name = "token-analytics-peering-accepted"
    Side = "accepter"
  }
}

# Enable DNS resolution on the accepter side
resource "aws_vpc_peering_connection_options" "accepter_dns" {
  vpc_peering_connection_id = var.peering_connection_id

  accepter {
    allow_remote_vpc_dns_resolution = true
  }

  depends_on = [aws_vpc_peering_connection_accepter.accept]
}

# Route: peer private subnets → primary VPC via peering
resource "aws_route" "private_to_primary" {
  route_table_id            = var.private_route_table_id
  destination_cidr_block    = var.primary_vpc_cidr
  vpc_peering_connection_id = var.peering_connection_id
}

resource "aws_route" "public_to_primary" {
  route_table_id            = var.public_route_table_id
  destination_cidr_block    = var.primary_vpc_cidr
  vpc_peering_connection_id = var.peering_connection_id
}

# Allow Redis traffic from primary VPC
resource "aws_security_group_rule" "redis_from_primary" {
  type              = "ingress"
  from_port         = 6379
  to_port           = 6379
  protocol          = "tcp"
  cidr_blocks       = [var.primary_vpc_cidr]
  security_group_id = var.redis_security_group_id
  description       = "Redis from primary VPC"
}

# Allow EKS to reach primary region's Redis (for cross-region reads if needed)
resource "aws_security_group_rule" "eks_to_primary_redis" {
  type              = "egress"
  from_port         = 6379
  to_port           = 6379
  protocol          = "tcp"
  cidr_blocks       = [var.primary_vpc_cidr]
  security_group_id = var.eks_security_group_id
  description       = "EKS to primary Redis"
}
