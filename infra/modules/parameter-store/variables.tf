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
  description = "Whether to create a custom KMS key (false = use AWS managed key)"
  type        = bool
  default     = false
}

variable "kms_key_arn" {
  description = "ARN of existing KMS key for encryption (null = AWS managed key)"
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
