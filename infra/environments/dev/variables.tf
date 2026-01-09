# =============================================================================
# DEV ENVIRONMENT - VARIABLES
# =============================================================================

# -----------------------------------------------------------------------------
# PROJECT IDENTIFICATION
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "dev"
}

variable "owner" {
  description = "Owner of the infrastructure (for tagging)"
  type        = string
}

# -----------------------------------------------------------------------------
# AWS CONFIGURATION
# -----------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-east-1"
}

# -----------------------------------------------------------------------------
# NETWORKING CONFIGURATION
# -----------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets"
  type        = list(string)
  default     = ["10.0.10.0/24", "10.0.20.0/24"]
}

variable "enable_nat_gateway" {
  description = "Whether to create NAT Gateway (required for ECS)"
  type        = bool
  default     = true
}

variable "enable_flow_logs" {
  description = "Whether to enable VPC Flow Logs"
  type        = bool
  default     = false
}

variable "flow_logs_retention_days" {
  description = "Flow logs retention period in days"
  type        = number
  default     = 7
}

# -----------------------------------------------------------------------------
# APPLICATION CONFIGURATION
# -----------------------------------------------------------------------------

variable "app_port" {
  description = "Port the backend application listens on"
  type        = number
  default     = 8080
}

variable "database_port" {
  description = "Port for database connections"
  type        = number
  default     = 27017
}

# -----------------------------------------------------------------------------
# SECURITY CONFIGURATION
# -----------------------------------------------------------------------------

variable "create_lambda_sg" {
  description = "Whether to create Lambda security group"
  type        = bool
  default     = true
}

variable "create_database_sg" {
  description = "Whether to create database security group"
  type        = bool
  default     = false
}

variable "create_vpc_endpoints_sg" {
  description = "Whether to create VPC endpoints security group"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# IAM CONFIGURATION
# -----------------------------------------------------------------------------

variable "kms_key_arn" {
  description = "ARN of KMS key for secrets encryption"
  type        = string
  default     = null
}

variable "lambda_vpc_access" {
  description = "Whether Lambda functions need VPC access"
  type        = bool
  default     = true
}

variable "create_github_oidc" {
  description = "Whether to create GitHub Actions OIDC provider"
  type        = bool
  default     = false
}

variable "github_org" {
  description = "GitHub organization or username"
  type        = string
  default     = ""
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# ECR CONFIGURATION
# -----------------------------------------------------------------------------

variable "create_lambda_ecr" {
  description = "Whether to create ECR repository for Lambda images"
  type        = bool
  default     = false
}

variable "image_retention_count" {
  description = "Number of tagged images to retain"
  type        = number
  default     = 10
}

variable "dev_image_retention_count" {
  description = "Number of dev/feature images to retain"
  type        = number
  default     = 3
}

variable "untagged_image_retention_days" {
  description = "Days to keep untagged images"
  type        = number
  default     = 1
}

variable "cross_account_ids" {
  description = "AWS account IDs that can pull images"
  type        = list(string)
  default     = []
}
