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
# │   AZ-A (us-east-1a)                    AZ-B (us-east-1b)               │
# │   ┌─────────────────────────┐         ┌─────────────────────────┐      │
# │   │ Public: 10.0.1.0/24     │         │ Public: 10.0.2.0/24     │      │
# │   │ • NAT Gateway           │         │ • (ALB)                 │      │
# │   │ • ALB                   │         │                         │      │
# │   └─────────────────────────┘         └─────────────────────────┘      │
# │                                                                         │
# │   ┌─────────────────────────┐         ┌─────────────────────────┐      │
# │   │ Private: 10.0.10.0/24   │         │ Private: 10.0.20.0/24   │      │
# │   │ • ECS Tasks             │         │ • ECS Tasks             │      │
# │   │ • Lambda (if VPC)       │         │ • Lambda (if VPC)       │      │
# │   └─────────────────────────┘         └─────────────────────────┘      │
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
# ELASTIC IP FOR NAT GATEWAY
# -----------------------------------------------------------------------------
# Static IP address for the NAT Gateway
# This IP won't change even if NAT Gateway is recreated

resource "aws_eip" "nat" {
  count = var.enable_nat_gateway ? 1 : 0

  domain = "vpc"

  # Ensure IGW exists before creating EIP
  depends_on = [aws_internet_gateway.main]

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-nat-eip"
  })
}


# -----------------------------------------------------------------------------
# NAT GATEWAY
# -----------------------------------------------------------------------------
# Allows private subnet resources to access the internet (outbound only)
# 
# COST NOTE: NAT Gateway costs ~$32/month + data transfer
# For dev environments, consider:
# - Using a single NAT (not multi-AZ) - what we do here
# - Scheduling NAT deletion on weekends
# - Using NAT instances (more work, but cheaper)
#
# We place NAT in the first public subnet only (cost optimization)
# For production, you'd want one NAT per AZ for high availability

resource "aws_nat_gateway" "main" {
  count = var.enable_nat_gateway ? 1 : 0

  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-nat"
  })

  # NAT Gateway needs IGW to exist first
  depends_on = [aws_internet_gateway.main]
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
# PRIVATE ROUTE TABLE
# -----------------------------------------------------------------------------
# Routes for private subnets:
# - Local traffic stays in VPC (implicit)
# - Everything else (0.0.0.0/0) goes to NAT Gateway (if enabled)


resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-private-rt"
  })
}

# Route to NAT Gateway for private subnets (only if NAT is enabled)
resource "aws_route" "private_nat" {
  count = var.enable_nat_gateway ? 1 : 0

  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[0].id
}

# Associate private subnets with private route table
resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
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
