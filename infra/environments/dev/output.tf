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
# SUMMARY OUTPUT
# -----------------------------------------------------------------------------

output "infrastructure_summary" {
  description = "Summary of all infrastructure for quick reference"
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
  }
}

# -----------------------------------------------------------------------------
# NEXT STEPS OUTPUT
# -----------------------------------------------------------------------------

output "next_steps" {
  description = "What to do after deploying this infrastructure"
  value       = <<-EOT
    
    ✅ Infrastructure deployed successfully!
    
    NEXT STEPS (Phase 3 - ECS Deployment):
    
    1. Build and push your Docker image:
       ${module.ecr.docker_login_command}
       docker build -t ${module.ecr.backend_repository_url}:latest ./apps/backend
       docker push ${module.ecr.backend_repository_url}:latest
    
    2. Create Parameter Store secrets:
       aws ssm put-parameter --name "/astrix/dev/MONGODB_URI" --value "your-mongodb-uri" --type SecureString
       aws ssm put-parameter --name "/astrix/dev/JWT_SECRET" --value "your-jwt-secret" --type SecureString
    
    3. Create ECS infrastructure (Phase 3):
       - ECS Cluster
       - Task Definition
       - ALB
       - ECS Service
    
    USEFUL COMMANDS:
    - View VPC: aws ec2 describe-vpcs --vpc-ids ${module.networking.vpc_id}
    - View subnets: aws ec2 describe-subnets --filters "Name=vpc-id,Values=${module.networking.vpc_id}"
    - Test NAT: aws ec2 describe-nat-gateways --filter "Name=vpc-id,Values=${module.networking.vpc_id}"
    
  EOT
}
