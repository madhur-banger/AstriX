# =============================================================================
# DEV ENVIRONMENT - OUTPUTS
# =============================================================================
# These outputs provide important information about the deployed infrastructure.
# Use these values to configure other tools (ECS, CI/CD, etc.)
# =============================================================================

# -----------------------------------------------------------------------------
# NETWORKING OUTPUTS
# -----------------------------------------------------------------------------

output "vpc_id" {
  description = "ID of the VPC"
  value       = module.networking.vpc_id
}

output "vpc_cidr" {
  description = "CIDR block of the VPC"
  value       = module.networking.vpc_cidr
}

output "public_subnet_ids" {
  description = "IDs of public subnets (for ALB)"
  value       = module.networking.public_subnet_ids
}

output "private_subnet_ids" {
  description = "IDs of private subnets (for ECS tasks)"
  value       = module.networking.private_subnet_ids
}

output "nat_gateway_public_ip" {
  description = "Public IP of NAT Gateway"
  value       = module.networking.nat_gateway_public_ip
}




output "infrastructure_summary" {
  description = "Summary of all infrastructure for quick reference"
  value = {
    environment = var.environment
    region      = var.aws_region

    networking = {
      vpc_id          = module.networking.vpc_id
      public_subnets  = module.networking.public_subnet_ids
      private_subnets = module.networking.private_subnet_ids
      nat_gateway_ip  = module.networking.nat_gateway_public_ip
    }
  }
}