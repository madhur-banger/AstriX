# =============================================================================
# ECR MODULE - OUTPUTS
# =============================================================================

# -----------------------------------------------------------------------------
# BACKEND REPOSITORY
# -----------------------------------------------------------------------------

output "backend_repository_url" {
  description = <<-EOT
    URL of the backend ECR repository.
    Use this to push/pull Docker images.
    
    Example usage:
    docker build -t <url>:latest .
    docker push <url>:latest
  EOT
  value       = aws_ecr_repository.backend.repository_url
}

output "backend_repository_arn" {
  description = "ARN of the backend ECR repository"
  value       = aws_ecr_repository.backend.arn
}

output "backend_repository_name" {
  description = "Name of the backend ECR repository"
  value       = aws_ecr_repository.backend.name
}

output "backend_registry_id" {
  description = "Registry ID (AWS account ID) for the backend repository"
  value       = aws_ecr_repository.backend.registry_id
}

# -----------------------------------------------------------------------------
# LAMBDA REPOSITORY (Optional)
# -----------------------------------------------------------------------------

output "lambda_repository_url" {
  description = "URL of the Lambda ECR repository (null if not created)"
  value       = var.create_lambda_repository ? aws_ecr_repository.lambda[0].repository_url : null
}

output "lambda_repository_arn" {
  description = "ARN of the Lambda ECR repository (null if not created)"
  value       = var.create_lambda_repository ? aws_ecr_repository.lambda[0].arn : null
}

output "lambda_repository_name" {
  description = "Name of the Lambda ECR repository (null if not created)"
  value       = var.create_lambda_repository ? aws_ecr_repository.lambda[0].name : null
}


# -----------------------------------------------------------------------------
# HELPER OUTPUTS
# -----------------------------------------------------------------------------

output "docker_login_command" {
  description = <<-EOT
    AWS CLI command to authenticate Docker with ECR.
    Run this before pushing images.
  EOT
  value       = "aws ecr get-login-password --region ${data.aws_region.current.name} | docker login --username AWS --password-stdin ${aws_ecr_repository.backend.registry_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com"
}

output "docker_build_push_example" {
  description = "Example commands to build and push an image"
  value       = <<-EOT
    # Build the image
    docker build -t ${aws_ecr_repository.backend.repository_url}:latest .
    
    # Push to ECR
    docker push ${aws_ecr_repository.backend.repository_url}:latest
  EOT
}

# -----------------------------------------------------------------------------
# DATA SOURCES
# -----------------------------------------------------------------------------

data "aws_region" "current" {}
