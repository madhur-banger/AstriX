# =============================================================================
# ALB MODULE - VARIABLES
# =============================================================================

variable "project_name" {
  description = "Name of the project"
  type = string
}

variable "environment" {
  description = "Environment name ( dev, staging, prod)"
  type = string
}

variable "vpc_id" {
  description = "ID of the VPC"
  type = string
}

variable "public_subnet_ids" {
  description = "List of public subnets IDs for ALB"
  type = list(string)
}

variable "alb_security_group_id" {
  description = "Security group ID for ALB"
  type        = string
}

variable "backend_port" {
  description = "Port the backend application listens on"
  type        = number
  default     = 8000
}

variable "health_check_path" {
  description = "Path for health check endpoint"
  type        = string
  default     = "/health"
}

variable "enable_stickiness" {
  description = "Enable session stickiness"
  type        = bool
  default     = false
}

variable "certificate_arn" {
  description = "ARN of ACM certificate for HTTPS (optional)"
  type        = string
  default     = null
}

variable "enable_access_logs" {
  description = "Enable ALB access logs"
  type        = bool
  default     = false
}

variable "access_logs_bucket" {
  description = "S3 bucket for ALB access logs"
  type        = string
  default     = null
}

variable "common_tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default     = {}
}