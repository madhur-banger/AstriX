# =============================================================================
# ECR MODULE
# =============================================================================
# This module creates ECR repositories for Docker images:
# - Backend API image
# - Lambda function images (if using container Lambdas)
#
# Features:
# - Image scanning on push
# - Lifecycle policies to manage costs
# - Immutable tags (optional, for production)
# =============================================================================

# -----------------------------------------------------------------------------
# BACKEND ECR REPOSITORY
# -----------------------------------------------------------------------------
# Stores Docker images for the Express.js backend


resource "aws_ecr_repository" "backend" {
  name = "${var.project_name}-${var.environment}-backend"

  # Enable image scanning for security vulnerabilities
  image_scanning_configuration {
    scan_on_push = true
  }

  # MUTABLE allows overwriting tags (easier for dev)
  # IMMUTABLE prevents tag overwrites (safer for prod)
  image_tag_mutability = var.environment == "prod" ? "IMMUTABLE" : "MUTABLE"

  # Encryption at rest using AWS managed key (free)
  encryption_configuration {
    encryption_type = "AES256"
  }

  # Allow deletion even if repository contains images
  # Safe for dev, should be false in prod
  force_delete = var.force_delete

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-backend"
  })
}

# Lifecycle policy to clean up old images and reduce costs
resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last ${var.image_retention_count} tagged images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v", "release"]
          countType     = "imageCountMoreThan"
          countNumber   = var.image_retention_count
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Delete untagged images older than ${var.untagged_image_retention_days} days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.untagged_image_retention_days
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 3
        description  = "Keep only ${var.dev_image_retention_count} dev/feature images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["dev", "feature", "pr"]
          countType     = "imageCountMoreThan"
          countNumber   = var.dev_image_retention_count
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}




# -----------------------------------------------------------------------------
# LAMBDA ECR REPOSITORY (Optional)
# -----------------------------------------------------------------------------
# For Lambda functions packaged as container images
# Container Lambdas are useful when:
# - Your function exceeds 50MB ZIP limit
# - You need custom runtimes
# - You want consistent local/cloud environment

resource "aws_ecr_repository" "lambda" {
  count = var.create_lambda_repository ? 1 : 0

  name = "${var.project_name}-${var.environment}-lambda"

  image_scanning_configuration {
    scan_on_push = true
  }

  image_tag_mutability = var.environment == "prod" ? "IMMUTABLE" : "MUTABLE"

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-lambda"
  })
}

resource "aws_ecr_lifecycle_policy" "lambda" {
  count = var.create_lambda_repository ? 1 : 0

  repository = aws_ecr_repository.lambda[0].name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last ${var.image_retention_count} Lambda images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.image_retention_count
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}



# -----------------------------------------------------------------------------
# REPOSITORY POLICY (Optional - for cross-account access)
# -----------------------------------------------------------------------------
# Only create if you need other AWS accounts to pull images

resource "aws_ecr_repository_policy" "backend_cross_account" {
  count = length(var.cross_account_ids) > 0 ? 1 : 0

  repository = aws_ecr_repository.backend.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CrossAccountPull"
        Effect = "Allow"
        Principal = {
          AWS = [for id in var.cross_account_ids : "arn:aws:iam::${id}:root"]
        }
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability"
        ]
      }
    ]
  })
}
