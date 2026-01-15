# =============================================================================
# ECR MODULE - VARIABLES
# =============================================================================

# -----------------------------------------------------------------------------
# PROJECT IDENTIFICATION
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Name of the project. Used for repository naming."
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

# -----------------------------------------------------------------------------
# REPOSITORY CONFIGURATION
# -----------------------------------------------------------------------------

variable "create_lambda_repository" {
  description = <<-EOT
    Whether to create an ECR repository for Lambda container images.
    
    Container-based Lambdas are useful when:
    - Function exceeds 50MB ZIP size limit
    - You need custom runtime/dependencies
    - You want identical local and cloud environments
    
    For most cases with standard Node.js Lambdas, ZIP deployment is simpler.
  EOT
  type        = bool
  default     = false
}


variable "force_delete" {
  description = "Allow deletion of repository even if it contains images (use with caution in prod)"
  type        = bool
  default     = true # Safe default for dev, override in prod
}


# -----------------------------------------------------------------------------
# LIFECYCLE POLICY CONFIGURATION
# -----------------------------------------------------------------------------

variable "image_retention_count" {
  description = <<-EOT
    Number of tagged images to retain.
    Older images beyond this count will be deleted.
    
    Higher = more rollback options but higher storage cost
    Lower = less storage cost but fewer rollback options
    
    Recommended: 10-20 for prod, 5 for dev
  EOT
  type        = number
  default     = 2
}

variable "dev_image_retention_count" {
  description = <<-EOT
    Number of dev/feature/PR images to retain.
    These images are typically short-lived.
    
    Recommended: 3-5 to keep costs low
  EOT
  type        = number
  default     = 1
}

variable "untagged_image_retention_days" {
  description = <<-EOT
    Days to keep untagged images before deletion.
    Untagged images occur when you push the same tag again.
    
    Recommended: 1-3 days
  EOT
  type        = number
  default     = 1
}


# -----------------------------------------------------------------------------
# CROSS-ACCOUNT ACCESS
# -----------------------------------------------------------------------------

variable "cross_account_ids" {
  description = <<-EOT
    List of AWS account IDs that can pull images from this repository.
    
    Useful for:
    - Shared services account pulling app images
    - Production account pulling from staging
    
    Leave empty for single-account setup.
  EOT
  type        = list(string)
  default     = []
}


# -----------------------------------------------------------------------------
# TAGGING
# -----------------------------------------------------------------------------

variable "common_tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default     = {}
}
