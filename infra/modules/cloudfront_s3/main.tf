# =============================================================================
# CLOUDFRONT + S3 MODULE
# =============================================================================
# This module creates:
# - S3 bucket for static website hosting (React SPA)
# - CloudFront distribution with:
#   - HTTPS enforcement
#   - SPA routing support (no refresh errors)
#   - Optimal caching strategies
#   - Security headers
#   - Gzip/Brotli compression
#
# Frontend-only: the API is NOT proxied through this distribution - see the
# CLOUDFRONT DISTRIBUTION section below for why.
# =============================================================================

# -----------------------------------------------------------------------------
# DATA SOURCES
# -----------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# CloudFront Origin Access Control (OAC) - modern replacement for OAI
locals {
  # AWS global managed CloudFront policies (do NOT change)
  cloudfront_cache_policies = {
    optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
    disabled  = "413f83b7-8c41-4bb7-9f3f-3f83c2d3f01b" # Managed-CachingDisabled
  }
}


# S3 BUCKET FOR FRONTEND
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "frontend" {
  bucket        = var.bucket_name != null ? var.bucket_name : "${var.project_name}-${var.environment}-frontend"
  force_destroy = var.force_destroy

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-frontend"
    Type = "frontend-hosting"
  })
}

# Block all public access - CloudFront will access via OAC
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Enable versioning for rollback capability
resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = var.enable_versioning ? "Enabled" : "Suspended"
  }
}

# Server-side encryption
resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn != null ? "aws:kms" : "AES256"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}

# Lifecycle rules for cost optimization
resource "aws_s3_bucket_lifecycle_configuration" "frontend" {
  count  = var.enable_lifecycle_rules ? 1 : 0
  bucket = aws_s3_bucket.frontend.id

  rule {
    id     = "cleanup-old-versions"
    status = "Enabled"

    # Empty filter = apply to every object. The AWS provider warns that a
    # rule with neither `filter` nor `prefix` will become a hard error in a
    # future version - this makes "applies to everything" explicit instead
    # of implicit.
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "cleanup-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# CORS configuration for SPA
resource "aws_s3_bucket_cors_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

# -----------------------------------------------------------------------------
# CLOUDFRONT ORIGIN ACCESS CONTROL (OAC)
# -----------------------------------------------------------------------------


resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.project_name}-${var.environment}-oac"
  description                       = "OAC for ${var.project_name} frontend"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# -----------------------------------------------------------------------------
# S3 BUCKET POLICY FOR CLOUDFRONT
# -----------------------------------------------------------------------------

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.frontend.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
          }
        }
      }
    ]
  })

  depends_on = [aws_cloudfront_distribution.frontend]
}


# -----------------------------------------------------------------------------
# CLOUDFRONT RESPONSE HEADERS POLICY
# -----------------------------------------------------------------------------

resource "aws_cloudfront_response_headers_policy" "security_headers" {
  name    = "${var.project_name}-${var.environment}-security-headers"
  comment = "Security headers for ${var.project_name}"

  security_headers_config {
    # Prevent clickjacking
    frame_options {
      frame_option = "DENY"
      override     = true
    }

    # Prevent MIME type sniffing
    content_type_options {
      override = true
    }

    # Enable XSS protection
    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }

    # Referrer policy
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    # HSTS - only if using custom domain with SSL
    dynamic "strict_transport_security" {
      for_each = var.domain_name != null ? [1] : []
      content {
        access_control_max_age_sec = 31536000
        include_subdomains         = true
        preload                    = true
        override                   = true
      }
    }

    # Content Security Policy
    dynamic "content_security_policy" {
      for_each = var.content_security_policy != null ? [1] : []
      content {
        content_security_policy = var.content_security_policy
        override                = true
      }
    }
  }

  # Custom headers
  custom_headers_config {
    items {
      header   = "X-Robots-Tag"
      value    = var.environment == "prod" ? "all" : "noindex, nofollow"
      override = true
    }
  }
}


# -----------------------------------------------------------------------------
# CLOUDFRONT DISTRIBUTION
# -----------------------------------------------------------------------------
#
# Deliberately frontend-only: the API is NOT routed through this
# distribution. Caching a cookie-authenticated API response at the edge
# risks serving one user's response to another - see infra/README.md and
# scripts/update-urls.sh for the full rationale. Earlier revisions of this
# module wired an /api/* behavior to the ALB origin anyway (dead, unused
# code that contradicted the documented architecture); it's been removed
# rather than left as latent, contradictory surface. If a future need
# genuinely requires proxying the API through CloudFront, reintroduce it
# deliberately alongside updated docs, not as a default.

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.project_name}-${var.environment} frontend distribution"
  default_root_object = "index.html"
  price_class         = var.price_class
  aliases             = var.domain_name != null ? [var.domain_name] : []
  web_acl_id          = var.web_acl_id

  # ---------------------------------------------------------------------------
  # ORIGIN: S3 BUCKET (Frontend Static Files)
  # ---------------------------------------------------------------------------
  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "S3-${aws_s3_bucket.frontend.id}"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  # ---------------------------------------------------------------------------
  # DEFAULT BEHAVIOR: S3 (Static Files + SPA Routing)
  # ---------------------------------------------------------------------------
  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.frontend.id}"

    # Use managed caching policy for static assets
    cache_policy_id            = local.cloudfront_cache_policies.optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id

    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    # Function associations for SPA routing
    dynamic "function_association" {
      for_each = var.enable_spa_routing ? [1] : []
      content {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.spa_routing[0].arn
      }
    }
  }

  # ---------------------------------------------------------------------------
  # BEHAVIOR: Static Assets with Long Cache
  # ---------------------------------------------------------------------------
  ordered_cache_behavior {
    path_pattern     = "/assets/*"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.frontend.id}"

    cache_policy_id            = local.cloudfront_cache_policies.optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id

    viewer_protocol_policy = "redirect-to-https"
    compress               = true
  }

  # ---------------------------------------------------------------------------
  # BEHAVIOR: Static Files (js, css, images)
  # ---------------------------------------------------------------------------
  ordered_cache_behavior {
    path_pattern     = "*.js"
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.frontend.id}"

    cache_policy_id            = local.cloudfront_cache_policies.optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id

    viewer_protocol_policy = "redirect-to-https"
    compress               = true
  }

  ordered_cache_behavior {
    path_pattern     = "*.css"
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.frontend.id}"

    cache_policy_id            = local.cloudfront_cache_policies.optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id

    viewer_protocol_policy = "redirect-to-https"
    compress               = true
  }

  # ---------------------------------------------------------------------------
  # CUSTOM ERROR RESPONSES (SPA ROUTING SUPPORT)
  # ---------------------------------------------------------------------------
  # 403 → index.html (for SPA client-side routing)
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  # 404 → index.html (for SPA client-side routing)
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  # ---------------------------------------------------------------------------
  # GEO RESTRICTIONS
  # ---------------------------------------------------------------------------
  restrictions {
    geo_restriction {
      restriction_type = var.geo_restriction_type
      locations        = var.geo_restriction_locations
    }
  }

  # ---------------------------------------------------------------------------
  # SSL CERTIFICATE
  # ---------------------------------------------------------------------------
  viewer_certificate {
    acm_certificate_arn            = var.acm_certificate_arn
    ssl_support_method             = var.acm_certificate_arn != null ? "sni-only" : null
    minimum_protocol_version       = var.acm_certificate_arn != null ? "TLSv1.2_2021" : null
    cloudfront_default_certificate = var.acm_certificate_arn == null
  }

  # ---------------------------------------------------------------------------
  # LOGGING
  # ---------------------------------------------------------------------------
  dynamic "logging_config" {
    for_each = var.enable_logging && var.log_bucket != null ? [1] : []
    content {
      bucket          = var.log_bucket
      prefix          = var.log_prefix != null ? var.log_prefix : "${var.project_name}/${var.environment}/cloudfront/"
      include_cookies = var.log_include_cookies
    }
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-cloudfront"
  })
}

# -----------------------------------------------------------------------------
# CLOUDFRONT FUNCTION FOR SPA ROUTING
# -----------------------------------------------------------------------------

resource "aws_cloudfront_function" "spa_routing" {
  count   = var.enable_spa_routing ? 1 : 0
  name    = "${var.project_name}-${var.environment}-spa-routing"
  runtime = "cloudfront-js-2.0"
  comment = "SPA routing - redirect all paths to index.html"
  publish = true
  code    = <<-EOF
function handler(event) {
    var request = event.request;
    var uri = request.uri;
    
    // Check if the URI has a file extension
    if (uri.includes('.')) {
        return request;
    }
    
    // Check if URI ends with /
    if (uri.endsWith('/') && uri !== '/') {
        request.uri = '/index.html';
        return request;
    }
    
    // For all other paths without extension, serve index.html
    // This enables client-side routing
    if (!uri.includes('.')) {
        request.uri = '/index.html';
    }
    
    return request;
}
EOF
}



# -----------------------------------------------------------------------------
# CLOUDFRONT INVALIDATION (Optional - for CI/CD)
# -----------------------------------------------------------------------------
# Note: Invalidations should be triggered by CI/CD after deployment
# This is just a placeholder showing how to do it programmatically

# -----------------------------------------------------------------------------
# ROUTE53 RECORD (Optional)
# -----------------------------------------------------------------------------

resource "aws_route53_record" "frontend" {
  count   = var.domain_name != null && var.route53_zone_id != null ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

# IPv6 record
resource "aws_route53_record" "frontend_ipv6" {
  count   = var.domain_name != null && var.route53_zone_id != null ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}
