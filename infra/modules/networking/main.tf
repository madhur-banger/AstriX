# =============================================================================
# NETWORKING MODULE
# =============================================================================
# This module creates the foundational network infrastructure:
# - VPC with DNS support
# - Public subnets (for ALB, NAT Gateway)
# - Private subnets (for ECS tasks, Lambda)
# - Internet Gateway (public internet access)
# - NAT Gateway (outbound access for private subnets)
# - Route tables with proper associations
#
# Architecture:
# ┌─────────────────────────────────────────────────────────────────────────┐
# │                           VPC: 10.0.0.0/16                              │
# │                                                                         │
# │   AZ-A (us-east-1a)                    AZ-B (us-east-1b)                │
# │   ┌─────────────────────────┐         ┌─────────────────────────┐       │
# │   │ Public: 10.0.1.0/24     │         │ Public: 10.0.2.0/24     │       │
# │   │ • NAT Gateway           │         │ • (ALB)                 │       │
# │   │ • ALB                   │         │                         │       │
# │   └─────────────────────────┘         └─────────────────────────┘       │
# │                                                                         │
# │   ┌─────────────────────────┐         ┌─────────────────────────┐       │
# │   │ Private: 10.0.10.0/24   │         │ Private: 10.0.20.0/24   │       │
# │   │ • ECS Tasks             │         │ • ECS Tasks             │       │
# │   │ • Lambda (if VPC)       │         │ • Lambda (if VPC)       │       │
# │   └─────────────────────────┘         └─────────────────────────┘       │
# │                                                                         │
# └─────────────────────────────────────────────────────────────────────────┘
# =============================================================================

# -----------------------------------------------------------------------------
# DATA SOURCES
# -----------------------------------------------------------------------------
# Get available AZs in the region to ensure we use valid zones

data "aws_availability_zones" "available" {
  state = "available"

  # Exclude local zones and wavelength zones for simplicity
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

# -----------------------------------------------------------------------------
# VPC
# -----------------------------------------------------------------------------
# The main Virtual Private Cloud - your isolated network in AWS
# 
# Key settings:
# - CIDR: 10.0.0.0/16 gives us 65,536 IP addresses
# - DNS hostnames: Required for ECS service discovery
# - DNS support: Required for internal DNS resolution

resource "aws_vpc" "main" {
  cidr_block = var.vpc_cidr

  # Enable DNS hostnames - required for:
  # - ECS service discovery
  # - RDS endpoint resolution
  # - Many AWS services that need DNS names
  enable_dns_hostnames = true

  # Enable DNS support - required for internal DNS resolution
  enable_dns_support = true

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-vpc"
  })
}

# -----------------------------------------------------------------------------
# PUBLIC SUBNETS
# -----------------------------------------------------------------------------
# These subnets have direct route to the Internet Gateway
# Used for: ALB, NAT Gateway, Bastion hosts (if needed)
#
# We create 2 subnets across 2 AZs for high availability
# ALB requires at least 2 subnets in different AZs

resource "aws_subnet" "public" {
  count = length(var.public_subnet_cidrs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = var.public_subnet_cidrs[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]

  # Auto-assign public IPs to instances launched in this subnet
  # Required for resources that need direct internet access
  map_public_ip_on_launch = true

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-public-${count.index + 1}"
    Tier = "public"
  })
}

# -----------------------------------------------------------------------------
# PRIVATE SUBNETS
# -----------------------------------------------------------------------------
# These subnets have NO direct internet access
# Outbound traffic goes through NAT Gateway
# Used for: ECS tasks, RDS, Lambda (if VPC-attached)
#
# Security benefit: Resources here cannot be directly accessed from internet

resource "aws_subnet" "private" {
  count = length(var.private_subnet_cidrs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]

  # No public IPs for private subnet resources
  map_public_ip_on_launch = false

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-private-${count.index + 1}"
    Tier = "private"
  })
}

# -----------------------------------------------------------------------------
# INTERNET GATEWAY
# -----------------------------------------------------------------------------
# Allows resources in public subnets to access the internet
# and be accessed from the internet (if they have public IPs)

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-igw"
  })
}

# -----------------------------------------------------------------------------
# NAT GATEWAY TOPOLOGY
# -----------------------------------------------------------------------------
# Two shapes, selected by var.single_nat_gateway:
#
#   single_nat_gateway = true  (default, ~$32/month)
#     One NAT in the first public subnet; every private subnet routes through
#     it. Cheapest, but an AZ failure in that one AZ takes outbound internet
#     away from private subnets in *every* AZ - ECS tasks in the healthy AZ
#     stop being able to pull images or reach MongoDB Atlas.
#
#   single_nat_gateway = false (~$32/month per AZ)
#     One NAT + one EIP per public subnet/AZ, and one private route table per
#     AZ pointing at the NAT in its own AZ. An AZ failure is then contained to
#     that AZ. This is the correct production shape.
#
# Flipping this to false costs real money per AZ, so it stays true until
# somebody decides to spend it.

locals {
  nat_gateway_count = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : length(var.public_subnet_cidrs)) : 0

  # One route table shared by all private subnets when a single NAT serves
  # everything; one per private subnet when each AZ has its own NAT.
  private_route_table_count = var.enable_nat_gateway && !var.single_nat_gateway ? length(var.private_subnet_cidrs) : 1
}

# -----------------------------------------------------------------------------
# ELASTIC IPS FOR NAT GATEWAYS
# -----------------------------------------------------------------------------
# Static IP addresses for the NAT Gateways.
# These IPs won't change even if a NAT Gateway is recreated - which matters for
# any third party that allowlists this environment's egress IPs.

resource "aws_eip" "nat" {
  count = local.nat_gateway_count

  domain = "vpc"

  # Ensure IGW exists before creating EIP
  depends_on = [aws_internet_gateway.main]

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-nat-eip-${count.index + 1}"
  })
}


# -----------------------------------------------------------------------------
# NAT GATEWAYS
# -----------------------------------------------------------------------------
# Allows private subnet resources to access the internet (outbound only).
#
# COST NOTE: ~$32/month each + data transfer. Other ways to cut this:
# - Scheduling NAT deletion on weekends
# - VPC endpoints for ECR/S3/SSM (removes most NAT data transfer)
# - NAT instances (more work, but cheaper)

resource "aws_nat_gateway" "main" {
  count = local.nat_gateway_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-nat-${count.index + 1}"
  })

  # NAT Gateway needs IGW to exist first
  depends_on = [aws_internet_gateway.main]

  lifecycle {
    precondition {
      condition     = var.single_nat_gateway || length(var.private_subnet_cidrs) <= length(var.public_subnet_cidrs)
      error_message = "Per-AZ NAT Gateways (single_nat_gateway = false) need at least as many public subnets as private subnets - each private subnet routes to the NAT in its own AZ."
    }
  }
}



# -----------------------------------------------------------------------------
# PUBLIC ROUTE TABLE
# -----------------------------------------------------------------------------
# Routes for public subnets:
# - Local traffic stays in VPC (implicit)
# - Everything else (0.0.0.0/0) goes to Internet Gateway

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-public-rt"
  })
}

# Route to Internet Gateway for public subnets
resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

# Associate public subnets with public route table
resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}


# -----------------------------------------------------------------------------
# PRIVATE ROUTE TABLES
# -----------------------------------------------------------------------------
# Routes for private subnets:
# - Local traffic stays in VPC (implicit)
# - Everything else (0.0.0.0/0) goes to a NAT Gateway (if enabled)
#
# One table shared by every private subnet in single-NAT mode; one table per AZ
# otherwise, so each AZ's egress stays inside that AZ.
#
# MIGRATION NOTE: this resource gained `count`, so its state address moved from
# aws_route_table.private to aws_route_table.private[0]. On an environment
# applied before this change, run this once or Terraform will propose
# destroying and recreating the route table:
#   terraform state mv 'module.networking.aws_route_table.private' \
#                      'module.networking.aws_route_table.private[0]'

resource "aws_route_table" "private" {
  count = local.private_route_table_count

  vpc_id = aws_vpc.main.id

  tags = merge(var.common_tags, {
    Name = local.private_route_table_count == 1 ? "${var.project_name}-${var.environment}-private-rt" : "${var.project_name}-${var.environment}-private-rt-${count.index + 1}"
  })
}

# Route to NAT Gateway for private subnets (only if NAT is enabled).
# In per-AZ mode each table points at the NAT sharing its index, which is the
# NAT in the same availability zone (public and private subnets are both
# indexed against the same AZ list).
resource "aws_route" "private_nat" {
  count = var.enable_nat_gateway ? local.private_route_table_count : 0

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[var.single_nat_gateway ? 0 : count.index].id
}

# Associate private subnets with their route table
resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[local.private_route_table_count == 1 ? 0 : count.index].id
}

# -----------------------------------------------------------------------------
# VPC FLOW LOGS (Optional - for debugging/compliance)
# -----------------------------------------------------------------------------
# Captures network traffic information for analysis
# Useful for: security analysis, troubleshooting connectivity issues
#
# COST NOTE: Flow logs can add costs. Disabled by default for dev.

resource "aws_flow_log" "main" {
  count = var.enable_flow_logs ? 1 : 0

  vpc_id          = aws_vpc.main.id
  traffic_type    = "ALL"
  iam_role_arn    = aws_iam_role.flow_logs[0].arn
  log_destination = aws_cloudwatch_log_group.flow_logs[0].arn

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-flow-logs"
  })
}


resource "aws_cloudwatch_log_group" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name              = "/aws/vpc/${var.project_name}-${var.environment}/flow-logs"
  retention_in_days = var.flow_logs_retention_days

  tags = var.common_tags
}

resource "aws_iam_role" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name = "${var.project_name}-${var.environment}-flow-logs-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "vpc-flow-logs.amazonaws.com"
        }
      }
    ]
  })

  tags = var.common_tags
}

resource "aws_iam_role_policy" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name = "${var.project_name}-${var.environment}-flow-logs-policy"
  role = aws_iam_role.flow_logs[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams"
        ]
        Effect   = "Allow"
        Resource = "*"
      }
    ]
  })
}
