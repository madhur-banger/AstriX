# =============================================================================
# NETWORKING MODULE - OUTPUTS
# =============================================================================
# These outputs are used by other modules (security, ecs, lambda, etc.)
# to reference networking resources
# =============================================================================

# -----------------------------------------------------------------------------
# VPC OUTPUTS
# -----------------------------------------------------------------------------


output "vpc_id" {
  description = "The ID of the VPC"
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "The CIDR block of the VPC"
  value       = aws_vpc.main.cidr_block
}

output "vpc_arn" {
  description = "The ARN of the VPC"
  value       = aws_vpc.main.arn
}

# -----------------------------------------------------------------------------
# SUBNET OUTPUTS
# -----------------------------------------------------------------------------

output "public_subnet_ids" {
  description = <<-EOT
    List of public subnet IDs.
    Use for: ALB, NAT Gateway placement
  EOT
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = <<-EOT
    List of private subnet IDs.
    Use for: ECS tasks, RDS, Lambda (VPC-attached)
  EOT
  value       = aws_subnet.private[*].id
}

output "public_subnet_cidrs" {
  description = "List of public subnet CIDR blocks"
  value       = aws_subnet.public[*].cidr_block
}

output "private_subnet_cidrs" {
  description = "List of private subnet CIDR blocks"
  value       = aws_subnet.private[*].cidr_block
}

output "public_subnet_azs" {
  description = "List of availability zones for public subnets"
  value       = aws_subnet.public[*].availability_zone
}

output "private_subnet_azs" {
  description = "List of availability zones for private subnets"
  value       = aws_subnet.private[*].availability_zone
}

# -----------------------------------------------------------------------------
# GATEWAY OUTPUTS
# -----------------------------------------------------------------------------

output "internet_gateway_id" {
  description = "The ID of the Internet Gateway"
  value       = aws_internet_gateway.main.id
}

output "nat_gateway_id" {
  description = "The ID of the first NAT Gateway (null if disabled). See nat_gateway_ids for all of them."
  value       = length(aws_nat_gateway.main) > 0 ? aws_nat_gateway.main[0].id : null
}

output "nat_gateway_ids" {
  description = "IDs of every NAT Gateway (one per AZ when single_nat_gateway is false)"
  value       = aws_nat_gateway.main[*].id
}

output "nat_gateway_public_ip" {
  description = "The public IP of the first NAT Gateway (null if disabled). See nat_gateway_public_ips for all of them."
  value       = length(aws_eip.nat) > 0 ? aws_eip.nat[0].public_ip : null
}

output "nat_gateway_public_ips" {
  description = "Public IPs of every NAT Gateway - this is the full egress IP set to hand to anyone allowlisting this environment"
  value       = aws_eip.nat[*].public_ip
}

# -----------------------------------------------------------------------------
# ROUTE TABLE OUTPUTS
# -----------------------------------------------------------------------------

output "public_route_table_id" {
  description = "The ID of the public route table"
  value       = aws_route_table.public.id
}

output "private_route_table_id" {
  description = "The ID of the first private route table. See private_route_table_ids when running one per AZ."
  value       = aws_route_table.private[0].id
}

output "private_route_table_ids" {
  description = "IDs of every private route table (one per AZ when single_nat_gateway is false)"
  value       = aws_route_table.private[*].id
}

# -----------------------------------------------------------------------------
# AVAILABILITY ZONE OUTPUTS
# -----------------------------------------------------------------------------

output "availability_zones" {
  description = "List of availability zones used"
  value       = data.aws_availability_zones.available.names
}

output "azs_count" {
  description = "Number of availability zones used"
  value       = length(data.aws_availability_zones.available.names)
}

# -----------------------------------------------------------------------------
# COMPUTED OUTPUTS (for convenience)
# -----------------------------------------------------------------------------

output "network_summary" {
  description = "Summary of network configuration for debugging"
  value = {
    vpc_id              = aws_vpc.main.id
    vpc_cidr            = aws_vpc.main.cidr_block
    public_subnets      = aws_subnet.public[*].id
    private_subnets     = aws_subnet.private[*].id
    nat_gateway_enabled = var.enable_nat_gateway
    nat_gateway_count   = length(aws_nat_gateway.main)
    flow_logs_enabled   = var.enable_flow_logs
  }
}
