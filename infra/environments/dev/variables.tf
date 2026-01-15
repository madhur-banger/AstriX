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

# -----------------------------------------------------------------------------
# ECS CONFIGURATION (NEW - Phase 3)
# -----------------------------------------------------------------------------

variable "ecs_image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

variable "ecs_task_cpu" {
  description = "CPU units for ECS task (256, 512, 1024, 2048, 4096)"
  type        = number
  default     = 512 # 0.5 vCPU - cheapest option
}

variable "ecs_task_memory" {
  description = "Memory for ECS task in MB"
  type        = number
  default     = 1024 # 1 GB
}

variable "ecs_desired_count" {
  description = "Desired number of ECS tasks"
  type        = number
  default     = 2
}

variable "ecs_deployment_minimum_healthy_percent" {
  description = "Minimum healthy percent during deployment"
  type        = number
  default     = 100
}

variable "ecs_deployment_maximum_percent" {
  description = "Maximum percent during deployment"
  type        = number
  default     = 200
}

variable "ecs_health_check_grace_period" {
  description = "Health check grace period in seconds"
  type        = number
  default     = 60
}

variable "enable_ecs_exec" {
  description = "Enable ECS Exec for debugging"
  type        = bool
  default     = false
}

variable "ecs_min_capacity" {
  description = "Minimum number of ECS tasks"
  type        = number
  default     = 1
}

variable "ecs_max_capacity" {
  description = "Maximum number of ECS tasks"
  type        = number
  default     = 4
}

variable "ecs_cpu_target_value" {
  description = "Target CPU utilization for auto-scaling (%)"
  type        = number
  default     = 70
}

variable "ecs_memory_target_value" {
  description = "Target memory utilization for auto-scaling (%)"
  type        = number
  default     = 80
}

variable "ecs_scale_in_cooldown" {
  description = "Cooldown period for scaling in (seconds)"
  type        = number
  default     = 300
}

variable "ecs_scale_out_cooldown" {
  description = "Cooldown period for scaling out (seconds)"
  type        = number
  default     = 60
}

variable "ecs_fargate_weight" {
  description = "Weight for FARGATE capacity provider"
  type        = number
  default     = 1
}

variable "ecs_fargate_base" {
  description = "Base number of tasks to run on FARGATE"
  type        = number
  default     = 1
}

variable "ecs_fargate_spot_weight" {
  description = "Weight for FARGATE_SPOT capacity provider (0 = disabled)"
  type        = number
  default     = 0
}

variable "ecs_log_retention_days" {
  description = "CloudWatch log retention period in days"
  type        = number
  default     = 7
}

variable "enable_container_insights" {
  description = "Enable Container Insights for monitoring"
  type        = bool
  default     = false
}

variable "enable_ecs_alarms" {
  description = "Enable CloudWatch alarms for ECS"
  type        = bool
  default     = false
}


# =============================================================================
# CLOUDFRONT + S3 CONFIGURATION (NEW - Phase 4)
# =============================================================================

# -----------------------------------------------------------------------------
# S3 BUCKET CONFIGURATION
# -----------------------------------------------------------------------------

variable "frontend_bucket_name" {
  description = "Custom bucket name for frontend (optional - defaults to project-env-frontend)"
  type        = string
  default     = null
}

variable "frontend_force_destroy" {
  description = "Allow bucket deletion even with objects (use with caution in prod)"
  type        = bool
  default     = true # Safe for dev, set to false in prod
}

variable "frontend_enable_versioning" {
  description = "Enable S3 bucket versioning for frontend"
  type        = bool
  default     = true
}

variable "frontend_kms_key_arn" {
  description = "KMS key ARN for S3 encryption (optional)"
  type        = string
  default     = null
}

variable "frontend_enable_lifecycle_rules" {
  description = "Enable lifecycle rules for cost optimization"
  type        = bool
  default     = true
}

variable "frontend_noncurrent_version_expiration_days" {
  description = "Days to keep noncurrent versions of frontend files"
  type        = number
  default     = 30
}

variable "frontend_cors_allowed_origins" {
  description = "Allowed origins for CORS on S3 bucket"
  type        = list(string)
  default     = ["*"]
}


# -----------------------------------------------------------------------------
# CLOUDFRONT CONFIGURATION
# -----------------------------------------------------------------------------

variable "cloudfront_price_class" {
  description = "CloudFront price class (PriceClass_100=cheapest, PriceClass_All=global)"
  type        = string
  default     = "PriceClass_100" # US, Canada, Europe only
}

variable "cloudfront_enable_spa_routing" {
  description = "Enable SPA routing (serve index.html for all routes)"
  type        = bool
  default     = true
}

variable "cloudfront_alb_protocol_policy" {
  description = "Protocol policy for ALB origin (http-only, https-only, match-viewer)"
  type        = string
  default     = "http-only" # Change to https-only if ALB has HTTPS
}


# -----------------------------------------------------------------------------
# CUSTOM DOMAIN CONFIGURATION
# -----------------------------------------------------------------------------

variable "frontend_domain_name" {
  description = "Custom domain name for CloudFront (e.g., app.example.com)"
  type        = string
  default     = null
}

variable "frontend_acm_certificate_arn" {
  description = "ACM certificate ARN for HTTPS (must be in us-east-1 for CloudFront)"
  type        = string
  default     = null
}

variable "frontend_route53_zone_id" {
  description = "Route53 hosted zone ID for DNS records"
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# SECURITY CONFIGURATION
# -----------------------------------------------------------------------------

variable "cloudfront_web_acl_id" {
  description = "AWS WAF Web ACL ID for CloudFront (optional)"
  type        = string
  default     = null
}

variable "cloudfront_content_security_policy" {
  description = "Content Security Policy header value (optional)"
  type        = string
  default     = null
}

variable "cloudfront_geo_restriction_type" {
  description = "Geo restriction type (none, whitelist, blacklist)"
  type        = string
  default     = "none"
}

variable "cloudfront_geo_restriction_locations" {
  description = "List of country codes for geo restriction"
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# LOGGING CONFIGURATION
# -----------------------------------------------------------------------------

variable "cloudfront_enable_logging" {
  description = "Enable CloudFront access logging"
  type        = bool
  default     = false
}

variable "cloudfront_log_bucket" {
  description = "S3 bucket for CloudFront logs"
  type        = string
  default     = null
}

variable "cloudfront_log_prefix" {
  description = "Prefix for CloudFront log files"
  type        = string
  default     = null
}

variable "cloudfront_log_include_cookies" {
  description = "Include cookies in CloudFront access logs"
  type        = bool
  default     = false
}



# HTTPS Configuration
variable "enable_https" {
  description = "Enable HTTPS on ALB"
  type        = bool
  default     = true
}

variable "ssl_policy" {
  description = "SSL policy for HTTPS listener"
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "redirect_http_to_https" {
  description = "Redirect HTTP to HTTPS"
  type        = bool
  default     = true
}

variable "alb_certificate_arn" {
  description = "ARN of existing ACM certificate"
  type        = string
  default     = null
}

# For ALB custom domain (different from frontend_domain_name)
variable "enable_alb_custom_domain" {
  description = "Enable custom domain for ALB"
  type        = bool
  default     = false
}

variable "alb_custom_domain_name" {
  description = "Custom domain for ALB (e.g., api.example.com)"
  type        = string
  default     = null
}

variable "include_wildcard_cert" {
  description = "Include wildcard in certificate"
  type        = bool
  default     = true
}