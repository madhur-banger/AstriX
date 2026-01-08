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
        source = "hashicorp/aws"
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
      Project = var.project_name
      Environment = var.environment
      ManagedBy = "terraform"
      Owner = var.owner
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

