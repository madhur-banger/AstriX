
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

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod."
  }
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

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.task_cpu)
    error_message = "task_cpu must be a valid Fargate CPU value: 256, 512, 1024, 2048, or 4096."
  }
}

variable "task_memory" {
  description = "Memory for the task in MB (512, 1024, 2048, 3072, 4096, etc.)"
  type        = number
  default     = 1024 # 1 GB - cheapest option for 512 CPU

  validation {
    # Fargate only allows specific (cpu, memory) pairings - this doesn't
    # cross-validate against task_cpu (Terraform variable validations can't
    # reference sibling variables), but it does reject memory values Fargate
    # would never accept for ANY CPU size, catching the most common typo
    # (e.g. a raw GB value like `1` instead of `1024` MB).
    condition     = var.task_memory >= 512 && var.task_memory <= 30720 && var.task_memory % 1024 == 0 || var.task_memory % 512 == 0
    error_message = "task_memory must be a valid Fargate memory value in MB (e.g. 512, 1024, 2048, ... up to 30720), matching your task_cpu per AWS's Fargate CPU/memory table."
  }
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

variable "alarm_actions" {
  description = "ARNs (e.g. an SNS topic) to notify when an alarm changes state - both ALARM and OK. Alarms with an empty list here change state silently."
  type        = list(string)
  default     = []
}
