# =============================================================================
# SECURITY MODULE - VARIABLES
# =============================================================================

# -----------------------------------------------------------------------------
# PROJECT IDENTIFICATION
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Name of the project. Used for resource naming."
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

# -----------------------------------------------------------------------------
# VPC CONFIGURATION (Required from networking module)
# -----------------------------------------------------------------------------

variable "vpc_id" {
  description = "ID of the VPC where security groups will be created"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC (used for VPC endpoint rules)"
  type        = string
}


# -----------------------------------------------------------------------------
# APPLICATION CONFIGURATION
# -----------------------------------------------------------------------------

variable "app_port" {
  description = <<-EOT
    Port that the backend application listens on.
    This is the port ECS tasks expose.
    
    Common values:
    - 3000 (Express.js default)
    - 8080 (Common alternative)
    - 4000 (GraphQL convention)
  EOT
  type        = number
  default     = 8080
}

variable "database_port" {
  description = <<-EOT
    Port for database connections.
    Only used if create_database_sg is true.
    
    Common values:
    - 5432 (PostgreSQL)
    - 3306 (MySQL)
    - 27017 (MongoDB)
    - 6379 (Redis)
  EOT
  type        = number
  default     = 27017
}

# -----------------------------------------------------------------------------
# OPTIONAL SECURITY GROUPS
# -----------------------------------------------------------------------------

variable "create_lambda_sg" {
  description = <<-EOT
    Whether to create a security group for VPC-attached Lambda functions.
    
    Set to true if your Lambda functions need:
    - Access to VPC resources (RDS, ElastiCache)
    - Fixed IP addresses (via NAT Gateway)
    
    Note: VPC-attached Lambdas have cold start penalty
  EOT
  type        = bool
  default     = true
}

variable "create_database_sg" {
  description = <<-EOT
    Whether to create a security group for database instances.
    
    Set to true if you plan to:
    - Use RDS instead of MongoDB Atlas
    - Use DocumentDB
    - Use ElastiCache
    
    Since you're using MongoDB Atlas, you might not need this.
  EOT
  type        = bool
  default     = false
}

variable "create_vpc_endpoints_sg" {
  description = <<-EOT
    Whether to create a security group for VPC Endpoints.
    
    VPC Endpoints allow private access to AWS services:
    - Avoid NAT Gateway data charges
    - Improve security (traffic stays in AWS)
    
    Useful for: ECR, S3, DynamoDB, SQS, SNS
  EOT
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# TAGGING
# -----------------------------------------------------------------------------

variable "common_tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default     = {}
}
