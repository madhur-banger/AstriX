
# =============================================================================
# ECS MODULE - VARIABLES
# =============================================================================

# -----------------------------------------------------------------------------
# REQUIRED VARIABLES
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "aws_account_id" {
  description = "AWS account ID"
  type        = string
}

variable "common_tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default     = {}
}


# -----------------------------------------------------------------------------
# NETWORKING VARIABLES
# -----------------------------------------------------------------------------


variable "private_subnet_ids" {
  description = "List of private subnet IDs for ECS tasks"
  type        = list(string)
}

variable "ecs_security_group_id" {
  description = "Security group ID for ECS tasks"
  type        = string
}

# -----------------------------------------------------------------------------
# ALB VARIABLES
# -----------------------------------------------------------------------------

variable "target_group_arn" {
  description = "ARN of ALB target group"
  type        = string
}

# -----------------------------------------------------------------------------
# IAM VARIABLES
# -----------------------------------------------------------------------------

variable "ecs_task_execution_role_arn" {
  description = "ARN of ECS task execution role"
  type        = string
}

variable "ecs_task_role_arn" {
  description = "ARN of ECS task role"
  type        = string
}

# -----------------------------------------------------------------------------
# ECR VARIABLES
# -----------------------------------------------------------------------------

variable "ecr_repository_url" {
  description = "ECR repository URL for backend image"
  type        = string
}

variable "image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

# -----------------------------------------------------------------------------
# CONTAINER CONFIGURATION
# -----------------------------------------------------------------------------

variable "container_port" {
  description = "Port the container listens on"
  type        = number
  default     = 8000
}

variable "node_env" {
  description = "Node environment (production/development)"
  type        = string
  default     = "production"
}

variable "health_check_path" {
  description = "Health check endpoint path"
  type        = string
  default     = "/health"
}

# -----------------------------------------------------------------------------
# TASK DEFINITION CONFIGURATION
# -----------------------------------------------------------------------------


variable "task_cpu" {
  description = "CPU units for the task (256, 512, 1024, 2048, 4096)"
  type        = number
  default     = 512 # 0.5 vCPU - cheapest option
}

variable "task_memory" {
  description = "Memory for the task in MB (512, 1024, 2048, 3072, 4096, etc.)"
  type        = number
  default     = 1024 # 1 GB - cheapest option for 512 CPU
}

# -----------------------------------------------------------------------------
# ECS SERVICE CONFIGURATION
# -----------------------------------------------------------------------------


variable "desired_count" {
  description = "Desired number of tasks"
  type        = number
  default     = 2
}

variable "deployment_minimum_healthy_percent" {
  description = "Minimum healthy percent during deployment"
  type        = number
  default     = 100
}

variable "deployment_maximum_percent" {
  description = "Maximum percent during deployment"
  type        = number
  default     = 200
}

variable "health_check_grace_period" {
  description = "Health check grace period in seconds"
  type        = number
  default     = 60
}

variable "enable_ecs_exec" {
  description = "Enable ECS Exec for debugging"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# AUTO SCALING CONFIGURATION
# -----------------------------------------------------------------------------

variable "min_capacity" {
  description = "Minimum number of tasks"
  type        = number
  default     = 1
}

variable "max_capacity" {
  description = "Maximum number of tasks"
  type        = number
  default     = 4
}

variable "cpu_target_value" {
  description = "Target CPU utilization for auto-scaling (%)"
  type        = number
  default     = 70
}

variable "memory_target_value" {
  description = "Target memory utilization for auto-scaling (%)"
  type        = number
  default     = 80
}

variable "scale_in_cooldown" {
  description = "Cooldown period for scaling in (seconds)"
  type        = number
  default     = 300 # 5 minutes
}

variable "scale_out_cooldown" {
  description = "Cooldown period for scaling out (seconds)"
  type        = number
  default     = 60 # 1 minute
}

# -----------------------------------------------------------------------------
# FARGATE CONFIGURATION
# -----------------------------------------------------------------------------


variable "fargate_weight" {
  description = "Weight for FARGATE capacity provider"
  type        = number
  default     = 1
}

variable "fargate_base" {
  description = "Base number of tasks to run on FARGATE"
  type        = number
  default     = 1
}

variable "fargate_spot_weight" {
  description = "Weight for FARGATE_SPOT capacity provider"
  type        = number
  default     = 0 # Set to 1 to enable spot instances
}

# -----------------------------------------------------------------------------
# LOGGING CONFIGURATION
# -----------------------------------------------------------------------------

variable "log_retention_days" {
  description = "CloudWatch log retention period in days"
  type        = number
  default     = 7
}

# -----------------------------------------------------------------------------
# MONITORING CONFIGURATION
# -----------------------------------------------------------------------------

variable "enable_container_insights" {
  description = "Enable Container Insights for monitoring"
  type        = bool
  default     = false # Set to true in prod
}

variable "enable_alarms" {
  description = "Enable CloudWatch alarms"
  type        = bool
  default     = false
}
