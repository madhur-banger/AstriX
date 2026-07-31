#!/bin/bash
# =============================================================================
# DOCKER BUILD & PUSH TO ECR - Backend Deployment Script
# =============================================================================
# This script builds your backend Docker image and pushes it to ECR.
# Run this script from the project root directory.
#
# Prerequisites:
# - AWS CLI configured with prod-terraform profile
# - Docker installed and running
# - Terraform infrastructure deployed (ECR repository exists)
#
# Usage:
#   ./infra/scripts/push-backend-image.sh [tag]
#
# Examples:
#   ./infra/scripts/push-backend-image.sh          # Push as 'latest'
#   ./infra/scripts/push-backend-image.sh v1.0.0   # Push with version tag
# =============================================================================

set -e  # Exit on error
set -u  # Exit on undefined variable

# -----------------------------------------------------------------------------
# CONFIGURATION
# -----------------------------------------------------------------------------

AWS_PROFILE="${AWS_PROFILE:-prod-terraform}"
AWS_REGION="${AWS_REGION:-us-east-1}"
PROJECT_NAME="astrix"
ENVIRONMENT="dev"
IMAGE_TAG="${1:-latest}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# -----------------------------------------------------------------------------
# HELPER FUNCTIONS
# -----------------------------------------------------------------------------

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    if ! command -v $1 &> /dev/null; then
        log_error "$1 is not installed. Please install it first."
        exit 1
    fi
}

# -----------------------------------------------------------------------------
# PRE-FLIGHT CHECKS
# -----------------------------------------------------------------------------

log_info "Starting pre-flight checks..."

# Check required commands
check_command aws
check_command docker
check_command jq

# Check Docker is running
if ! docker info > /dev/null 2>&1; then
    log_error "Docker is not running. Please start Docker Desktop."
    exit 1
fi
log_success "Docker is running"

# Check AWS credentials
if ! aws sts get-caller-identity --profile $AWS_PROFILE > /dev/null 2>&1; then
    log_error "AWS credentials not configured for profile: $AWS_PROFILE"
    log_info "Run: aws sso login --profile $AWS_PROFILE"
    exit 1
fi
log_success "AWS credentials verified"

# Get AWS Account ID
ACCOUNT_ID=$(aws sts get-caller-identity --profile $AWS_PROFILE --query Account --output text)
log_info "AWS Account ID: $ACCOUNT_ID"

# Check if we're in the project root
if [ ! -f "backend/Dockerfile" ]; then
    log_error "backend/Dockerfile not found. Are you in the project root?"
    exit 1
fi
log_success "Dockerfile found"

# -----------------------------------------------------------------------------
# ECR CONFIGURATION
# -----------------------------------------------------------------------------

ECR_REPOSITORY_NAME="${PROJECT_NAME}-${ENVIRONMENT}-backend"
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
ECR_REPOSITORY_URI="${ECR_REGISTRY}/${ECR_REPOSITORY_NAME}"

log_info "ECR Repository: $ECR_REPOSITORY_URI"

# Check if ECR repository exists
if ! aws ecr describe-repositories \
    --repository-names $ECR_REPOSITORY_NAME \
    --region $AWS_REGION \
    --profile $AWS_PROFILE > /dev/null 2>&1; then
    log_error "ECR repository '$ECR_REPOSITORY_NAME' not found"
    log_info "Run terraform apply in infra/environments/dev first"
    exit 1
fi
log_success "ECR repository exists"

# -----------------------------------------------------------------------------
# DOCKER LOGIN
# -----------------------------------------------------------------------------

log_info "Authenticating Docker with ECR..."

aws ecr get-login-password \
    --region $AWS_REGION \
    --profile $AWS_PROFILE | \
    docker login \
    --username AWS \
    --password-stdin $ECR_REGISTRY

if [ $? -eq 0 ]; then
    log_success "Docker authenticated with ECR"
else
    log_error "Failed to authenticate Docker with ECR"
    exit 1
fi

# -----------------------------------------------------------------------------
# BUILD DOCKER IMAGE
# -----------------------------------------------------------------------------

log_info "Building Docker image..."
log_info "Image will be tagged as: ${ECR_REPOSITORY_URI}:${IMAGE_TAG}"

cd backend

# Build with buildkit for better caching and performance
DOCKER_BUILDKIT=1 docker build \
    --platform linux/amd64 \
    --tag "${ECR_REPOSITORY_URI}:${IMAGE_TAG}" \
    --tag "${ECR_REPOSITORY_URI}:latest" \
    --build-arg NODE_ENV=production \
    --file Dockerfile \
    .

if [ $? -eq 0 ]; then
    log_success "Docker image built successfully"
else
    log_error "Failed to build Docker image"
    exit 1
fi

cd ..

# Get image size
IMAGE_SIZE=$(docker images "${ECR_REPOSITORY_URI}:${IMAGE_TAG}" --format "{{.Size}}")
log_info "Image size: $IMAGE_SIZE"

# -----------------------------------------------------------------------------
# PUSH TO ECR
# -----------------------------------------------------------------------------

log_info "Pushing image to ECR..."
log_warning "This may take 2-5 minutes depending on image size and network speed"

# Push the specified tag
docker push "${ECR_REPOSITORY_URI}:${IMAGE_TAG}"

if [ $? -ne 0 ]; then
    log_error "Failed to push image with tag: $IMAGE_TAG"
    exit 1
fi

# Also push 'latest' tag if we're not already pushing 'latest'
if [ "$IMAGE_TAG" != "latest" ]; then
    log_info "Also pushing 'latest' tag..."
    docker push "${ECR_REPOSITORY_URI}:latest"
fi

log_success "Image pushed to ECR successfully"

# -----------------------------------------------------------------------------
# VERIFICATION
# -----------------------------------------------------------------------------

log_info "Verifying image in ECR..."

IMAGE_DETAILS=$(aws ecr describe-images \
    --repository-name $ECR_REPOSITORY_NAME \
    --image-ids imageTag=$IMAGE_TAG \
    --region $AWS_REGION \
    --profile $AWS_PROFILE \
    --output json)

if [ $? -eq 0 ]; then
    IMAGE_DIGEST=$(echo $IMAGE_DETAILS | jq -r '.imageDetails[0].imageDigest')
    IMAGE_PUSHED_AT=$(echo $IMAGE_DETAILS | jq -r '.imageDetails[0].imagePushedAt')
    IMAGE_SIZE_BYTES=$(echo $IMAGE_DETAILS | jq -r '.imageDetails[0].imageSizeInBytes')
    IMAGE_SIZE_MB=$(echo "scale=2; $IMAGE_SIZE_BYTES / 1024 / 1024" | bc)
    
    log_success "Image verified in ECR"
    echo ""
    echo "📦 Image Details:"
    echo "   Repository: $ECR_REPOSITORY_URI"
    echo "   Tag: $IMAGE_TAG"
    echo "   Digest: ${IMAGE_DIGEST:0:20}..."
    echo "   Size: ${IMAGE_SIZE_MB} MB"
    echo "   Pushed At: $IMAGE_PUSHED_AT"
    echo ""
else
    log_warning "Could not verify image (it may still have been pushed successfully)"
fi

# -----------------------------------------------------------------------------
# CLEANUP (Optional)
# -----------------------------------------------------------------------------

log_info "Cleaning up local Docker images..."
docker image prune -f > /dev/null 2>&1
log_success "Cleanup complete"

# -----------------------------------------------------------------------------
# SUMMARY
# -----------------------------------------------------------------------------

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "✅ DEPLOYMENT SUCCESSFUL"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "Image URI (for ECS):"
echo "  ${ECR_REPOSITORY_URI}:${IMAGE_TAG}"
echo ""
echo "Next Steps:"
echo "  1. Deploy ECS infrastructure: cd infra/environments/dev && terraform apply"
echo "  2. ECS will automatically pull this image"
echo "  3. Check ECS service logs after deployment"
echo ""
echo "Useful Commands:"
echo "  # List all images in ECR"
echo "  aws ecr describe-images --repository-name $ECR_REPOSITORY_NAME --profile $AWS_PROFILE"
echo ""
echo "  # Delete an image"
echo "  aws ecr batch-delete-image --repository-name $ECR_REPOSITORY_NAME --image-ids imageTag=$IMAGE_TAG --profile $AWS_PROFILE"
echo ""
echo "═══════════════════════════════════════════════════════════════════"