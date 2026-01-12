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

variable "health_check_path" {
  description = "Health check endpoint path"
  type        = string
  default     = "/health"
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

# -----------------------------------------------------------------------------
# APPLICATION SECRETS (NEW - Phase 3)
# -----------------------------------------------------------------------------


variable "create_parameter_store_kms_key" {
  description = "Whether to create a custom KMS key for Parameter Store"
  type        = bool
  default     = false
}

variable "mongo_uri" {
  description = "MongoDB connection URI"
  type        = string
  sensitive   = true
}

variable "jwt_access_token_secret" {
  description = "JWT access token secret key"
  type        = string
  sensitive   = true
}

variable "jwt_access_token_expires_in" {
  description = "JWT access token expiration time"
  type        = string
  default     = "15m"
}

variable "jwt_refresh_token_secret" {
  description = "JWT refresh token secret key"
  type        = string
  sensitive   = true
}

variable "jwt_refresh_token_expires_in" {
  description = "JWT refresh token expiration time"
  type        = string
  default     = "7d"
}

variable "google_client_id" {
  description = "Google OAuth client ID"
  type        = string
}

variable "google_client_secret" {
  description = "Google OAuth client secret"
  type        = string
  sensitive   = true
}

variable "google_callback_url" {
  description = "Google OAuth callback URL (will be updated with ALB DNS)"
  type        = string
  default     = "http://localhost:8000/api/auth/google/callback" # Placeholder
}

variable "vite_api_base_url" {
  description = "Backend API URL for frontend (Vite)"
  type        = string
  default     = "http://localhost:8000/api"
}

variable "frontend_origin" {
  description = "Frontend origin URL (for CORS)"
  type        = string
  default     = "http://localhost:5173" # Placeholder, will be updated with CloudFront
}

variable "frontend_google_callback_url" {
  description = "Frontend Google OAuth callback URL"
  type        = string
  default     = "http://localhost:5173/google/callback" # Placeholder
}

variable "cookie_domain" {
  description = "Cookie domain for session management"
  type        = string
  default     = "localhost" # Will be updated with actual domain
}

variable "node_env" {
  description = "Node environment (development/production)"
  type        = string
  default     = "production"
}



# -----------------------------------------------------------------------------
# ALB CONFIGURATION
# -----------------------------------------------------------------------------

variable "enable_stickiness" {
  description = "Enable session stickiness on ALB"
  type        = bool
  default     = false
}

variable "certificate_arn" {
  description = "ARN of ACM certificate for HTTPS (optional)"
  type        = string
  default     = null
}

variable "enable_access_logs" {
  description = "Enable ALB access logs"
  type        = bool
  default     = false
}

variable "access_logs_bucket" {
  description = "S3 bucket for ALB access logs"
  type        = string
  default     = null
}