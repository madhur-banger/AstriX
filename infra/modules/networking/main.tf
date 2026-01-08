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

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support = true

  tags = {
    Name = "astrix-dev-vpc"
  }
}

# Public Subnets (2 for high availability)
resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = ["10.0.1.0/24", "10.0.2.0/24"][count.index]
  availability_zone = ["us-east-1a", "us-east-1b"][count.index]
  
  # Auto-assign public IPs
  map_public_ip_on_launch = true
  
  tags = {
    Name = "astrix-dev-public-${count.index + 1}"
    Tier = "public"
  }
}

# Private Subnets (2 for high availability)
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = ["10.0.10.0/24", "10.0.20.0/24"][count.index]
  availability_zone = ["us-east-1a", "us-east-1b"][count.index]
  
  # No public IPs
  map_public_ip_on_launch = false
  
  tags = {
    Name = "astrix-dev-private-${count.index + 1}"
    Tier = "private"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "astrix-dev-igw"
  }
}

resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name = "astrix-dev-nat-eip"
  }
}


resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id = aws_subnet.public[0].subnet_id

  tags = {
    Name = "astrix-dev-nat"
  }

  depends_on = [ aws_internet_gateway.main ]
}


resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "astrix-dev-public-rt"
  }
}

resource "aws_route" "public_internet" {
  route_table_id = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id = aws_internet_gateway.main.id  
}

resource "aws_route_table_association" "public" {
  count = 2
  subnet_id = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "astrix-dev-private-rt"
  }
}

resource "aws_route" "private_nat" {
  route_table_id = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id = aws_nat_gateway.main.id
}

resource "aws_route_table_association" "private" {
    count = 2
    subnet_id = aws_subnet.private[count.index].id
    route_table_id = aws_route.private_nat.id  
}