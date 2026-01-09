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
  required_version = ">=1.0.0"

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
