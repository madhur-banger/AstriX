# =============================================================================
# NETWORKING MODULE - VARIABLES
# =============================================================================
# All configurable inputs for the networking module
# =============================================================================

# -----------------------------------------------------------------------------
# PROJECT IDENTIFICATION
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Name of the project. Used for resource naming."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.project_name))
    error_message = "Project name must contain only lowercase letters, numbers, and hyphens."
  }
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod."
  }
}

# -----------------------------------------------------------------------------
# VPC CONFIGURATION
# -----------------------------------------------------------------------------

variable "vpc_cidr" {
  description = <<-EOT
    CIDR block for the VPC.
    Default: 10.0.0.0/16 (65,536 IP addresses)
    
    CIDR Planning:
    - /16 = 65,536 IPs (recommended for most cases)
    - /20 = 4,096 IPs (small projects)
    - /24 = 256 IPs (very small/testing)
  EOT
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "VPC CIDR must be a valid IPv4 CIDR block."
  }
}

# -----------------------------------------------------------------------------
# SUBNET CONFIGURATION
# -----------------------------------------------------------------------------

variable "public_subnet_cidrs" {
  description = <<-EOT
    List of CIDR blocks for public subnets.
    These subnets have direct internet access via Internet Gateway.
    
    Default creates 2 subnets:
    - 10.0.1.0/24 (256 IPs) in AZ-a
    - 10.0.2.0/24 (256 IPs) in AZ-b
    
    Used for: ALB, NAT Gateway, Bastion hosts
  EOT
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]

  validation {
    condition     = length(var.public_subnet_cidrs) >= 2
    error_message = "At least 2 public subnets are required for ALB high availability."
  }
}

variable "private_subnet_cidrs" {
  description = <<-EOT
    List of CIDR blocks for private subnets.
    These subnets have NO direct internet access.
    Outbound traffic goes through NAT Gateway.
    
    Default creates 2 subnets:
    - 10.0.10.0/24 (256 IPs) in AZ-a
    - 10.0.20.0/24 (256 IPs) in AZ-b
    
    Used for: ECS tasks, RDS, Lambda (VPC-attached)
  EOT
  type        = list(string)
  default     = ["10.0.10.0/24", "10.0.20.0/24"]

  validation {
    condition     = length(var.private_subnet_cidrs) >= 2
    error_message = "At least 2 private subnets are required for ECS high availability."
  }
}

# -----------------------------------------------------------------------------
# NAT GATEWAY CONFIGURATION
# -----------------------------------------------------------------------------

variable "enable_nat_gateway" {
  description = <<-EOT
    Whether to create a NAT Gateway for private subnet internet access.
    
    COST: ~$32/month + data transfer charges
    
    Set to false if:
    - Your private resources don't need outbound internet
    - You want to minimize costs (but ECS won't be able to pull images!)
    
    For ECS Fargate: This MUST be true (or use VPC endpoints instead)
  EOT
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# FLOW LOGS CONFIGURATION
# -----------------------------------------------------------------------------


variable "enable_flow_logs" {
  description = <<-EOT
    Whether to enable VPC Flow Logs.
    
    Flow logs capture network traffic for:
    - Security analysis
    - Troubleshooting connectivity issues
    - Compliance requirements
    
    COST: CloudWatch Logs ingestion + storage costs
    Recommended: false for dev, true for prod
  EOT
  type        = bool
  default     = false
}


variable "flow_logs_retention_days" {
  description = "Number of days to retain flow logs in CloudWatch"
  type        = number
  default     = 7

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653], var.flow_logs_retention_days)
    error_message = "Flow logs retention must be a valid CloudWatch Logs retention period."
  }
}

# -----------------------------------------------------------------------------
# TAGGING
# -----------------------------------------------------------------------------

variable "common_tags" {
  description = <<-EOT
    Common tags to apply to all resources.
    
    Recommended tags:
    - Environment: dev/staging/prod
    - Project: project name
    - ManagedBy: terraform
    - Owner: team/person responsible
  EOT
  type        = map(string)
  default     = {}
}
