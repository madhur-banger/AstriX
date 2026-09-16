#!/bin/bash
# =============================================================================
# INITIAL SETUP SCRIPT
# =============================================================================
# This script performs the initial setup of your infrastructure.
# Run this ONCE when setting up a new environment.
#
# What it does:
# 1. Validates prerequisites
# 2. Runs terraform apply
# 3. Updates Parameter Store with real URLs
# 4. Forces ECS redeployment
# 5. Displays next steps
#
# Usage:
#   ./initial-setup.sh [environment] [aws-profile]
#   ./initial-setup.sh dev prod-terraform
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ENVIRONMENT="${1:-dev}"
AWS_PROFILE="${2:-prod-terraform}"
PROJECT_NAME="astrix"
AWS_REGION="us-east-1"

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}   AstriX Infrastructure Setup${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""
echo -e "Environment: ${GREEN}${ENVIRONMENT}${NC}"
echo -e "AWS Profile: ${GREEN}${AWS_PROFILE}${NC}"
echo -e "AWS Region:  ${GREEN}${AWS_REGION}${NC}"
echo ""

# -----------------------------------------------------------------------------
# STEP 0: PREREQUISITES CHECK
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Step 0: Checking prerequisites...${NC}"

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI not found. Please install it first.${NC}"
    exit 1
fi
echo -e "  ✓ AWS CLI found"

# Check Terraform
if ! command -v terraform &> /dev/null; then
    echo -e "${RED}❌ Terraform not found. Please install it first.${NC}"
    exit 1
fi
echo -e "  ✓ Terraform found"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker not found. Please install it first.${NC}"
    exit 1
fi
echo -e "  ✓ Docker found"

# Check jq
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}⚠️  jq not found. Installing...${NC}"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install jq
    else
        sudo apt-get install -y jq
    fi
fi
echo -e "  ✓ jq found"

# Check AWS credentials
if ! aws sts get-caller-identity --profile "$AWS_PROFILE" &> /dev/null; then
    echo -e "${RED}❌ AWS credentials not valid for profile: ${AWS_PROFILE}${NC}"
    echo "   Please configure your AWS credentials."
    exit 1
fi
echo -e "  ✓ AWS credentials valid"

# Check if we're in the right directory
if [ ! -f "terraform.tfvars" ]; then
    echo -e "${RED}❌ terraform.tfvars not found.${NC}"
    echo "   Please run this script from: infra/environments/${ENVIRONMENT}/"
    exit 1
fi
echo -e "  ✓ In correct directory"

echo -e "${GREEN}All prerequisites met!${NC}"
echo ""

# -----------------------------------------------------------------------------
# STEP 1: TERRAFORM INIT
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Step 1: Initializing Terraform...${NC}"
terraform init

echo ""

# -----------------------------------------------------------------------------
# STEP 2: TERRAFORM PLAN (Optional review)
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Step 2: Running Terraform plan...${NC}"
terraform plan -out=tfplan

echo ""
read -p "Review the plan above. Continue with apply? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Aborted.${NC}"
    exit 1
fi

# -----------------------------------------------------------------------------
# STEP 3: TERRAFORM APPLY
# -----------------------------------------------------------------------------
echo ""
echo -e "${YELLOW}Step 3: Applying Terraform configuration...${NC}"
echo "This will create all infrastructure and:"
echo "  - Build and push initial Docker image to ECR"
echo "  - Update Parameter Store with real URLs"
echo "  - Force ECS redeployment"
echo ""

terraform apply tfplan

echo ""
echo -e "${GREEN}Terraform apply completed!${NC}"

# -----------------------------------------------------------------------------
# STEP 4: GET OUTPUTS
# -----------------------------------------------------------------------------
echo ""
echo -e "${YELLOW}Step 4: Retrieving outputs...${NC}"

# Get CloudFront URL
CLOUDFRONT_DOMAIN=$(terraform output -raw cloudfront_domain_name 2>/dev/null || echo "")
FRONTEND_URL=$(terraform output -raw frontend_url 2>/dev/null || echo "")
API_URL=$(terraform output -json computed_urls 2>/dev/null | jq -r '.api_url' || echo "")
ALB_URL=$(terraform output -raw backend_api_url 2>/dev/null || echo "")

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}   Infrastructure Deployed Successfully!${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
echo -e "${BLUE}URLs:${NC}"
echo -e "  Frontend:    ${GREEN}${FRONTEND_URL}${NC}"
echo -e "  API:         ${GREEN}${API_URL}${NC}"
echo -e "  ALB Direct:  ${GREEN}${ALB_URL}${NC}"
echo ""

# -----------------------------------------------------------------------------
# STEP 5: GOOGLE OAUTH UPDATE REMINDER
# -----------------------------------------------------------------------------
echo -e "${YELLOW}=========================================${NC}"
echo -e "${YELLOW}   IMPORTANT: Update Google OAuth${NC}"
echo -e "${YELLOW}=========================================${NC}"
echo ""
echo "Update these in Google Cloud Console:"
echo "Go to: APIs & Services > Credentials > Your OAuth 2.0 Client"
echo ""
echo -e "${BLUE}Authorized JavaScript origins:${NC}"
echo "  ${FRONTEND_URL}"
echo ""
echo -e "${BLUE}Authorized redirect URIs:${NC}"
echo "  ${API_URL}/auth/google/callback"
echo ""

# -----------------------------------------------------------------------------
# STEP 6: NEXT STEPS
# -----------------------------------------------------------------------------
echo -e "${YELLOW}=========================================${NC}"
echo -e "${YELLOW}   Next Steps${NC}"
echo -e "${YELLOW}=========================================${NC}"
echo ""
echo "1. Update Google OAuth credentials (see above)"
echo ""
echo "2. Deploy your frontend:"
echo -e "   ${BLUE}cd ../../../client${NC}"
echo -e "   ${BLUE}npm run build${NC}"
echo -e "   ${BLUE}aws s3 sync dist/ s3://${PROJECT_NAME}-${ENVIRONMENT}-frontend/ --delete --profile ${AWS_PROFILE}${NC}"
echo ""
echo "3. Invalidate CloudFront cache:"
CLOUDFRONT_ID=$(terraform output -raw cloudfront_distribution_id 2>/dev/null || echo "")
echo -e "   ${BLUE}aws cloudfront create-invalidation --distribution-id ${CLOUDFRONT_ID} --paths '/*' --profile ${AWS_PROFILE}${NC}"
echo ""
echo "4. Test your deployment:"
echo -e "   ${BLUE}curl ${FRONTEND_URL}${NC}"
echo -e "   ${BLUE}curl ${API_URL}/health${NC}"
echo ""
echo "5. Set up CI/CD (if not already done):"
echo "   - Add AWS_ACCOUNT_ID to GitHub Secrets"
echo "   - Enable GitHub OIDC in terraform.tfvars (create_github_oidc = true)"
echo "   - Run terraform apply again"
echo ""
echo -e "${GREEN}Setup complete! 🎉${NC}"

# Cleanup
rm -f tfplan
