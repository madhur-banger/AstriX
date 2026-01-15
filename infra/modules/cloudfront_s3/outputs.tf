# =============================================================================
# CLOUDFRONT + S3 MODULE - OUTPUTS
# =============================================================================

# -----------------------------------------------------------------------------
# S3 BUCKET OUTPUTS
# -----------------------------------------------------------------------------


output "bucket_id" {
  description = "S3 bucket ID"
  value       = aws_s3_bucket.frontend.id
}

output "bucket_arn" {
  description = "S3 bucket ARN"
  value       = aws_s3_bucket.frontend.arn
}

output "bucket_domain_name" {
  description = "S3 bucket domain name"
  value       = aws_s3_bucket.frontend.bucket_domain_name
}

output "bucket_regional_domain_name" {
  description = "S3 bucket regional domain name"
  value       = aws_s3_bucket.frontend.bucket_regional_domain_name
}

# -----------------------------------------------------------------------------
# CLOUDFRONT OUTPUTS
# -----------------------------------------------------------------------------

output "distribution_id" {
  description = "CloudFront distribution ID"
  value       = aws_cloudfront_distribution.frontend.id
}

output "distribution_arn" {
  description = "CloudFront distribution ARN"
  value       = aws_cloudfront_distribution.frontend.arn
}

output "distribution_domain_name" {
  description = "CloudFront distribution domain name"
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "distribution_hosted_zone_id" {
  description = "CloudFront distribution hosted zone ID (for Route53 alias)"
  value       = aws_cloudfront_distribution.frontend.hosted_zone_id
}

output "distribution_status" {
  description = "CloudFront distribution status"
  value       = aws_cloudfront_distribution.frontend.status
}

# -----------------------------------------------------------------------------
# URL OUTPUTS
# -----------------------------------------------------------------------------

output "frontend_url" {
  description = "Frontend URL (CloudFront)"
  value       = var.domain_name != null ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "cloudfront_url" {
  description = "CloudFront URL"
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "api_url" {
  description = "API URL through CloudFront"
  value       = var.domain_name != null ? "https://${var.domain_name}/api" : "https://${aws_cloudfront_distribution.frontend.domain_name}/api"
}

# -----------------------------------------------------------------------------
# DEPLOYMENT OUTPUTS
# -----------------------------------------------------------------------------

output "s3_sync_command" {
  description = "Command to sync frontend build to S3"
  value       = "aws s3 sync ./dist s3://${aws_s3_bucket.frontend.id} --delete"
}

output "invalidation_command" {
  description = "Command to invalidate CloudFront cache"
  value       = "aws cloudfront create-invalidation --distribution-id ${aws_cloudfront_distribution.frontend.id} --paths '/*'"
}

output "deployment_commands" {
  description = "Complete deployment commands"
  value = {
    build          = "npm run build"
    sync           = "aws s3 sync ./dist s3://${aws_s3_bucket.frontend.id} --delete"
    invalidate     = "aws cloudfront create-invalidation --distribution-id ${aws_cloudfront_distribution.frontend.id} --paths '/*'"
    full_deploy    = "npm run build && aws s3 sync ./dist s3://${aws_s3_bucket.frontend.id} --delete && aws cloudfront create-invalidation --distribution-id ${aws_cloudfront_distribution.frontend.id} --paths '/*'"
    check_status   = "aws cloudfront get-distribution --id ${aws_cloudfront_distribution.frontend.id} --query 'Distribution.Status'"
    list_objects   = "aws s3 ls s3://${aws_s3_bucket.frontend.id} --recursive"
    bucket_size    = "aws s3 ls s3://${aws_s3_bucket.frontend.id} --recursive --summarize | tail -2"
  }
}

# -----------------------------------------------------------------------------
# OAC OUTPUTS
# -----------------------------------------------------------------------------

output "origin_access_control_id" {
  description = "CloudFront Origin Access Control ID"
  value       = aws_cloudfront_origin_access_control.frontend.id
}


# -----------------------------------------------------------------------------
# SUMMARY OUTPUT
# -----------------------------------------------------------------------------

output "frontend_summary" {
  description = "Summary of frontend infrastructure"
  value = {
    s3_bucket           = aws_s3_bucket.frontend.id
    cloudfront_id       = aws_cloudfront_distribution.frontend.id
    cloudfront_domain   = aws_cloudfront_distribution.frontend.domain_name
    custom_domain       = var.domain_name
    frontend_url        = var.domain_name != null ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.frontend.domain_name}"
    api_url             = var.domain_name != null ? "https://${var.domain_name}/api" : "https://${aws_cloudfront_distribution.frontend.domain_name}/api"
    spa_routing_enabled = var.enable_spa_routing
    https_enabled       = true
    price_class         = var.price_class
  }
}
