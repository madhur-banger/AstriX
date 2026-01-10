# =============================================================================
# ECR MODULE - VARIABLES
# =============================================================================

# -----------------------------------------------------------------------------
# PROJECT IDENTIFICATION
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Name of the project. Used for resource naming and IAM resource prefixes."
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

# -----------------------------------------------------------------------------
# AWS CONFIGURATION
# -----------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region where resources are deployed"
  type        = string
}

variable "aws_account_id" {
  description = "AWS account ID (used for IAM policy ARNs)"
  type        = string
}

variable "kms_key_arn" {
  description = <<-EOT
    ARN of the KMS key used for encrypting secrets.
    If null, IAM policies will use a wildcard for KMS decrypt.
    
    Best practice: Create a dedicated KMS key for secrets.
  EOT
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# LAMBDA CONFIGURATION
# -----------------------------------------------------------------------------

variable "lambda_vpc_access" {
  description = <<-EOT
    Whether Lambda functions need VPC access.
    
    Set to true if Lambda needs to:
    - Access RDS/ElastiCache in private subnets
    - Have a fixed outbound IP (via NAT)
    
    Note: VPC-attached Lambdas have cold start overhead.
  EOT
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# GITHUB ACTIONS OIDC
# -----------------------------------------------------------------------------

variable "create_github_oidc" {
  description = <<-EOT
    Whether to create GitHub Actions OIDC provider and role.
    
    OIDC allows GitHub Actions to assume AWS roles without
    storing access keys in GitHub Secrets.
    
    Much more secure than static credentials.
  EOT
  type        = bool
  default     = false
}

variable "github_org" {
  description = <<-EOT
    GitHub organization or username.
    Used in OIDC trust policy to restrict which repos can assume the role.
    
    Example: "mycompany" or "myusername"
  EOT
  type        = string
  default     = ""
}

variable "github_repo" {
  description = <<-EOT
    GitHub repository name.
    Used in OIDC trust policy to restrict which repos can assume the role.
    
    Example: "task-management-platform"
  EOT
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# TAGGING
# -----------------------------------------------------------------------------

variable "common_tags" {
  description = "Common tags to apply to all resources"
  type        = map(string)
  default     = {}
}
