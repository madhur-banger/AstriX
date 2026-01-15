# =============================================================================
# DEV ENVIRONMENT - MAIN CONFIGURATION
# =============================================================================
# This file orchestrates all infrastructure modules for the dev environment.
#
# Module Dependencies:
# ┌─────────────────────────────────────────────────────────────────────────┐
# │                                                                         │
# │   networking ◄──────────────────────────────────────────────────────┐  │
# │       │                                                             │  │
# │       │ vpc_id, subnet_ids                                          │  │
# │       ▼                                                             │  │
# │   security ◄────────────────────────────────────────────────────┐   │  │
# │       │                                                         │   │  │
# │       │ security_group_ids                                      │   │  │
# │       ▼                                                         │   │  │
# │   iam ─────────────────────────────────────────────────────────►│   │  │
# │       │                                                         │   │  │
# │       │ role_arns                                               │   │  │
# │       ▼                                                         │   │  │
# │   ecr ─────────────────────────────────────────────────────────►│   │  │
# │                                                                  │   │  │
# │   (Phase 3: ECS will use outputs from networking, security, iam, ecr) │
# │                                                                         │
# └─────────────────────────────────────────────────────────────────────────┘
# =============================================================================

# -----------------------------------------------------------------------------
# TERRAFORM CONFIGURATION
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# -----------------------------------------------------------------------------
# AWS PROVIDER
# -----------------------------------------------------------------------------

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Owner       = var.owner
    }
  }
}

# -----------------------------------------------------------------------------
# DATA SOURCES
# -----------------------------------------------------------------------------

# Get current AWS account ID
data "aws_caller_identity" "current" {}

# Get current AWS region
data "aws_region" "current" {}



# -----------------------------------------------------------------------------
# LOCAL VALUES
# -----------------------------------------------------------------------------
locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
    Owner       = var.owner
  }
  # Protocol based on HTTPS enablement
  protocol = var.enable_https ? "https" : "http"
  
  # URLs automatically computed
  alb_base_url = var.enable_https ? "https://${module.alb.alb_dns_name}" : "http://${module.alb.alb_dns_name}"
  api_base_url = "${local.alb_base_url}/api"
  frontend_url = "https://${module.cloudfront_s3.distribution_domain_name}"
  
  # Callbacks
  google_callback_url           = "${local.api_base_url}/auth/google/callback"
  frontend_google_callback_url  = "${local.frontend_url}/google/callback"
  
  # Cookie domain (ALB domain for proper cookie handling)
  cookie_domain = module.alb.alb_dns_name
}



# -----------------------------------------------------------------------------
# NETWORKING MODULE
# -----------------------------------------------------------------------------
# Creates: VPC, Subnets, Internet Gateway, NAT Gateway, Route Tables

module "networking" {
  source = "../../modules/networking"

  project_name = var.project_name
  environment  = var.environment

  # VPC Configuration
  vpc_cidr             = var.vpc_cidr
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs

  # Cost optimization: Single NAT for dev
  enable_nat_gateway = var.enable_nat_gateway

  # Disable flow logs for dev (save costs)
  enable_flow_logs         = var.enable_flow_logs
  flow_logs_retention_days = var.flow_logs_retention_days

  common_tags = local.common_tags
}

# -----------------------------------------------------------------------------
# SECURITY MODULE
# -----------------------------------------------------------------------------
# Creates: Security Groups (ALB, ECS, Lambda, Database)

module "security" {
  source = "../../modules/security"

  project_name = var.project_name
  environment  = var.environment

  # VPC Configuration (from networking module)
  vpc_id   = module.networking.vpc_id
  vpc_cidr = module.networking.vpc_cidr

  # Application Configuration
  app_port      = var.app_port
  database_port = var.database_port

  # Optional Security Groups
  create_lambda_sg        = var.create_lambda_sg
  create_database_sg      = var.create_database_sg
  create_vpc_endpoints_sg = var.create_vpc_endpoints_sg

  common_tags = local.common_tags
}

# -----------------------------------------------------------------------------
# IAM MODULE
# -----------------------------------------------------------------------------
# Creates: ECS Roles, Lambda Role, GitHub Actions Role (OIDC)

module "iam" {
  source = "../../modules/iam"

  project_name   = var.project_name
  environment    = var.environment
  aws_region     = var.aws_region
  aws_account_id = data.aws_caller_identity.current.account_id

  # KMS key for secrets (optional)
  kms_key_arn = var.kms_key_arn

  # Lambda VPC access
  lambda_vpc_access = var.lambda_vpc_access

  # GitHub Actions OIDC (for CI/CD)
  create_github_oidc = var.create_github_oidc
  github_org         = var.github_org
  github_repo        = var.github_repo

  common_tags = local.common_tags
}

# -----------------------------------------------------------------------------
# ECR MODULE
# -----------------------------------------------------------------------------
# Creates: Container registries for Docker images

module "ecr" {
  source = "../../modules/ecr"

  project_name = var.project_name
  environment  = var.environment

  # Repository Configuration
  create_lambda_repository = var.create_lambda_ecr

  # Lifecycle Policy
  image_retention_count         = var.image_retention_count
  dev_image_retention_count     = var.dev_image_retention_count
  untagged_image_retention_days = var.untagged_image_retention_days

  # Cross-account access (empty for single account)
  cross_account_ids = var.cross_account_ids

  common_tags = local.common_tags
}

module "alb" {
  source = "../../modules/alb"

  project_name           = var.project_name
  environment            = var.environment
  vpc_id                 = module.networking.vpc_id
  public_subnet_ids      = module.networking.public_subnet_ids
  alb_security_group_id  = module.security.alb_security_group_id
  backend_port           = var.app_port
  health_check_path      = var.health_check_path
  enable_stickiness      = var.enable_stickiness
  certificate_arn        = null  # Certificate added after ACM
  enable_access_logs     = var.enable_access_logs
  access_logs_bucket     = var.access_logs_bucket

  common_tags = local.common_tags
}


module "acm" {
  source = "../../modules/acm"

  project_name = var.project_name
  environment  = var.environment
  alb_dns_name = module.alb.alb_dns_name
  organization_name = "AstriX"
  country_code = "US"
  save_certificate_locally = true
  certificate_output_path = "${path.root}/../../certificates"

  # FIXED: Use correct variable names
  enable_custom_domain = var.enable_alb_custom_domain
  custom_domain_name   = var.alb_custom_domain_name
  include_wildcard     = var.include_wildcard_cert
  certificate_arn      = var.alb_certificate_arn
  enable_expiration_alerts = false

  depends_on = [module.alb]
}

resource "aws_lb_listener" "https" {
  count = var.enable_https ? 1 : 0

  load_balancer_arn = module.alb.alb_arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = module.acm.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = module.alb.target_group_arn
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-https-listener"
  })

  depends_on = [module.acm]
}


# -----------------------------------------------------------------------------
# PARAMETER STORE MODULE (Phase 3)
# -----------------------------------------------------------------------------
module "parameter_store" {
  source = "../../modules/parameter-store"

  project_name = var.project_name
  environment  = var.environment
  create_kms_key = var.create_parameter_store_kms_key
  kms_key_arn    = var.kms_key_arn

  mongo_uri = var.mongo_uri
  jwt_access_token_secret      = var.jwt_access_token_secret
  jwt_access_token_expires_in  = var.jwt_access_token_expires_in
  jwt_refresh_token_secret     = var.jwt_refresh_token_secret
  jwt_refresh_token_expires_in = var.jwt_refresh_token_expires_in
  google_client_id       = var.google_client_id
  google_client_secret   = var.google_client_secret
  
  # AUTOMATED URLS
  google_callback_url          = local.google_callback_url
  frontend_origin              = local.frontend_url
  frontend_google_callback_url = local.frontend_google_callback_url
  vite_api_base_url            = local.api_base_url
  cookie_domain                = local.cookie_domain

  node_env = var.node_env
  port     = tostring(var.app_port)

  common_tags = local.common_tags
  depends_on = [module.acm, aws_lb_listener.https]
}

# -----------------------------------------------------------------------------
# ECS MODULE (UNCHANGED)
# -----------------------------------------------------------------------------

module "ecs" {
  source                      = "../../modules/ecs"
  project_name                = var.project_name
  environment                 = var.environment
  aws_region                  = var.aws_region
  aws_account_id              = data.aws_caller_identity.current.account_id
  private_subnet_ids          = module.networking.private_subnet_ids
  ecs_security_group_id       = module.security.ecs_tasks_security_group_id
  target_group_arn            = module.alb.target_group_arn
  ecs_task_execution_role_arn = module.iam.ecs_task_execution_role_arn
  ecs_task_role_arn           = module.iam.ecs_task_role_arn
  ecr_repository_url          = module.ecr.backend_repository_url
  image_tag                   = var.ecs_image_tag
  container_port              = var.app_port
  node_env                    = var.node_env
  health_check_path           = var.health_check_path
  task_cpu                    = var.ecs_task_cpu
  task_memory                 = var.ecs_task_memory
  desired_count               = var.ecs_desired_count
  deployment_minimum_healthy_percent = var.ecs_deployment_minimum_healthy_percent
  deployment_maximum_percent  = var.ecs_deployment_maximum_percent
  health_check_grace_period   = var.ecs_health_check_grace_period
  enable_ecs_exec             = var.enable_ecs_exec
  min_capacity                = var.ecs_min_capacity
  max_capacity                = var.ecs_max_capacity
  cpu_target_value            = var.ecs_cpu_target_value
  memory_target_value         = var.ecs_memory_target_value
  scale_in_cooldown           = var.ecs_scale_in_cooldown
  scale_out_cooldown          = var.ecs_scale_out_cooldown
  fargate_weight              = var.ecs_fargate_weight
  fargate_base                = var.ecs_fargate_base
  fargate_spot_weight         = var.ecs_fargate_spot_weight
  log_retention_days          = var.ecs_log_retention_days
  enable_container_insights   = var.enable_container_insights
  enable_alarms               = var.enable_ecs_alarms
  
  common_tags = local.common_tags
  depends_on  = [module.alb, module.parameter_store]
}




# -----------------------------------------------------------------------------
# CLOUDFRONT + S3 MODULE (NEW - Phase 4)
# -----------------------------------------------------------------------------

module "cloudfront_s3" {
  source = "../../modules/cloudfront_s3"

  project_name = var.project_name
  environment  = var.environment
  bucket_name       = var.frontend_bucket_name
  force_destroy     = var.frontend_force_destroy
  enable_versioning = var.frontend_enable_versioning
  kms_key_arn       = var.frontend_kms_key_arn
  enable_lifecycle_rules             = var.frontend_enable_lifecycle_rules
  noncurrent_version_expiration_days = var.frontend_noncurrent_version_expiration_days
  cors_allowed_origins = var.frontend_cors_allowed_origins
  price_class       = var.cloudfront_price_class
  enable_spa_routing = var.cloudfront_enable_spa_routing
  domain_name         = var.frontend_domain_name
  acm_certificate_arn = var.frontend_acm_certificate_arn
  route53_zone_id     = var.frontend_route53_zone_id
  alb_dns_name        = module.alb.alb_dns_name
  alb_protocol_policy = var.enable_https ? "https-only" : var.cloudfront_alb_protocol_policy
  web_acl_id              = var.cloudfront_web_acl_id
  content_security_policy = var.cloudfront_content_security_policy
  geo_restriction_type    = var.cloudfront_geo_restriction_type
  geo_restriction_locations = var.cloudfront_geo_restriction_locations
  enable_logging      = var.cloudfront_enable_logging
  log_bucket          = var.cloudfront_log_bucket
  log_prefix          = var.cloudfront_log_prefix
  log_include_cookies = var.cloudfront_log_include_cookies

  common_tags = local.common_tags
  depends_on = [module.alb, module.acm]
}