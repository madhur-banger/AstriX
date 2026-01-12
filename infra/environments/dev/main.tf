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

# -----------------------------------------------------------------------------
# PARAMETER STORE MODULE (Phase 3)
# -----------------------------------------------------------------------------
module "parameter_store" {
  source = "../../modules/parameter-store"

  project_name = var.project_name
  environment  = var.environment

  # KMS encryption (optional - uses AWS managed key if not provided)
  create_kms_key = var.create_parameter_store_kms_key
  kms_key_arn    = var.kms_key_arn

  # MongoDB
  mongo_uri = var.mongo_uri

  # JWT
  jwt_access_token_secret      = var.jwt_access_token_secret
  jwt_access_token_expires_in  = var.jwt_access_token_expires_in
  jwt_refresh_token_secret     = var.jwt_refresh_token_secret
  jwt_refresh_token_expires_in = var.jwt_refresh_token_expires_in

  # Google OAuth
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
  google_callback_url  = var.google_callback_url

  # Frontend URLs
  frontend_origin              = var.frontend_origin
  frontend_google_callback_url = var.frontend_google_callback_url
  vite_api_base_url            = var.vite_api_base_url

  # Cookie config
  cookie_domain = var.cookie_domain

  # Application
  node_env = var.node_env
  port     = tostring(var.app_port)

  common_tags = local.common_tags
}



module "alb" {
  source = "../../modules/alb"

  project_name          = var.project_name
  environment           = var.environment
  vpc_id                = module.networking.vpc_id
  public_subnet_ids     = module.networking.public_subnet_ids
  alb_security_group_id = module.security.alb_security_group_id
  backend_port          = var.app_port
  health_check_path     = var.health_check_path
  enable_stickiness     = var.enable_stickiness
  certificate_arn       = var.certificate_arn
  enable_access_logs    = var.enable_access_logs
  access_logs_bucket    = var.access_logs_bucket

  common_tags = local.common_tags
}