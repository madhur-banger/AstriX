# ============================================
# ACM Module Variables - Automated Setup
# ============================================
# Path: infra/modules/acm/variables.tf

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "project_name" {
  description = "Project name"
  type        = string
  default     = "astrix"
}

# ============================================
# Self-Signed Certificate (Development)
# ============================================

variable "alb_dns_name" {
  description = "ALB DNS name for self-signed certificate"
  type        = string
  default     = ""
}

variable "organization_name" {
  description = "Organization name for certificate"
  type        = string
  default     = "AstriX"
}

variable "country_code" {
  description = "Country code for certificate"
  type        = string
  default     = "US"
}

variable "save_certificate_locally" {
  description = "Save generated certificate to local files"
  type        = bool
  default     = true
}

variable "certificate_output_path" {
  description = "Path to save certificate files"
  type        = string
  default     = "./certificates"
}

# ============================================
# Custom Domain Certificate (Production)
# ============================================

variable "enable_custom_domain" {
  description = "Enable custom domain with ACM certificate"
  type        = bool
  default     = false
}

variable "custom_domain_name" {
  description = "Custom domain name (e.g., example.com)"
  type        = string
  default     = null
}

variable "include_wildcard" {
  description = "Include wildcard subdomain (*.example.com) in certificate"
  type        = bool
  default     = true
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID (if not provided, will lookup by domain name)"
  type        = string
  default     = null
}

# ============================================
# Existing Certificate
# ============================================

variable "certificate_arn" {
  description = "ARN of existing certificate (if provided, skips certificate creation)"
  type        = string
  default     = null
}

# ============================================
# Monitoring & Alerts
# ============================================

variable "enable_expiration_alerts" {
  description = "Enable certificate expiration alerts"
  type        = bool
  default     = false
}
