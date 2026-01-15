# ============================================
# ACM Module Outputs - Automated Setup
# ============================================
# Path: infra/modules/acm/outputs.tf

output "certificate_arn" {
  description = "ARN of the certificate (self-signed or custom domain)"
  value = var.certificate_arn != null ? var.certificate_arn : (
    var.enable_custom_domain && var.custom_domain_name != null ? aws_acm_certificate.custom_domain[0].arn : (
      length(aws_acm_certificate.self_signed) > 0 ? aws_acm_certificate.self_signed[0].arn : null
    )
  )
}

output "certificate_type" {
  description = "Type of certificate (self-signed, custom-domain, or existing)"
  value = var.certificate_arn != null ? "existing" : (
    var.enable_custom_domain ? "custom-domain" : "self-signed"
  )
}

output "certificate_domain" {
  description = "Domain name on the certificate"
  value = var.enable_custom_domain && var.custom_domain_name != null ? var.custom_domain_name : var.alb_dns_name
}

output "certificate_status" {
  description = "Certificate status"
  value = var.enable_custom_domain && var.custom_domain_name != null ? aws_acm_certificate.custom_domain[0].status : "ISSUED"
}

output "certificate_pem" {
  description = "Certificate in PEM format (self-signed only)"
  value       = length(tls_self_signed_cert.alb) > 0 ? tls_self_signed_cert.alb[0].cert_pem : null
  sensitive   = true
}

output "private_key_pem" {
  description = "Private key in PEM format (self-signed only)"
  value       = length(tls_private_key.alb) > 0 ? tls_private_key.alb[0].private_key_pem : null
  sensitive   = true
}

output "certificate_files_location" {
  description = "Location of saved certificate files"
  value       = var.save_certificate_locally ? "${var.certificate_output_path}/" : "Not saved locally"
}

output "validation_record_fqdns" {
  description = "FQDNs of validation records (custom domain only)"
  value       = var.enable_custom_domain ? [for record in aws_route53_record.cert_validation : record.fqdn] : []
}
