# =============================================================================
# PARAMETER STORE MODULE - OUTPUTS
# =============================================================================

# -----------------------------------------------------------------------------
# KMS KEY OUTPUTS
# -----------------------------------------------------------------------------

output "kms_key_id" {
  description = "ID of the KMS key used for encryption"
  value       = var.create_kms_key ? aws_kms_key.parameter_store[0].id : null
}

output "kms_key_arn" {
  description = "ARN of the KMS key used for encryption"
  value       = var.create_kms_key ? aws_kms_key.parameter_store[0].arn : null
}

# -----------------------------------------------------------------------------
# PARAMETER NAMES (for reference)
# -----------------------------------------------------------------------------

output "parameter_names" {
  description = "List of all parameter names created"
  value = [
    aws_ssm_parameter.mongo_uri.name,
    aws_ssm_parameter.jwt_access_token_secret.name,
    aws_ssm_parameter.jwt_access_token_expires_in.name,
    aws_ssm_parameter.jwt_refresh_token_secret.name,
    aws_ssm_parameter.jwt_refresh_token_expires_in.name,
    aws_ssm_parameter.google_client_id.name,
    aws_ssm_parameter.google_client_secret.name,
    aws_ssm_parameter.google_callback_url.name,
    aws_ssm_parameter.frontend_origin.name,
    aws_ssm_parameter.frontend_google_callback_url.name,
    aws_ssm_parameter.cookie_domain.name,
    aws_ssm_parameter.node_env.name,
    aws_ssm_parameter.port.name,
    aws_ssm_parameter.vite_api_base_url.name,
  ]
}

# -----------------------------------------------------------------------------
# PARAMETER ARNS (for IAM policies)
# -----------------------------------------------------------------------------

output "parameter_arns" {
  description = "Map of parameter names to ARNs"
  value = {
    mongo_uri                       = aws_ssm_parameter.mongo_uri.arn
    jwt_access_token_secret         = aws_ssm_parameter.jwt_access_token_secret.arn
    jwt_access_token_expires_in     = aws_ssm_parameter.jwt_access_token_expires_in.arn
    jwt_refresh_token_secret        = aws_ssm_parameter.jwt_refresh_token_secret.arn
    jwt_refresh_token_expires_in    = aws_ssm_parameter.jwt_refresh_token_expires_in.arn
    google_client_id                = aws_ssm_parameter.google_client_id.arn
    google_client_secret            = aws_ssm_parameter.google_client_secret.arn
    google_callback_url             = aws_ssm_parameter.google_callback_url.arn
    frontend_origin                 = aws_ssm_parameter.frontend_origin.arn
    frontend_google_callback_url    = aws_ssm_parameter.frontend_google_callback_url.arn
    cookie_domain                   = aws_ssm_parameter.cookie_domain.arn
    node_env                        = aws_ssm_parameter.node_env.arn
    port                            = aws_ssm_parameter.port.arn
    vite_api_base_url              = aws_ssm_parameter.vite_api_base_url.arn
  }
}

# -----------------------------------------------------------------------------
# BASE PATH
# -----------------------------------------------------------------------------

output "base_path" {
  description = "Base path for all parameters"
  value       = "/${var.project_name}/${var.environment}"
}

output "base_path_arn" {
  description = "ARN pattern for base path (for IAM policies)"
  value       = "arn:aws:ssm:*:*:parameter/${var.project_name}/${var.environment}/*"
}

# -----------------------------------------------------------------------------
# BACKEND PARAMETERS (for ECS)
# -----------------------------------------------------------------------------

output "backend_parameter_names" {
  description = "Parameter names needed by backend (for ECS task definition)"
  value = [
    aws_ssm_parameter.mongo_uri.name,
    aws_ssm_parameter.jwt_access_token_secret.name,
    aws_ssm_parameter.jwt_access_token_expires_in.name,
    aws_ssm_parameter.jwt_refresh_token_secret.name,
    aws_ssm_parameter.jwt_refresh_token_expires_in.name,
    aws_ssm_parameter.google_client_id.name,
    aws_ssm_parameter.google_client_secret.name,
    aws_ssm_parameter.google_callback_url.name,
    aws_ssm_parameter.frontend_origin.name,
    aws_ssm_parameter.frontend_google_callback_url.name,
    aws_ssm_parameter.cookie_domain.name,
    aws_ssm_parameter.node_env.name,
    aws_ssm_parameter.port.name,
  ]
}

# -----------------------------------------------------------------------------
# FRONTEND PARAMETERS
# -----------------------------------------------------------------------------

output "frontend_api_url" {
  description = "Backend API URL for frontend (from parameter store)"
  value       = var.vite_api_base_url
}


# -----------------------------------------------------------------------------
# SUMMARY OUTPUT
# -----------------------------------------------------------------------------

output "parameter_store_summary" {
  description = "Summary of Parameter Store configuration"
  value = {
    base_path           = "/${var.project_name}/${var.environment}"
    total_parameters    = 14
    secure_parameters   = 4  # mongo_uri, jwt secrets, google secret
    standard_parameters = 10
    kms_key_created     = var.create_kms_key
  }
}

# -----------------------------------------------------------------------------
# CLI COMMANDS (helpful for debugging)
# -----------------------------------------------------------------------------

output "cli_commands" {
  description = "Useful AWS CLI commands for parameter management"
  value = {
    list_all = "aws ssm get-parameters-by-path --path /${var.project_name}/${var.environment} --recursive"
    get_one  = "aws ssm get-parameter --name /${var.project_name}/${var.environment}/MONGO_URI --with-decryption"
    update   = "aws ssm put-parameter --name /${var.project_name}/${var.environment}/MONGO_URI --value 'new-value' --overwrite"
  }
}
