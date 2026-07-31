#!/bin/bash
# =============================================================================
# FRONTEND DEPLOYMENT SCRIPT
# =============================================================================
# This script deploys the React frontend to S3 and invalidates CloudFront cache.
#
# Usage:
#   ./deploy-frontend.sh [OPTIONS]
#
# Options:
#   -e, --env        Environment (dev, staging, prod). Default: dev
#   -p, --profile    AWS profile. Default: prod-terraform
#   -d, --dist-dir   Build output directory. Default: dist
#   -s, --skip-build Skip npm build step
#   -h, --help       Show this help message
#
# Examples:
#   ./deploy-frontend.sh                     # Deploy dev with build
#   ./deploy-frontend.sh -e prod             # Deploy prod
#   ./deploy-frontend.sh -s                  # Deploy without rebuilding
#   ./deploy-frontend.sh -e staging -s       # Deploy staging without build
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="dev"
AWS_PROFILE="prod-terraform"
DIST_DIR="dist"
SKIP_BUILD=false
FRONTEND_DIR=""

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Print colored message
print_message() {
    local color=$1
    local message=$2
    echo -e "${color}${message}${NC}"
}

# Print usage
usage() {
    head -30 "$0" | tail -27
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -e|--env)
            ENVIRONMENT="$2"
            shift 2
            ;;
        -p|--profile)
            AWS_PROFILE="$2"
            shift 2
            ;;
        -d|--dist-dir)
            DIST_DIR="$2"
            shift 2
            ;;
        -s|--skip-build)
            SKIP_BUILD=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            print_message "$RED" "Unknown option: $1"
            usage
            ;;
    esac
done

# Find frontend directory
if [ -d "$PROJECT_ROOT/frontend" ]; then
    FRONTEND_DIR="$PROJECT_ROOT/frontend"
elif [ -d "$PROJECT_ROOT/client" ]; then
    FRONTEND_DIR="$PROJECT_ROOT/client"
elif [ -d "$PROJECT_ROOT/web" ]; then
    FRONTEND_DIR="$PROJECT_ROOT/web"
else
    print_message "$RED" "Error: Could not find frontend directory (frontend/, client/, or web/)"
    exit 1
fi

print_message "$BLUE" "╔═══════════════════════════════════════════════════════════════╗"
print_message "$BLUE" "║           Frontend Deployment Script                          ║"
print_message "$BLUE" "╚═══════════════════════════════════════════════════════════════╝"

echo ""
print_message "$YELLOW" "Configuration:"
echo "  Environment:  $ENVIRONMENT"
echo "  AWS Profile:  $AWS_PROFILE"
echo "  Frontend Dir: $FRONTEND_DIR"
echo "  Dist Dir:     $DIST_DIR"
echo "  Skip Build:   $SKIP_BUILD"
echo ""

# Get Terraform outputs
TERRAFORM_DIR="$PROJECT_ROOT/infra/environments/$ENVIRONMENT"

if [ ! -d "$TERRAFORM_DIR" ]; then
    print_message "$RED" "Error: Environment directory not found: $TERRAFORM_DIR"
    exit 1
fi

print_message "$BLUE" "📦 Fetching Terraform outputs..."
cd "$TERRAFORM_DIR"

# Get bucket name
BUCKET_NAME=$(terraform output -raw frontend_bucket_id 2>/dev/null) || {
    print_message "$RED" "Error: Could not get frontend_bucket_id from Terraform output"
    print_message "$YELLOW" "Make sure you've run 'terraform apply' first"
    exit 1
}

# Get CloudFront distribution ID
DISTRIBUTION_ID=$(terraform output -raw cloudfront_distribution_id 2>/dev/null) || {
    print_message "$RED" "Error: Could not get cloudfront_distribution_id from Terraform output"
    exit 1
}

# Get frontend URL
FRONTEND_URL=$(terraform output -raw frontend_url 2>/dev/null) || {
    FRONTEND_URL="(unknown)"
}

echo "  S3 Bucket:        $BUCKET_NAME"
echo "  Distribution ID:  $DISTRIBUTION_ID"
echo "  Frontend URL:     $FRONTEND_URL"
echo ""

# Build step
if [ "$SKIP_BUILD" = false ]; then
    print_message "$BLUE" "🔨 Building frontend..."
    cd "$FRONTEND_DIR"
    
    # Check if node_modules exists
    if [ ! -d "node_modules" ]; then
        print_message "$YELLOW" "Installing dependencies..."
        npm install
    fi
    
    # Run build
    npm run build
    
    if [ ! -d "$DIST_DIR" ]; then
        print_message "$RED" "Error: Build directory not found: $FRONTEND_DIR/$DIST_DIR"
        print_message "$YELLOW" "Check your build configuration"
        exit 1
    fi
    
    print_message "$GREEN" "✓ Build completed"
else
    print_message "$YELLOW" "⏭️  Skipping build step"
    cd "$FRONTEND_DIR"
fi

# Check dist directory
if [ ! -d "$DIST_DIR" ]; then
    print_message "$RED" "Error: Distribution directory not found: $FRONTEND_DIR/$DIST_DIR"
    exit 1
fi

# Count files
FILE_COUNT=$(find "$DIST_DIR" -type f | wc -l)
print_message "$BLUE" "📁 Found $FILE_COUNT files to upload"
echo ""

# Sync to S3
print_message "$BLUE" "☁️  Syncing to S3..."

# Sync HTML files with no-cache
aws s3 sync "$DIST_DIR" "s3://$BUCKET_NAME" \
    --delete \
    --profile "$AWS_PROFILE" \
    --exclude "*" \
    --include "*.html" \
    --cache-control "no-cache, no-store, must-revalidate"

# Sync JS/CSS files with long cache (they have hash in filename)
aws s3 sync "$DIST_DIR" "s3://$BUCKET_NAME" \
    --delete \
    --profile "$AWS_PROFILE" \
    --exclude "*.html" \
    --include "*.js" \
    --include "*.css" \
    --cache-control "max-age=31536000, public, immutable"

# Sync everything else with moderate cache
aws s3 sync "$DIST_DIR" "s3://$BUCKET_NAME" \
    --delete \
    --profile "$AWS_PROFILE" \
    --exclude "*.html" \
    --exclude "*.js" \
    --exclude "*.css" \
    --cache-control "max-age=86400, public"

print_message "$GREEN" "✓ S3 sync completed"
echo ""

# Invalidate CloudFront cache
print_message "$BLUE" "🔄 Invalidating CloudFront cache..."

INVALIDATION_ID=$(aws cloudfront create-invalidation \
    --distribution-id "$DISTRIBUTION_ID" \
    --paths "/*" \
    --profile "$AWS_PROFILE" \
    --query 'Invalidation.Id' \
    --output text)

print_message "$GREEN" "✓ Invalidation created: $INVALIDATION_ID"
echo ""

# Wait for invalidation (optional)
print_message "$BLUE" "⏳ Waiting for invalidation to complete..."
aws cloudfront wait invalidation-completed \
    --distribution-id "$DISTRIBUTION_ID" \
    --id "$INVALIDATION_ID" \
    --profile "$AWS_PROFILE" 2>/dev/null || {
    print_message "$YELLOW" "⚠️  Invalidation still in progress (this is normal)"
    print_message "$YELLOW" "   Check status: aws cloudfront get-invalidation --distribution-id $DISTRIBUTION_ID --id $INVALIDATION_ID --profile $AWS_PROFILE"
}

echo ""
print_message "$GREEN" "╔═══════════════════════════════════════════════════════════════╗"
print_message "$GREEN" "║                   Deployment Complete! 🚀                      ║"
print_message "$GREEN" "╚═══════════════════════════════════════════════════════════════╝"
echo ""
print_message "$GREEN" "Frontend URL: $FRONTEND_URL"
echo ""
print_message "$YELLOW" "Note: CloudFront may take a few minutes to propagate changes globally."
echo ""