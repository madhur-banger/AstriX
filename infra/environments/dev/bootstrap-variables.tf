# =============================================================================
# BOOTSTRAP VARIABLES (Add to variables.tf)
# =============================================================================
# Add these variables to your existing variables.tf file

# -----------------------------------------------------------------------------
# AWS PROFILE CONFIGURATION
# -----------------------------------------------------------------------------

variable "aws_profile" {
  description = "AWS CLI profile to use for local-exec commands"
  type        = string
  default     = "prod-terraform"
}

# -----------------------------------------------------------------------------
# BOOTSTRAP CONFIGURATION
# -----------------------------------------------------------------------------

variable "enable_initial_docker_push" {
  description = "Whether to build and push initial Docker image during terraform apply"
  type        = bool
  default     = true
}

variable "enable_url_auto_update" {
  description = "Whether to automatically update Parameter Store URLs after CloudFront creation"
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# ECR FORCE DELETE
# -----------------------------------------------------------------------------

variable "ecr_force_delete" {
  description = "Allow ECR repository deletion even with images (use with caution in prod)"
  type        = bool
  default     = true
}
