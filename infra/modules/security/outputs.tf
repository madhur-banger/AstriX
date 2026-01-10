# =============================================================================
# SECURITY MODULE - OUTPUTS
# =============================================================================
# These outputs are used by other modules (ECS, Lambda, RDS)
# to attach security groups to their resources
# =============================================================================

# -----------------------------------------------------------------------------
# ALB SECURITY GROUP
# -----------------------------------------------------------------------------


output "alb_security_group_id" {
  description = "ID of the ALB security group"
  value       = aws_security_group.alb.id
}

output "alb_security_group_arn" {
  description = "ARN of the ALB security group"
  value       = aws_security_group.alb.arn
}

output "alb_security_group_name" {
  description = "Name of the ALB security group"
  value       = aws_security_group.alb.name
}

# -----------------------------------------------------------------------------
# ECS TASKS SECURITY GROUP
# -----------------------------------------------------------------------------

output "ecs_tasks_security_group_id" {
  description = "ID of the ECS tasks security group"
  value       = aws_security_group.ecs_tasks.id
}

output "ecs_tasks_security_group_arn" {
  description = "ARN of the ECS tasks security group"
  value       = aws_security_group.ecs_tasks.arn
}

output "ecs_tasks_security_group_name" {
  description = "Name of the ECS tasks security group"
  value       = aws_security_group.ecs_tasks.name
}


# -----------------------------------------------------------------------------
# LAMBDA SECURITY GROUP (Optional)
# -----------------------------------------------------------------------------

output "lambda_security_group_id" {
  description = "ID of the Lambda security group (null if not created)"
  value       = var.create_lambda_sg ? aws_security_group.lambda[0].id : null
}

output "lambda_security_group_arn" {
  description = "ARN of the Lambda security group (null if not created)"
  value       = var.create_lambda_sg ? aws_security_group.lambda[0].arn : null
}

# -----------------------------------------------------------------------------
# DATABASE SECURITY GROUP (Optional)
# -----------------------------------------------------------------------------

output "database_security_group_id" {
  description = "ID of the database security group (null if not created)"
  value       = var.create_database_sg ? aws_security_group.database[0].id : null
}

output "database_security_group_arn" {
  description = "ARN of the database security group (null if not created)"
  value       = var.create_database_sg ? aws_security_group.database[0].arn : null
}

# -----------------------------------------------------------------------------
# VPC ENDPOINTS SECURITY GROUP (Optional)
# -----------------------------------------------------------------------------

output "vpc_endpoints_security_group_id" {
  description = "ID of the VPC endpoints security group (null if not created)"
  value       = var.create_vpc_endpoints_sg ? aws_security_group.vpc_endpoints[0].id : null
}


# -----------------------------------------------------------------------------
# SUMMARY OUTPUT
# -----------------------------------------------------------------------------

output "security_groups_summary" {
  description = "Summary of all security groups for debugging"
  value = {
    alb_sg_id           = aws_security_group.alb.id
    ecs_tasks_sg_id     = aws_security_group.ecs_tasks.id
    lambda_sg_id        = var.create_lambda_sg ? aws_security_group.lambda[0].id : null
    database_sg_id      = var.create_database_sg ? aws_security_group.database[0].id : null
    vpc_endpoints_sg_id = var.create_vpc_endpoints_sg ? aws_security_group.vpc_endpoints[0].id : null
  }
}
