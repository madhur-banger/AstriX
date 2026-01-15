# =============================================================================
# BOOTSTRAP CONFIGURATION
# =============================================================================
# This file handles the initial setup that requires ordering:
# 1. Build and push Docker image to ECR (required before ECS can start)
# 2. Update Parameter Store with real URLs (after infrastructure is created)
# 3. Force ECS redeployment to pick up new environment variables
#
# CORRECT ARCHITECTURE:
#   Browser → CloudFront → S3 (Frontend)
#   Browser → ALB → ECS (Backend API)  ← Direct, NOT through CloudFront!
# =============================================================================

# -----------------------------------------------------------------------------
# LOCAL VALUES FOR URL COMPUTATION
# -----------------------------------------------------------------------------

locals {
  # Frontend URL: CloudFront (for React SPA)
  computed_frontend_url = var.frontend_domain_name != null ? "https://${var.frontend_domain_name}" : "https://${module.cloudfront_s3.distribution_domain_name}"
  
  # Protocol based on HTTPS enablement
  alb_protocol = var.enable_https ? "https" : "http"


  # API URL: Direct to ALB - NOW RESPECTS HTTPS SETTING!
  computed_api_url = "${local.alb_protocol}://${module.alb.alb_dns_name}/api"
  
  # Cookie domain - CloudFront domain as requested
  computed_cookie_domain = var.frontend_domain_name != null ? var.frontend_domain_name : module.cloudfront_s3.distribution_domain_name
  
   # Google OAuth callback URL - goes to ALB directly - NOW RESPECTS HTTPS!
  computed_google_callback_url = "${local.alb_protocol}://${module.alb.alb_dns_name}/api/auth/google/callback"
  
  # Frontend Google callback URL - CloudFront (where user lands after OAuth)
  computed_frontend_google_callback_url = "${local.computed_frontend_url}/google/callback"

  # Flag to determine if we should use computed URLs or placeholders
  use_computed_urls = var.enable_url_auto_update
}

# -----------------------------------------------------------------------------
# INITIAL DOCKER IMAGE BUILD & PUSH
# -----------------------------------------------------------------------------
# This runs ONCE when ECR is created to push the initial image
# Subsequent pushes are handled by CI/CD

resource "null_resource" "initial_docker_push" {
  count = var.enable_initial_docker_push ? 1 : 0

  # Only run when ECR repository is created
  triggers = {
    ecr_repository_url = module.ecr.backend_repository_url
  }

  provisioner "local-exec" {
    working_dir = path.root
    interpreter = ["/bin/bash", "-c"]
    
    command = <<-EOT
      set -e
      
      echo "=========================================="
      echo "Building and pushing initial Docker image"
      echo "=========================================="
      
      # Get ECR login
      echo "Logging into ECR..."
      aws ecr get-login-password --region ${var.aws_region} --profile ${var.aws_profile} | \
        docker login --username AWS --password-stdin ${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com
      
      # Build the image
      echo "Building Docker image..."
      cd ../../../backend
      docker buildx build --platform linux/amd64 \
        -t ${module.ecr.backend_repository_url}:latest \
        -t ${module.ecr.backend_repository_url}:initial \
        --build-arg NODE_ENV=production \
        --build-arg BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
        --push \
        .
      
      # Push to ECR
      echo "Pushing image to ECR..."
      docker push ${module.ecr.backend_repository_url}:latest
      
      # Also tag with 'initial' for reference
      docker tag ${module.ecr.backend_repository_url}:latest ${module.ecr.backend_repository_url}:initial
      docker push ${module.ecr.backend_repository_url}:initial
      
      echo "=========================================="
      echo "Initial Docker image pushed successfully!"
      echo "=========================================="
    EOT
  }

  depends_on = [module.ecr]
}

# -----------------------------------------------------------------------------
# URL UPDATE AFTER INFRASTRUCTURE CREATION
# -----------------------------------------------------------------------------
# This updates Parameter Store with the real URLs after ALB and CloudFront are created

resource "null_resource" "update_urls" {
  count = var.enable_url_auto_update ? 1 : 0

  # Re-run when CloudFront or ALB changes
  triggers = {
    cloudfront_domain = module.cloudfront_s3.distribution_domain_name
    alb_dns           = module.alb.alb_dns_name
    frontend_url      = local.computed_frontend_url
    api_url           = local.computed_api_url
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    
    command = <<-EOT
      set -e
      
      echo "=========================================="
      echo "Updating Parameter Store with real URLs"
      echo "=========================================="
      echo ""
      echo "ARCHITECTURE:"
      echo "  Frontend: CloudFront → S3"
      echo "  Backend:  ALB → ECS (Direct, not through CloudFront!)"
      echo ""
      
      PROFILE="${var.aws_profile}"
      REGION="${var.aws_region}"
      PROJECT="${var.project_name}"
      ENV="${var.environment}"
      
      FRONTEND_URL="${local.computed_frontend_url}"
      API_URL="${local.computed_api_url}"
      COOKIE_DOMAIN="${local.computed_cookie_domain}"
      GOOGLE_CALLBACK="${local.computed_google_callback_url}"
      FRONTEND_GOOGLE_CALLBACK="${local.computed_frontend_google_callback_url}"
      
      echo "Frontend URL (CloudFront): $FRONTEND_URL"
      echo "API URL (ALB Direct):      $API_URL"
      echo "Cookie Domain:             $COOKIE_DOMAIN"
      echo "Google Callback (ALB):     $GOOGLE_CALLBACK"
      echo "Frontend Google Callback:  $FRONTEND_GOOGLE_CALLBACK"
      echo ""
      
      # Update FRONTEND_ORIGIN (CloudFront - for CORS)
      echo "Updating FRONTEND_ORIGIN..."
      aws ssm put-parameter \
        --name "/$PROJECT/$ENV/FRONTEND_ORIGIN" \
        --value "$FRONTEND_URL" \
        --type String \
        --overwrite \
        --region "$REGION" \
        --profile "$PROFILE"
      
      # Update VITE_API_BASE_URL (ALB - for frontend API calls)
      echo "Updating VITE_API_BASE_URL..."
      aws ssm put-parameter \
        --name "/$PROJECT/$ENV/VITE_API_BASE_URL" \
        --value "$API_URL" \
        --type String \
        --overwrite \
        --region "$REGION" \
        --profile "$PROFILE"
      
      # Update GOOGLE_CALLBACK_URL (ALB - where Google redirects)
      echo "Updating GOOGLE_CALLBACK_URL..."
      aws ssm put-parameter \
        --name "/$PROJECT/$ENV/GOOGLE_CALLBACK_URL" \
        --value "$GOOGLE_CALLBACK" \
        --type String \
        --overwrite \
        --region "$REGION" \
        --profile "$PROFILE"
      
      # Update FRONTEND_GOOGLE_CALLBACK_URL (CloudFront - where user lands after OAuth)
      echo "Updating FRONTEND_GOOGLE_CALLBACK_URL..."
      aws ssm put-parameter \
        --name "/$PROJECT/$ENV/FRONTEND_GOOGLE_CALLBACK_URL" \
        --value "$FRONTEND_GOOGLE_CALLBACK" \
        --type String \
        --overwrite \
        --region "$REGION" \
        --profile "$PROFILE"
      
      # Update COOKIE_DOMAIN (ALB domain)
      echo "Updating COOKIE_DOMAIN..."
      aws ssm put-parameter \
        --name "/$PROJECT/$ENV/COOKIE_DOMAIN" \
        --value "$COOKIE_DOMAIN" \
        --type String \
        --overwrite \
        --region "$REGION" \
        --profile "$PROFILE"
      
      echo ""
      echo "=========================================="
      echo "Parameter Store updated successfully!"
      echo "=========================================="
    EOT
  }

  depends_on = [
    module.cloudfront_s3,
    module.alb,
    module.parameter_store
  ]
}

# -----------------------------------------------------------------------------
# FORCE ECS REDEPLOYMENT
# -----------------------------------------------------------------------------
# After URLs are updated, force ECS to redeploy so containers pick up new values

resource "null_resource" "force_ecs_redeploy" {
  count = var.enable_url_auto_update ? 1 : 0

  # Re-run when URLs are updated
  triggers = {
    url_update_id = null_resource.update_urls[0].id
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    
    command = <<-EOT
      set -e
      
      echo "=========================================="
      echo "Forcing ECS service redeployment"
      echo "=========================================="
      
      # Wait a moment for Parameter Store to propagate
      sleep 5
      
      # Force new deployment
      aws ecs update-service \
        --cluster ${module.ecs.cluster_name} \
        --service ${module.ecs.service_name} \
        --force-new-deployment \
        --region ${var.aws_region} \
        --profile ${var.aws_profile}
      
      echo "ECS redeployment initiated!"
      echo "Run the following to monitor:"
      echo "aws ecs describe-services --cluster ${module.ecs.cluster_name} --services ${module.ecs.service_name} --profile ${var.aws_profile}"
      echo "=========================================="
    EOT
  }

  depends_on = [
    null_resource.update_urls,
    module.ecs
  ]
}

# -----------------------------------------------------------------------------
# OUTPUTS - COMPUTED URLS (CORRECT ARCHITECTURE)
# -----------------------------------------------------------------------------

output "computed_urls" {
  description = "Computed URLs for the deployed infrastructure (Correct Architecture)"
  value = {
    architecture = "Frontend on CloudFront, API on ALB (Direct)"
    
    frontend_url                  = local.computed_frontend_url
    api_url                       = local.computed_api_url
    cookie_domain                 = local.computed_cookie_domain
    google_callback_url           = local.computed_google_callback_url
    frontend_google_callback_url  = local.computed_frontend_google_callback_url
    
    google_console_update = {
      message = "Update these in Google Cloud Console > APIs & Services > Credentials"
      authorized_javascript_origins = [
        local.computed_frontend_url,
        "http://${module.alb.alb_dns_name}"
      ]
      authorized_redirect_uris = [local.computed_google_callback_url]
    }
    
    note = "API calls go directly to ALB, NOT through CloudFront. This is correct for proper cookie/auth handling."
  }
}
