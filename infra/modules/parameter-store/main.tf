# =============================================================================
# PARAMETER STORE MODULE - SECRETS MANAGEMENT
# =============================================================================
# This module creates AWS Systems Manager Parameter Store parameters for
# storing application secrets and configuration.
#
# What it creates:
# - Secure parameters (encrypted with KMS)
# - Standard parameters (non-sensitive config)
# - Organized by environment path: /{project}/{env}/{key}
#
# Security:
# - SecureString parameters are encrypted with KMS
# - IAM roles control access (ECS execution role can read)
# - Audit trail via CloudWatch Logs
# =============================================================================

# -----------------------------------------------------------------------------
# KMS KEY FOR PARAMETER STORE ENCRYPTION (Optional)
# -----------------------------------------------------------------------------
# If you don't provide a KMS key, AWS uses a default key (free)
# Custom KMS key gives you more control and audit capability

resource "aws_kms_key" "parameter_store" {
  count = var.create_kms_key ? 1 : 0

  description             = "KMS key for ${var.project_name}-${var.environment} Parameter Store encryption"
  deletion_window_in_days = var.kms_deletion_window
  enable_key_rotation     = true

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-parameter-store-key"
  })
}

resource "aws_kms_alias" "parameter_store" {
  count = var.create_kms_key ? 1 : 0

  name          = "alias/${var.project_name}-${var.environment}-parameter-store"
  target_key_id = aws_kms_key.parameter_store[0].key_id
}

# -----------------------------------------------------------------------------
# MONGODB CONNECTION
# -----------------------------------------------------------------------------

resource "aws_ssm_parameter" "mongo_uri" {
  name        = "/${var.project_name}/${var.environment}/MONGO_URI"
  description = "MongoDB connection URI"
  type        = "SecureString"
  value       = var.mongo_uri
  key_id      = var.kms_key_arn

  tags = merge(var.common_tags, {
    Name        = "MONGO_URI"
    Sensitive   = "true"
    Application = "backend"
  })

  lifecycle {
    ignore_changes = [value] # Prevent accidental overwrite
  }
}

# -----------------------------------------------------------------------------
# JWT SECRETS
# -----------------------------------------------------------------------------

resource "aws_ssm_parameter" "jwt_access_token_secret" {
  name        = "/${var.project_name}/${var.environment}/JWT_ACCESS_TOKEN_SECRET"
  description = "JWT access token secret key"
  type        = "SecureString"
  value       = var.jwt_access_token_secret
  key_id      = var.kms_key_arn

  tags = merge(var.common_tags, {
    Name        = "JWT_ACCESS_TOKEN_SECRET"
    Sensitive   = "true"
    Application = "backend"
  })

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "jwt_access_token_expires_in" {
  name        = "/${var.project_name}/${var.environment}/JWT_ACCESS_TOKEN_EXPIRES_IN"
  description = "JWT access token expiration time"
  type        = "String" # Not sensitive
  value       = var.jwt_access_token_expires_in

  tags = merge(var.common_tags, {
    Name        = "JWT_ACCESS_TOKEN_EXPIRES_IN"
    Application = "backend"
  })
}

resource "aws_ssm_parameter" "jwt_refresh_token_secret" {
  name        = "/${var.project_name}/${var.environment}/JWT_REFRESH_TOKEN_SECRET"
  description = "JWT refresh token secret key"
  type        = "SecureString"
  value       = var.jwt_refresh_token_secret
  key_id      = var.kms_key_arn

  tags = merge(var.common_tags, {
    Name        = "JWT_REFRESH_TOKEN_SECRET"
    Sensitive   = "true"
    Application = "backend"
  })

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "jwt_refresh_token_expires_in" {
  name        = "/${var.project_name}/${var.environment}/JWT_REFRESH_TOKEN_EXPIRES_IN"
  description = "JWT refresh token expiration time"
  type        = "String"
  value       = var.jwt_refresh_token_expires_in

  tags = merge(var.common_tags, {
    Name        = "JWT_REFRESH_TOKEN_EXPIRES_IN"
    Application = "backend"
  })
}

# -----------------------------------------------------------------------------
# GOOGLE OAUTH CREDENTIALS
# -----------------------------------------------------------------------------

resource "aws_ssm_parameter" "google_client_id" {
  name        = "/${var.project_name}/${var.environment}/GOOGLE_CLIENT_ID"
  description = "Google OAuth client ID"
  type        = "String" # Not a secret
  value       = var.google_client_id

  tags = merge(var.common_tags, {
    Name        = "GOOGLE_CLIENT_ID"
    Application = "backend"
  })
}

resource "aws_ssm_parameter" "google_client_secret" {
  name        = "/${var.project_name}/${var.environment}/GOOGLE_CLIENT_SECRET"
  description = "Google OAuth client secret"
  type        = "SecureString"
  value       = var.google_client_secret
  key_id      = var.kms_key_arn

  tags = merge(var.common_tags, {
    Name        = "GOOGLE_CLIENT_SECRET"
    Sensitive   = "true"
    Application = "backend"
  })

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "google_callback_url" {
  name        = "/${var.project_name}/${var.environment}/GOOGLE_CALLBACK_URL"
  description = "Google OAuth callback URL (backend)"
  type        = "String"
  value       = var.google_callback_url

  tags = merge(var.common_tags, {
    Name        = "GOOGLE_CALLBACK_URL"
    Application = "backend"
  })
}

# -----------------------------------------------------------------------------
# FRONTEND CONFIGURATION
# -----------------------------------------------------------------------------

resource "aws_ssm_parameter" "frontend_origin" {
  name        = "/${var.project_name}/${var.environment}/FRONTEND_ORIGIN"
  description = "Frontend origin URL (for CORS)"
  type        = "String"
  value       = var.frontend_origin

  tags = merge(var.common_tags, {
    Name        = "FRONTEND_ORIGIN"
    Application = "backend"
  })
}

resource "aws_ssm_parameter" "frontend_google_callback_url" {
  name        = "/${var.project_name}/${var.environment}/FRONTEND_GOOGLE_CALLBACK_URL"
  description = "Frontend Google OAuth callback URL"
  type        = "String"
  value       = var.frontend_google_callback_url

  tags = merge(var.common_tags, {
    Name        = "FRONTEND_GOOGLE_CALLBACK_URL"
    Application = "backend"
  })
}

# -----------------------------------------------------------------------------
# COOKIE CONFIGURATION
# -----------------------------------------------------------------------------

resource "aws_ssm_parameter" "cookie_domain" {
  name        = "/${var.project_name}/${var.environment}/COOKIE_DOMAIN"
  description = "Cookie domain for session management"
  type        = "String"
  value       = var.cookie_domain

  tags = merge(var.common_tags, {
    Name        = "COOKIE_DOMAIN"
    Application = "backend"
  })
}

# -----------------------------------------------------------------------------
# APPLICATION ENVIRONMENT
# -----------------------------------------------------------------------------

resource "aws_ssm_parameter" "node_env" {
  name        = "/${var.project_name}/${var.environment}/NODE_ENV"
  description = "Node environment (development/production)"
  type        = "String"
  value       = var.node_env

  tags = merge(var.common_tags, {
    Name        = "NODE_ENV"
    Application = "backend"
  })
}

resource "aws_ssm_parameter" "port" {
  name        = "/${var.project_name}/${var.environment}/PORT"
  description = "Application port"
  type        = "String"
  value       = var.port

  tags = merge(var.common_tags, {
    Name        = "PORT"
    Application = "backend"
  })
}

# -----------------------------------------------------------------------------
# FRONTEND API URL (for React app)
# -----------------------------------------------------------------------------

resource "aws_ssm_parameter" "vite_api_base_url" {
  name        = "/${var.project_name}/${var.environment}/VITE_API_BASE_URL"
  description = "Backend API URL for frontend (Vite)"
  type        = "String"
  value       = var.vite_api_base_url

  tags = merge(var.common_tags, {
    Name        = "VITE_API_BASE_URL"
    Application = "frontend"
  })
}

# -----------------------------------------------------------------------------
# PARAMETER STORE PATH (for bulk reading)
# -----------------------------------------------------------------------------
# Create a placeholder parameter that marks the base path
# Useful for granting IAM permissions to entire path

resource "aws_ssm_parameter" "base_path" {
  name        = "/${var.project_name}/${var.environment}/.metadata"
  description = "Base path metadata for ${var.project_name}-${var.environment}"
  type        = "String"
  value = jsonencode({
    project     = var.project_name
    environment = var.environment
    created_at  = timestamp()
    parameters  = [
      "MONGO_URI",
      "JWT_ACCESS_TOKEN_SECRET",
      "JWT_REFRESH_TOKEN_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_CALLBACK_URL",
      "FRONTEND_ORIGIN",
      "FRONTEND_GOOGLE_CALLBACK_URL",
      "COOKIE_DOMAIN",
      "NODE_ENV",
      "PORT",
      "VITE_API_BASE_URL"
    ]
  })

  tags = merge(var.common_tags, {
    Name = "metadata"
  })

  lifecycle {
    ignore_changes = [value]
  }
}
