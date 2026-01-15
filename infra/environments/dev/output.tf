# =============================================================================
# DEV ENVIRONMENT - OUTPUTS
# =============================================================================
# These outputs provide important information about the deployed infrastructure.
# Use these values to configure other tools (ECS, CI/CD, etc.)
# =============================================================================

# -----------------------------------------------------------------------------
# NETWORKING OUTPUTS
# -----------------------------------------------------------------------------

output "vpc_id" {
  description = "ID of the VPC"
  value       = module.networking.vpc_id
}

output "vpc_cidr" {
  description = "CIDR block of the VPC"
  value       = module.networking.vpc_cidr
}

output "public_subnet_ids" {
  description = "IDs of public subnets (for ALB)"
  value       = module.networking.public_subnet_ids
}

output "private_subnet_ids" {
  description = "IDs of private subnets (for ECS tasks)"
  value       = module.networking.private_subnet_ids
}

output "nat_gateway_public_ip" {
  description = "Public IP of NAT Gateway"
  value       = module.networking.nat_gateway_public_ip
}

# -----------------------------------------------------------------------------
# SECURITY OUTPUTS
# -----------------------------------------------------------------------------

output "alb_security_group_id" {
  description = "Security group ID for ALB"
  value       = module.security.alb_security_group_id
}

output "ecs_tasks_security_group_id" {
  description = "Security group ID for ECS tasks"
  value       = module.security.ecs_tasks_security_group_id
}

output "lambda_security_group_id" {
  description = "Security group ID for Lambda functions"
  value       = module.security.lambda_security_group_id
}

# -----------------------------------------------------------------------------
# IAM OUTPUTS
# -----------------------------------------------------------------------------

output "ecs_task_execution_role_arn" {
  description = "ARN of ECS task execution role"
  value       = module.iam.ecs_task_execution_role_arn
}

output "ecs_task_role_arn" {
  description = "ARN of ECS task role (app permissions)"
  value       = module.iam.ecs_task_role_arn
}

output "lambda_execution_role_arn" {
  description = "ARN of Lambda execution role"
  value       = module.iam.lambda_execution_role_arn
}

output "github_actions_role_arn" {
  description = "ARN of GitHub Actions role (for CI/CD)"
  value       = module.iam.github_actions_role_arn
}

# -----------------------------------------------------------------------------
# ECR OUTPUTS
# -----------------------------------------------------------------------------

output "backend_ecr_repository_url" {
  description = "ECR repository URL for backend images"
  value       = module.ecr.backend_repository_url
}

output "docker_login_command" {
  description = "Command to authenticate Docker with ECR"
  value       = module.ecr.docker_login_command
  sensitive   = false
}

# -----------------------------------------------------------------------------
# PARAMETER STORE OUTPUTS (Phase 3)
# -----------------------------------------------------------------------------

output "parameter_names" {
  description = "List of parameter store parameter names"
  value       = module.parameter_store.parameter_names
}

# -----------------------------------------------------------------------------
# ALB OUTPUTS (Phase 3)
# -----------------------------------------------------------------------------

output "alb_dns_name" {
  description = "DNS name of the ALB - Use this to access your backend"
  value       = module.alb.alb_dns_name
}

output "alb_zone_id" {
  description = "Zone ID of ALB"
  value       = module.alb.alb_zone_id
}

output "backend_api_url" {
  description = "Full backend API URL"
  value       = module.alb.backend_url
}

output "target_group_arn" {
  description = "ARN of target group"
  value       = module.alb.target_group_arn
}


# -----------------------------------------------------------------------------
# ECS OUTPUTS (NEW - Phase 3)
# -----------------------------------------------------------------------------

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = module.ecs.cluster_name
}

output "ecs_cluster_arn" {
  description = "ARN of the ECS cluster"
  value       = module.ecs.cluster_arn
}

output "ecs_service_name" {
  description = "Name of the ECS service"
  value       = module.ecs.service_name
}

output "ecs_service_arn" {
  description = "ARN of the ECS service"
  value       = module.ecs.service_arn
}

output "ecs_task_definition_arn" {
  description = "ARN of the ECS task definition"
  value       = module.ecs.task_definition_arn
}

output "ecs_log_group_name" {
  description = "Name of the CloudWatch log group for ECS"
  value       = module.ecs.log_group_name
}

output "ecs_summary" {
  description = "Summary of ECS configuration"
  value       = module.ecs.ecs_summary
}


# =============================================================================
# CLOUDFRONT + S3 OUTPUTS (NEW - Phase 4)
# =============================================================================

# -----------------------------------------------------------------------------
# S3 BUCKET OUTPUTS
# -----------------------------------------------------------------------------

output "frontend_bucket_id" {
  description = "S3 bucket ID for frontend"
  value       = module.cloudfront_s3.bucket_id
}

output "frontend_bucket_arn" {
  description = "S3 bucket ARN for frontend"
  value       = module.cloudfront_s3.bucket_arn
}

output "frontend_bucket_domain_name" {
  description = "S3 bucket domain name"
  value       = module.cloudfront_s3.bucket_domain_name
}


# -----------------------------------------------------------------------------
# CLOUDFRONT OUTPUTS
# -----------------------------------------------------------------------------

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = module.cloudfront_s3.distribution_id
}

output "cloudfront_distribution_arn" {
  description = "CloudFront distribution ARN"
  value       = module.cloudfront_s3.distribution_arn
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name"
  value       = module.cloudfront_s3.distribution_domain_name
}

output "cloudfront_hosted_zone_id" {
  description = "CloudFront distribution hosted zone ID"
  value       = module.cloudfront_s3.distribution_hosted_zone_id
}


# -----------------------------------------------------------------------------
# URL OUTPUTS
# -----------------------------------------------------------------------------

output "frontend_url" {
  description = "Frontend URL (CloudFront)"
  value       = module.cloudfront_s3.frontend_url
}

output "api_url_via_cloudfront" {
  description = "API URL through CloudFront"
  value       = module.cloudfront_s3.api_url
}

# -----------------------------------------------------------------------------
# DEPLOYMENT COMMANDS
# -----------------------------------------------------------------------------

output "frontend_deployment_commands" {
  description = "Commands to deploy frontend"
  value       = module.cloudfront_s3.deployment_commands
}

output "frontend_sync_command" {
  description = "Command to sync frontend build to S3"
  value       = module.cloudfront_s3.s3_sync_command
}

output "cloudfront_invalidation_command" {
  description = "Command to invalidate CloudFront cache"
  value       = module.cloudfront_s3.invalidation_command
}

# -----------------------------------------------------------------------------
# FRONTEND SUMMARY
# -----------------------------------------------------------------------------

output "frontend_summary" {
  description = "Summary of frontend infrastructure"
  value       = module.cloudfront_s3.frontend_summary
}


# -----------------------------------------------------------------------------
# COMPLETE INFRASTRUCTURE SUMMARY (UPDATED)
# -----------------------------------------------------------------------------

output "complete_infrastructure_summary" {
  description = "Complete summary of all deployed infrastructure"
  value = {
    environment = var.environment
    region      = var.aws_region

    networking = {
      vpc_id          = module.networking.vpc_id
      public_subnets  = module.networking.public_subnet_ids
      private_subnets = module.networking.private_subnet_ids
      nat_gateway_ip  = module.networking.nat_gateway_public_ip
    }

    security_groups = {
      alb       = module.security.alb_security_group_id
      ecs_tasks = module.security.ecs_tasks_security_group_id
      lambda    = module.security.lambda_security_group_id
    }

    iam_roles = {
      ecs_execution = module.iam.ecs_task_execution_role_arn
      ecs_task      = module.iam.ecs_task_role_arn
      lambda        = module.iam.lambda_execution_role_arn
    }

    ecr = {
      backend_repo = module.ecr.backend_repository_url
    }

    alb = {
      dns_name     = module.alb.alb_dns_name
      endpoint     = module.alb.backend_url
      target_group = module.alb.target_group_arn
    }

    ecs = {
      cluster_name    = module.ecs.cluster_name
      service_name    = module.ecs.service_name
      task_definition = module.ecs.task_definition_family
      desired_count   = var.ecs_desired_count
      min_capacity    = var.ecs_min_capacity
      max_capacity    = var.ecs_max_capacity
    }

    # NEW - Phase 4
    frontend = {
      s3_bucket           = module.cloudfront_s3.bucket_id
      cloudfront_id       = module.cloudfront_s3.distribution_id
      cloudfront_domain   = module.cloudfront_s3.distribution_domain_name
      custom_domain       = var.frontend_domain_name
      frontend_url        = module.cloudfront_s3.frontend_url
      api_url             = module.cloudfront_s3.api_url
      spa_routing_enabled = var.cloudfront_enable_spa_routing
    }

    urls = {
      frontend     = module.cloudfront_s3.frontend_url
      api          = module.cloudfront_s3.api_url
      backend_alb  = "http://${module.alb.alb_dns_name}/api"
      health_check = "http://${module.alb.alb_dns_name}${var.health_check_path}"
    }
  }
}

# -----------------------------------------------------------------------------
# DEPLOYMENT STATUS (UPDATED)
# -----------------------------------------------------------------------------

output "deployment_status" {
  description = "Current deployment status and health"
  value = {
    backend_deployed  = true
    frontend_deployed = true

    backend_url  = "http://${module.alb.alb_dns_name}/api"
    frontend_url = module.cloudfront_s3.frontend_url
    api_url      = module.cloudfront_s3.api_url

    health_check_url = "http://${module.alb.alb_dns_name}${var.health_check_path}"

    next_steps = [
      "1. Deploy frontend: ${module.cloudfront_s3.s3_sync_command}",
      "2. Invalidate cache: ${module.cloudfront_s3.invalidation_command}",
      "3. Test frontend: curl ${module.cloudfront_s3.frontend_url}",
      "4. Test API through CloudFront: curl ${module.cloudfront_s3.api_url}",
      "5. Update Google OAuth callback URL to: ${module.cloudfront_s3.api_url}/auth/google/callback",
      "6. Update Google OAuth redirect URI to: ${module.cloudfront_s3.frontend_url}/google/callback"
    ]
  }
}

# -----------------------------------------------------------------------------
# USEFUL COMMANDS (UPDATED)
# -----------------------------------------------------------------------------

output "useful_commands" {
  description = "Useful AWS CLI commands"
  value = {
    # ECS Commands
    view_ecs_service = "aws ecs describe-services --cluster ${module.ecs.cluster_name} --services ${module.ecs.service_name} --profile prod-terraform"
    list_ecs_tasks   = "aws ecs list-tasks --cluster ${module.ecs.cluster_name} --service-name ${module.ecs.service_name} --profile prod-terraform"
    view_task_logs   = "aws logs tail ${module.ecs.log_group_name} --follow --profile prod-terraform"

    # Deployment Commands
    force_new_deployment = "aws ecs update-service --cluster ${module.ecs.cluster_name} --service ${module.ecs.service_name} --force-new-deployment --profile prod-terraform"
    scale_service        = "aws ecs update-service --cluster ${module.ecs.cluster_name} --service ${module.ecs.service_name} --desired-count 3 --profile prod-terraform"

    # Monitoring Commands
    check_health     = "curl -I http://${module.alb.alb_dns_name}${var.health_check_path}"
    check_api        = "curl http://${module.alb.alb_dns_name}/api"
    view_alb_targets = "aws elbv2 describe-target-health --target-group-arn ${module.alb.target_group_arn} --profile prod-terraform"

    # Docker Commands  
    docker_login = module.ecr.docker_login_command
    docker_push  = "./infra/scripts/push-backend-image.sh"

    # Frontend Commands (NEW - Phase 4)
    frontend_deploy    = "cd frontend && npm run build && ${module.cloudfront_s3.s3_sync_command}"
    frontend_sync      = module.cloudfront_s3.s3_sync_command
    frontend_invalidate = module.cloudfront_s3.invalidation_command
    frontend_full_deploy = "cd frontend && npm run build && ${module.cloudfront_s3.s3_sync_command} && ${module.cloudfront_s3.invalidation_command}"

    # CloudFront Commands
    cloudfront_status = "aws cloudfront get-distribution --id ${module.cloudfront_s3.distribution_id} --query 'Distribution.Status' --profile prod-terraform"
    cloudfront_list_invalidations = "aws cloudfront list-invalidations --distribution-id ${module.cloudfront_s3.distribution_id} --profile prod-terraform"

    # S3 Commands
    s3_list_objects = "aws s3 ls s3://${module.cloudfront_s3.bucket_id} --recursive --profile prod-terraform"
    s3_bucket_size  = "aws s3 ls s3://${module.cloudfront_s3.bucket_id} --recursive --summarize --profile prod-terraform | tail -2"
  }
}

# -----------------------------------------------------------------------------
# GOOGLE OAUTH UPDATE REMINDER
# -----------------------------------------------------------------------------

output "google_oauth_update" {
  description = "URLs to update in Google Cloud Console"
  value = {
    message = "Update these URLs in Google Cloud Console > APIs & Services > Credentials"
    authorized_javascript_origins = [
      module.cloudfront_s3.frontend_url
    ]
    authorized_redirect_uris = [
      "${module.cloudfront_s3.api_url}/auth/google/callback"
    ]
  }
}
