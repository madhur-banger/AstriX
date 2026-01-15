# =============================================================================
# ECS MODULE - OUTPUTS
# =============================================================================

# -----------------------------------------------------------------------------
# CLUSTER OUTPUTS
# -----------------------------------------------------------------------------

output "cluster_id" {
  description = "ID of the ECS cluster"
  value       = aws_ecs_cluster.main.id
}

output "cluster_arn" {
  description = "ARN of the ECS cluster"
  value       = aws_ecs_cluster.main.arn
}

output "cluster_name" {
  description = "Name of the ECS cluster"
  value       = aws_ecs_cluster.main.name
}

# -----------------------------------------------------------------------------
# SERVICE OUTPUTS
# -----------------------------------------------------------------------------

output "service_id" {
  description = "ID of the ECS service"
  value       = aws_ecs_service.backend.id
}

output "service_name" {
  description = "Name of the ECS service"
  value       = aws_ecs_service.backend.name
}

output "service_arn" {
  description = "ARN of the ECS service"
  value       = aws_ecs_service.backend.id
}

# -----------------------------------------------------------------------------
# TASK DEFINITION OUTPUTS
# -----------------------------------------------------------------------------

output "task_definition_arn" {
  description = "ARN of the task definition"
  value       = aws_ecs_task_definition.backend.arn
}

output "task_definition_family" {
  description = "Family of the task definition"
  value       = aws_ecs_task_definition.backend.family
}

output "task_definition_revision" {
  description = "Revision of the task definition"
  value       = aws_ecs_task_definition.backend.revision
}

# -----------------------------------------------------------------------------
# CLOUDWATCH OUTPUTS
# -----------------------------------------------------------------------------

output "log_group_name" {
  description = "Name of the CloudWatch log group"
  value       = aws_cloudwatch_log_group.ecs.name
}

output "log_group_arn" {
  description = "ARN of the CloudWatch log group"
  value       = aws_cloudwatch_log_group.ecs.arn
}


# -----------------------------------------------------------------------------
# AUTO SCALING OUTPUTS
# -----------------------------------------------------------------------------

output "autoscaling_target_id" {
  description = "ID of the auto-scaling target"
  value       = aws_appautoscaling_target.ecs.id
}

output "autoscaling_min_capacity" {
  description = "Minimum capacity for auto-scaling"
  value       = var.min_capacity
}

output "autoscaling_max_capacity" {
  description = "Maximum capacity for auto-scaling"
  value       = var.max_capacity
}

# -----------------------------------------------------------------------------
# SUMMARY OUTPUT
# -----------------------------------------------------------------------------

output "ecs_summary" {
  description = "Summary of ECS configuration"
  value = {
    cluster_name    = aws_ecs_cluster.main.name
    service_name    = aws_ecs_service.backend.name
    task_definition = aws_ecs_task_definition.backend.family
    task_cpu        = var.task_cpu
    task_memory     = var.task_memory
    desired_count   = var.desired_count
    min_capacity    = var.min_capacity
    max_capacity    = var.max_capacity
    image           = "${var.ecr_repository_url}:${var.image_tag}"
  }
}

# -----------------------------------------------------------------------------
# USEFUL COMMANDS OUTPUT
# -----------------------------------------------------------------------------

output "useful_commands" {
  description = "Useful AWS CLI commands for ECS management"
  value = {
    view_service = "aws ecs describe-services --cluster ${aws_ecs_cluster.main.name} --services ${aws_ecs_service.backend.name}"
    view_tasks   = "aws ecs list-tasks --cluster ${aws_ecs_cluster.main.name} --service-name ${aws_ecs_service.backend.name}"
    view_logs    = "aws logs tail ${aws_cloudwatch_log_group.ecs.name} --follow"
    scale_service = "aws ecs update-service --cluster ${aws_ecs_cluster.main.name} --service ${aws_ecs_service.backend.name} --desired-count 3"
    force_deploy  = "aws ecs update-service --cluster ${aws_ecs_cluster.main.name} --service ${aws_ecs_service.backend.name} --force-new-deployment"
  }
}
