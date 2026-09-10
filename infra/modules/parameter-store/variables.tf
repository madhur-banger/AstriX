# =============================================================================
# PARAMETER STORE MODULE - VARIABLES
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

variable "common_tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# KMS CONFIGURATION
# -----------------------------------------------------------------------------

variable "create_kms_key" {
  description = <<-EOT
    Whether to create a dedicated customer-managed KMS key for the
    SecureString parameters (false = fall back to the AWS-managed
    alias/aws/ssm key, whose key policy cannot be edited).

    COST: ~$1/month per key.
  EOT
  type        = bool
  default     = false
}

variable "kms_key_arn" {
  description = <<-EOT
    ARN of an existing KMS key to encrypt SecureString parameters with.
    Takes precedence over create_kms_key, so a caller can share one key
    across modules. null + create_kms_key = false means the AWS-managed key.
  EOT
  type        = string
  default     = null
}

variable "ecs_task_execution_role_arn" {
  description = <<-EOT
    ARN of the ECS task execution role, granted kms:Decrypt in the created
    key's policy (only when create_kms_key is true). This is the role that
    resolves SecureString parameters when a task starts - without it in the
    key policy, containers fail to launch with an AccessDeniedException on
    the secrets, no matter what the role's own IAM policy allows.

    Leave null if no ECS workload reads these parameters.
  EOT
  type        = string
  default     = null
}

variable "kms_deletion_window" {
  description = "KMS key deletion window in days"
  type        = number
  default     = 30
}

# -----------------------------------------------------------------------------
# MONGODB CONFIGURATION
# -----------------------------------------------------------------------------

variable "mongo_uri" {
  description = "MongoDB connection URI"
  type        = string
  sensitive   = true
}


# -----------------------------------------------------------------------------
# JWT CONFIGURATION
# -----------------------------------------------------------------------------

variable "jwt_access_token_secret" {
  description = "JWT access token secret key"
  type        = string
  sensitive   = true
}

variable "jwt_access_token_expires_in" {
  description = "JWT access token expiration time"
  type        = string
  default     = "15m"
}

variable "jwt_refresh_token_secret" {
  description = "JWT refresh token secret key"
  type        = string
  sensitive   = true
}

variable "jwt_refresh_token_expires_in" {
  description = "JWT refresh token expiration time"
  type        = string
  default     = "7d"
}

# -----------------------------------------------------------------------------
# GOOGLE OAUTH CONFIGURATION
# -----------------------------------------------------------------------------

variable "google_client_id" {
  description = "Google OAuth client ID"
  type        = string
}

variable "google_client_secret" {
  description = "Google OAuth client secret"
  type        = string
  sensitive   = true
}

variable "google_callback_url" {
  description = "Google OAuth callback URL (backend)"
  type        = string
}

# -----------------------------------------------------------------------------
# FRONTEND CONFIGURATION
# -----------------------------------------------------------------------------

variable "frontend_origin" {
  description = "Frontend origin URL (for CORS)"
  type        = string
}

variable "frontend_google_callback_url" {
  description = "Frontend Google OAuth callback URL"
  type        = string
}

variable "vite_api_base_url" {
  description = "Backend API URL for frontend (Vite)"
  type        = string
}

# -----------------------------------------------------------------------------
# COOKIE CONFIGURATION
# -----------------------------------------------------------------------------

variable "cookie_domain" {
  description = "Cookie domain for session management"
  type        = string
}

# -----------------------------------------------------------------------------
# APPLICATION CONFIGURATION
# -----------------------------------------------------------------------------

variable "node_env" {
  description = "Node environment (development/production)"
  type        = string
  default     = "production"
}

variable "port" {
  description = "Application port"
  type        = string
  default     = "8000"
}
