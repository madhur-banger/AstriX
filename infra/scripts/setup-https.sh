#!/bin/bash

# ============================================
# AstriX HTTPS Setup - Automated Script
# ============================================

set -e  # Exit on error

echo "=========================================="
echo "   AstriX HTTPS Implementation"
echo "=========================================="
echo ""

# Configuration
PROJECT_DIR="$HOME/Desktop/AstriX"
INFRA_DIR="$PROJECT_DIR/infra"
ENV_DIR="$INFRA_DIR/environments/dev"
CERT_DIR="$INFRA_DIR/certificates"
AWS_REGION="us-east-1"
AWS_PROFILE="prod-terraform"

# Get ALB DNS from terraform outputs
cd "$ENV_DIR"
ALB_DNS=$(terraform output -raw alb_dns_name 2>/dev/null || echo "")

if [ -z "$ALB_DNS" ]; then
    echo "❌ Error: Could not get ALB DNS name from terraform outputs"
    echo "   Make sure terraform is initialized and applied"
    exit 1
fi

echo "✓ Found ALB DNS: $ALB_DNS"
echo ""

# ============================================
# Step 1: Generate Self-Signed Certificate
# ============================================

echo "Step 1: Generating self-signed certificate..."
echo ""

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

if [ -f "alb-certificate.pem" ] && [ -f "alb-private-key.pem" ]; then
    echo "⚠️  Certificate files already exist"
    read -p "   Regenerate? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "   Using existing certificate"
    else
        rm -f alb-certificate.pem alb-private-key.pem
    fi
fi

if [ ! -f "alb-certificate.pem" ]; then
    openssl req -x509 \
      -newkey rsa:4096 \
      -keyout alb-private-key.pem \
      -out alb-certificate.pem \
      -days 365 \
      -nodes \
      -subj "/CN=$ALB_DNS/O=AstriX Dev/C=US" \
      2>/dev/null
    
    echo "✓ Certificate generated"
else
    echo "✓ Using existing certificate"
fi

echo ""

# ============================================
# Step 2: Import Certificate to ACM
# ============================================

echo "Step 2: Importing certificate to ACM..."
echo ""

# Check if certificate already imported
EXISTING_CERT=$(aws acm list-certificates \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --query "CertificateSummaryList[?DomainName=='$ALB_DNS'].CertificateArn" \
  --output text 2>/dev/null || echo "")

if [ -n "$EXISTING_CERT" ]; then
    echo "⚠️  Certificate already exists in ACM"
    echo "   ARN: $EXISTING_CERT"
    CERT_ARN="$EXISTING_CERT"
else
    echo "Importing certificate to ACM..."
    CERT_ARN=$(aws acm import-certificate \
      --certificate fileb://alb-certificate.pem \
      --private-key fileb://alb-private-key.pem \
      --region "$AWS_REGION" \
      --profile "$AWS_PROFILE" \
      --query 'CertificateArn' \
      --output text)
    
    echo "✓ Certificate imported"
fi

echo "   ARN: $CERT_ARN"
echo ""

# ============================================
# Step 3: Update terraform.tfvars
# ============================================

echo "Step 3: Updating terraform.tfvars..."
echo ""

cd "$ENV_DIR"

# Backup existing tfvars.
#
# terraform.tfvars is plaintext secrets (Mongo URI, JWT secrets, Google OAuth
# client secret). Backups therefore go into a dedicated gitignored directory
# rather than sitting next to the original as terraform.tfvars.backup.<ts>,
# which the root .gitignore's `*.tfvars` pattern does NOT match. They are also
# pruned so copies of every secret this project has ever used don't pile up on
# disk forever.
BACKUP_DIR="$ENV_DIR/.tfvars-backups"
KEEP_BACKUPS=5

if [ -f "terraform.tfvars" ]; then
    mkdir -p "$BACKUP_DIR"
    chmod 700 "$BACKUP_DIR"
    BACKUP_FILE="$BACKUP_DIR/terraform.tfvars.backup.$(date +%Y%m%d_%H%M%S)"
    cp terraform.tfvars "$BACKUP_FILE"
    chmod 600 "$BACKUP_FILE"
    echo "✓ Backup created: $BACKUP_FILE"

    # Prune all but the $KEEP_BACKUPS most recent (newest first, drop the head)
    ls -1t "$BACKUP_DIR"/terraform.tfvars.backup.* 2>/dev/null \
        | tail -n +$((KEEP_BACKUPS + 1)) \
        | while read -r old; do
            rm -f "$old"
            echo "  pruned old backup: $(basename "$old")"
        done
fi

# Sweep up any stray backups from before this script wrote to $BACKUP_DIR.
for stray in "$ENV_DIR"/terraform.tfvars.backup.*; do
    [ -e "$stray" ] || continue
    rm -f "$stray"
    echo "  removed legacy plaintext backup: $(basename "$stray")"
done

# Update or add HTTPS configuration
if grep -q "enable_https" terraform.tfvars; then
    sed -i.bak "s/enable_https = .*/enable_https = true/" terraform.tfvars
    echo "✓ Updated enable_https"
else
    echo "" >> terraform.tfvars
    echo "# HTTPS Configuration" >> terraform.tfvars
    echo "enable_https = true" >> terraform.tfvars
    echo "✓ Added enable_https"
fi

if grep -q "alb_certificate_arn" terraform.tfvars; then
    sed -i.bak "s|alb_certificate_arn = .*|alb_certificate_arn = \"$CERT_ARN\"|" terraform.tfvars
    echo "✓ Updated alb_certificate_arn"
else
    echo "alb_certificate_arn = \"$CERT_ARN\"" >> terraform.tfvars
    echo "✓ Added alb_certificate_arn"
fi

if grep -q "redirect_http_to_https" terraform.tfvars; then
    sed -i.bak "s/redirect_http_to_https = .*/redirect_http_to_https = true/" terraform.tfvars
else
    echo "redirect_http_to_https = true" >> terraform.tfvars
    echo "✓ Added redirect_http_to_https"
fi

# Clean up backup files
rm -f terraform.tfvars.bak

echo ""

# ============================================
# Step 4: Terraform Plan
# ============================================

echo "Step 4: Running terraform plan..."
echo ""

terraform plan -out=tfplan

echo ""
read -p "Apply these changes? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted. You can apply later with: terraform apply tfplan"
    exit 0
fi

# ============================================
# Step 5: Terraform Apply
# ============================================

echo ""
echo "Step 5: Applying terraform changes..."
echo ""

terraform apply tfplan

echo ""
echo "✓ Terraform applied successfully"
echo ""

# Get new HTTPS URL
HTTPS_URL=$(terraform output -raw backend_api_url)

echo "=========================================="
echo "   HTTPS URL: $HTTPS_URL"
echo "=========================================="
echo ""

# ============================================
# Step 6: Update Parameter Store
# ============================================

echo "Step 6: Updating Parameter Store..."
echo ""

aws ssm put-parameter \
  --name "/astrix/dev/VITE_API_BASE_URL" \
  --value "$HTTPS_URL" \
  --type String \
  --overwrite \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION"
echo "✓ Updated VITE_API_BASE_URL"

aws ssm put-parameter \
  --name "/astrix/dev/GOOGLE_CALLBACK_URL" \
  --value "${HTTPS_URL%/api}/api/auth/google/callback" \
  --type String \
  --overwrite \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION"
echo "✓ Updated GOOGLE_CALLBACK_URL"

aws ssm put-parameter \
  --name "/astrix/dev/COOKIE_DOMAIN" \
  --value "$ALB_DNS" \
  --type String \
  --overwrite \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION"
echo "✓ Updated COOKIE_DOMAIN"

echo ""

# ============================================
# Step 7: Test HTTPS Endpoint
# ============================================

echo "Step 7: Testing HTTPS endpoint..."
echo ""

HTTP_CODE=$(curl -k -s -o /dev/null -w "%{http_code}" "$HTTPS_URL/../health" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ HTTPS endpoint is working! (HTTP $HTTP_CODE)"
else
    echo "⚠️  HTTPS endpoint returned HTTP $HTTP_CODE"
    echo "   This may be normal if ECS tasks are still starting"
fi

echo ""

# ============================================
# Next Steps
# ============================================

echo "=========================================="
echo "   Setup Complete! 🎉"
echo "=========================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Update Google OAuth Console:"
echo "   https://console.cloud.google.com/apis/credentials"
echo ""
echo "   Authorized redirect URIs:"
echo "   ${HTTPS_URL%/api}/api/auth/google/callback"
echo ""
echo "2. Update backend code (set secure: true in cookies)"
echo ""
echo "3. Rebuild and deploy backend:"
echo "   cd $PROJECT_DIR/server"
echo "   docker build -t astrix-backend ."
echo "   # ... push to ECR and deploy"
echo ""
echo "4. Update frontend .env:"
echo "   cd $PROJECT_DIR/client"
echo "   echo \"VITE_API_BASE_URL=$HTTPS_URL\" > .env"
echo ""
echo "5. Build and deploy frontend:"
echo "   npm run build"
echo "   aws s3 sync dist/ s3://astrix-dev-frontend/ --delete"
echo "   aws cloudfront create-invalidation --distribution-id E3GULDN2CAM1JB --paths '/*'"
echo ""
echo "=========================================="
echo ""
echo "Certificate ARN saved to: terraform.tfvars"
echo "Certificate files in: $CERT_DIR"
echo ""
echo "HTTPS URL: $HTTPS_URL"
echo ""