# =============================================================================
# CLOUDFRONT + S3 MODULE - VARIABLES
# =============================================================================

# -----------------------------------------------------------------------------
# PROJECT IDENTIFICATION
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
# S3 BUCKET CONFIGURATION
# -----------------------------------------------------------------------------

variable "bucket_name" {
  description = "Custom bucket name (optional - defaults to project-env-frontend)"
  type        = string
  default     = null
}

variable "force_destroy" {
  description = "Allow bucket deletion even with objects (use with caution)"
  type        = bool
  default     = false
}


variable "enable_versioning" {
  description = "Enable S3 bucket versioning"
  type        = bool
  default     = true
}

variable "kms_key_arn" {
  description = "KMS key ARN for S3 encryption (optional - uses AES256 if not provided)"
  type        = string
  default     = null
}

variable "enable_lifecycle_rules" {
  description = "Enable lifecycle rules for cost optimization"
  type        = bool
  default     = true
}

variable "noncurrent_version_expiration_days" {
  description = "Days to keep noncurrent versions"
  type        = number
  default     = 30
}

variable "cors_allowed_origins" {
  description = "Allowed origins for CORS"
  type        = list(string)
  default     = ["*"]
}

# -----------------------------------------------------------------------------
# CLOUDFRONT CONFIGURATION
# -----------------------------------------------------------------------------

variable "price_class" {
  description = "CloudFront price class (PriceClass_100, PriceClass_200, PriceClass_All)"
  type        = string
  default     = "PriceClass_100" # US, Canada, Europe only (cheapest)
}

variable "enable_spa_routing" {
  description = "Enable SPA routing (serve index.html for all routes)"
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# CUSTOM DOMAIN CONFIGURATION
# -----------------------------------------------------------------------------

variable "domain_name" {
  description = "Custom domain name for CloudFront (optional)"
  type        = string
  default     = null
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN for HTTPS (must be in us-east-1)"
  type        = string
  default     = null
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID for DNS records"
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# BACKEND API CONFIGURATION
# -----------------------------------------------------------------------------

variable "alb_dns_name" {
  description = "ALB DNS name for API origin"
  type        = string
  default     = null
}

variable "alb_protocol_policy" {
  description = "Protocol policy for ALB origin (http-only, https-only, match-viewer)"
  type        = string
  default     = "http-only" # Use http-only if ALB doesn't have HTTPS
}

variable "origin_custom_headers" {
  description = "Custom headers to send to origin"
  type = list(object({
    name  = string
    value = string
  }))
  default = []
}

# -----------------------------------------------------------------------------
# SECURITY CONFIGURATION
# -----------------------------------------------------------------------------

variable "web_acl_id" {
  description = "AWS WAF Web ACL ID for CloudFront"
  type        = string
  default     = null
}

variable "content_security_policy" {
  description = "Content Security Policy header value"
  type        = string
  default     = null
}

variable "geo_restriction_type" {
  description = "Geo restriction type (none, whitelist, blacklist)"
  type        = string
  default     = "none"
}

variable "geo_restriction_locations" {
  description = "List of country codes for geo restriction"
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# LOGGING CONFIGURATION
# -----------------------------------------------------------------------------

variable "enable_logging" {
  description = "Enable CloudFront access logging"
  type        = bool
  default     = false
}

variable "log_bucket" {
  description = "S3 bucket for CloudFront logs (must have proper permissions)"
  type        = string
  default     = null
}

variable "log_prefix" {
  description = "Prefix for log files in the bucket"
  type        = string
  default     = null
}

variable "log_include_cookies" {
  description = "Include cookies in access logs"
  type        = bool
  default     = false
}
