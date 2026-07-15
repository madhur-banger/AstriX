# =============================================================================
# IAM MODULE - OUTPUTS
# =============================================================================

# -----------------------------------------------------------------------------
# ECS TASK EXECUTION ROLE
# -----------------------------------------------------------------------------

output "ecs_task_execution_role_arn" {
  description = "ARN of the ECS task execution role"
  value       = aws_iam_role.ecs_task_execution.arn
}

output "ecs_task_execution_role_name" {
  description = "Name of the ECS task execution role"
  value       = aws_iam_role.ecs_task_execution.name
}

output "ecs_task_execution_role_id" {
  description = "ID of the ECS task execution role"
  value       = aws_iam_role.ecs_task_execution.id
}

# -----------------------------------------------------------------------------
# ECS TASK ROLE
# -----------------------------------------------------------------------------

output "ecs_task_role_arn" {
  description = "ARN of the ECS task role (application permissions)"
  value       = aws_iam_role.ecs_task.arn
}

output "ecs_task_role_name" {
  description = "Name of the ECS task role"
  value       = aws_iam_role.ecs_task.name
}

output "ecs_task_role_id" {
  description = "ID of the ECS task role"
  value       = aws_iam_role.ecs_task.id
}


# -----------------------------------------------------------------------------
# LAMBDA EXECUTION ROLE
# -----------------------------------------------------------------------------

output "lambda_execution_role_arn" {
  description = "ARN of the Lambda execution role"
  value       = aws_iam_role.lambda_execution.arn
}

output "lambda_execution_role_name" {
  description = "Name of the Lambda execution role"
  value       = aws_iam_role.lambda_execution.name
}

output "lambda_execution_role_id" {
  description = "ID of the Lambda execution role"
  value       = aws_iam_role.lambda_execution.id
}



# -----------------------------------------------------------------------------
# GITHUB ACTIONS ROLE
# -----------------------------------------------------------------------------

output "github_actions_role_arn" {
  description = "ARN of the GitHub Actions role (null if not created)"
  value       = var.create_github_oidc ? aws_iam_role.github_actions[0].arn : null
}

output "github_actions_role_name" {
  description = "Name of the GitHub Actions role (null if not created)"
  value       = var.create_github_oidc ? aws_iam_role.github_actions[0].name : null
}

output "github_oidc_provider_arn" {
  description = "ARN of the GitHub OIDC provider (null if not created)"
  value       = var.create_github_oidc ? aws_iam_openid_connect_provider.github[0].arn : null
}


# -----------------------------------------------------------------------------
# SUMMARY OUTPUT
# -----------------------------------------------------------------------------

output "roles_summary" {
  description = "Summary of all IAM roles for reference"
  value = {
    ecs_task_execution_role = {
      arn  = aws_iam_role.ecs_task_execution.arn
      name = aws_iam_role.ecs_task_execution.name
      use  = "ECS agent - pull images, write logs, get secrets"
    }
    ecs_task_role = {
      arn  = aws_iam_role.ecs_task.arn
      name = aws_iam_role.ecs_task.name
      use  = "Application code - access SNS, SQS, S3, DynamoDB"
    }
    lambda_execution_role = {
      arn  = aws_iam_role.lambda_execution.arn
      name = aws_iam_role.lambda_execution.name
      use  = "Lambda functions - process events, access AWS services"
    }
    github_actions_role = var.create_github_oidc ? {
      arn  = aws_iam_role.github_actions[0].arn
      name = aws_iam_role.github_actions[0].name
      use  = "CI/CD - deploy ECS, Lambda, S3"
    } : null
  }
}