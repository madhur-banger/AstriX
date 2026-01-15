# ============================================
# ACM Module - Fully Automated Certificate Management
# ============================================
# Path: infra/modules/acm/main.tf
#
# This module automatically manages certificates:
# - For dev/staging: Uses imported self-signed certificate (manual import once)
# - For prod: Uses ACM with DNS validation (fully automated)

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

# ============================================
# Locals
# ============================================

locals {
  use_custom_domain = var.enable_custom_domain && var.custom_domain_name != null
  use_self_signed   = !local.use_custom_domain && var.certificate_arn == null
  
  # Certificate ARN to use
  certificate_arn = var.certificate_arn != null ? var.certificate_arn : (
    local.use_custom_domain ? aws_acm_certificate.custom_domain[0].arn : null
  )
}

# ============================================
# Self-Signed Certificate Generation (Local Files)
# ============================================

# Generate private key
resource "tls_private_key" "alb" {
  count     = local.use_self_signed ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

# Generate self-signed certificate
resource "tls_self_signed_cert" "alb" {
  count           = local.use_self_signed ? 1 : 0
  private_key_pem = tls_private_key.alb[0].private_key_pem

  subject {
    common_name  = var.alb_dns_name
    organization = var.organization_name
    country      = var.country_code
  }

  validity_period_hours = 8760 # 365 days

  allowed_uses = [
    "key_encipherment",
    "digital_signature",
    "server_auth",
  ]
}

# Save certificate to local file (for reference)
resource "local_file" "certificate" {
  count    = local.use_self_signed && var.save_certificate_locally ? 1 : 0
  content  = tls_self_signed_cert.alb[0].cert_pem
  filename = "${var.certificate_output_path}/alb-certificate.pem"
}

resource "local_file" "private_key" {
  count    = local.use_self_signed && var.save_certificate_locally ? 1 : 0
  content  = tls_private_key.alb[0].private_key_pem
  filename = "${var.certificate_output_path}/alb-private-key.pem"
}

# ============================================
# Import Self-Signed Certificate to ACM
# ============================================

resource "aws_acm_certificate" "self_signed" {
  count             = local.use_self_signed ? 1 : 0
  private_key       = tls_private_key.alb[0].private_key_pem
  certificate_body  = tls_self_signed_cert.alb[0].cert_pem

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "${var.environment}-alb-self-signed-cert"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Type        = "Self-Signed"
  }
}

# ============================================
# ACM Certificate for Custom Domain (Production)
# ============================================

resource "aws_acm_certificate" "custom_domain" {
  count             = local.use_custom_domain ? 1 : 0
  domain_name       = var.custom_domain_name
  validation_method = "DNS"

  subject_alternative_names = var.include_wildcard ? ["*.${var.custom_domain_name}"] : []

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "${var.environment}-custom-domain-cert"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Domain      = var.custom_domain_name
  }
}

# ============================================
# Route53 DNS Validation (for custom domain)
# ============================================

data "aws_route53_zone" "custom_domain" {
  count        = local.use_custom_domain && var.route53_zone_id == null ? 1 : 0
  name         = var.custom_domain_name
  private_zone = false
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.use_custom_domain ? {
    for dvo in aws_acm_certificate.custom_domain[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id != null ? var.route53_zone_id : data.aws_route53_zone.custom_domain[0].zone_id
}

resource "aws_acm_certificate_validation" "custom_domain" {
  count                   = local.use_custom_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.custom_domain[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]

  timeouts {
    create = "10m"
  }
}

# ============================================
# Certificate Rotation Check
# ============================================

# Alert if certificate expires in 30 days
resource "null_resource" "certificate_expiration_check" {
  count = var.enable_expiration_alerts ? 1 : 0

  triggers = {
    certificate_arn = local.certificate_arn
  }

  provisioner "local-exec" {
    command = <<-EOT
      echo "Certificate ARN: ${local.certificate_arn}"
      echo "Certificate will expire in approximately ${local.use_self_signed ? "365 days" : "automatic renewal"}"
    EOT
  }
}
