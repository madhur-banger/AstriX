#!/bin/bash
# =============================================================================
# UPDATE URLS SCRIPT (CORRECT ARCHITECTURE)
# =============================================================================
# Updates Parameter Store with the correct URLs:
# - Frontend: CloudFront (for React SPA - static content)
# - Backend API: ALB directly (NOT through CloudFront - dynamic content)
#
# CORRECT Architecture:
#   Browser
#      ├── https://d1234.cloudfront.net     → S3 (React)
#      └── http://alb-xxx.elb.amazonaws.com → ECS (API)
#
# Why NOT put API behind CloudFront:
# 1. CloudFront caches responses - can leak auth cookies to other users
# 2. CloudFront normalizes/strips headers - breaks auth flows
# 3. CloudFront is for static content, ALB is for dynamic APIs
#
# Usage:
#   ./update-urls.sh [environment] [aws-profile]
#   ./update-urls.sh dev prod-terraform
# =============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
ENVIRONMENT="${1:-dev}"
AWS_PROFILE="${2:-prod-terraform}"
PROJECT_NAME="astrix"
AWS_REGION="us-east-1"

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}   Update Parameter Store URLs${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""
echo -e "Environment: ${GREEN}${ENVIRONMENT}${NC}"
echo -e "AWS Profile: ${GREEN}${AWS_PROFILE}${NC}"
echo ""

# -----------------------------------------------------------------------------
# GET CLOUDFRONT DOMAIN (for Frontend)
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Getting CloudFront distribution (Frontend)...${NC}"

CLOUDFRONT_DOMAIN=$(aws cloudfront list-distributions \
    --profile "$AWS_PROFILE" \
    --query "DistributionList.Items[?contains(Origins.Items[0].DomainName, '${PROJECT_NAME}-${ENVIRONMENT}')].DomainName" \
    --output text | head -1)

if [ -z "$CLOUDFRONT_DOMAIN" ] || [ "$CLOUDFRONT_DOMAIN" == "None" ]; then
    echo -e "${RED}❌ Could not find CloudFront distribution for ${PROJECT_NAME}-${ENVIRONMENT}${NC}"
    echo "   Make sure CloudFront is deployed first."
    exit 1
fi

echo -e "  CloudFront Domain: ${GREEN}${CLOUDFRONT_DOMAIN}${NC}"

# -----------------------------------------------------------------------------
# GET ALB DNS NAME (for Backend API)
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Getting ALB DNS name (Backend API)...${NC}"

ALB_DNS=$(aws elbv2 describe-load-balancers \
    --names "${PROJECT_NAME}-${ENVIRONMENT}-alb" \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION" \
    --query 'LoadBalancers[0].DNSName' \
    --output text 2>/dev/null)

if [ -z "$ALB_DNS" ] || [ "$ALB_DNS" == "None" ]; then
    echo -e "${RED}❌ Could not find ALB: ${PROJECT_NAME}-${ENVIRONMENT}-alb${NC}"
    echo "   Make sure ALB is deployed first."
    exit 1
fi

echo -e "  ALB DNS Name: ${GREEN}${ALB_DNS}${NC}"

# -----------------------------------------------------------------------------
# COMPUTE URLS (CORRECT ARCHITECTURE)
# -----------------------------------------------------------------------------
# Frontend = CloudFront (static content, cached)
# Backend  = ALB directly (dynamic API, no CDN caching)

FRONTEND_URL="https://${CLOUDFRONT_DOMAIN}"

# API URL points DIRECTLY to ALB, NOT through CloudFront!
# Using HTTP because ALB doesn't have HTTPS cert (add cert for production!)
API_URL="http://${ALB_DNS}/api"

# Google OAuth callbacks
# - Backend callback: Goes to ALB (where the API handles the OAuth flow)
# - Frontend callback: Goes to CloudFront (where React handles the redirect)
GOOGLE_CALLBACK_URL="http://${ALB_DNS}/api/auth/google/callback"
FRONTEND_GOOGLE_CALLBACK_URL="${FRONTEND_URL}/google/callback"

# Cookie domain: CloudFront domain
# Note: Cross-origin cookies require SameSite=None; Secure (HTTPS required)
COOKIE_DOMAIN="${CLOUDFRONT_DOMAIN}"

echo ""
echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}   Computed URLs (Correct Architecture)${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""
echo -e "${GREEN}Frontend (CloudFront → S3):${NC}"
echo -e "  ${FRONTEND_URL}"
echo ""
echo -e "${GREEN}Backend API (ALB → ECS):${NC}"
echo -e "  ${API_URL}"
echo ""
echo -e "${GREEN}OAuth Callbacks:${NC}"
echo -e "  Google → API:   ${GOOGLE_CALLBACK_URL}"
echo -e "  API → Frontend: ${FRONTEND_GOOGLE_CALLBACK_URL}"
echo ""
echo -e "${GREEN}Cookie Domain:${NC}"
echo -e "  ${COOKIE_DOMAIN}"
echo ""
echo -e "${YELLOW}Note: Frontend and API are on different domains - CORS is required.${NC}"
echo ""

# Confirmation
read -p "Update Parameter Store with these URLs? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Aborted.${NC}"
    exit 1
fi

# -----------------------------------------------------------------------------
# UPDATE PARAMETER STORE
# -----------------------------------------------------------------------------
echo ""
echo -e "${YELLOW}Updating Parameter Store...${NC}"

# Update FRONTEND_ORIGIN (for CORS - must match exactly!)
echo -n "  Updating FRONTEND_ORIGIN... "
aws ssm put-parameter \
    --name "/${PROJECT_NAME}/${ENVIRONMENT}/FRONTEND_ORIGIN" \
    --value "${FRONTEND_URL}" \
    --type String \
    --overwrite \
    --region "${AWS_REGION}" \
    --profile "${AWS_PROFILE}" > /dev/null
echo -e "${GREEN}✓${NC}"

# Update GOOGLE_CALLBACK_URL (points to ALB, NOT CloudFront!)
echo -n "  Updating GOOGLE_CALLBACK_URL... "
aws ssm put-parameter \
    --name "/${PROJECT_NAME}/${ENVIRONMENT}/GOOGLE_CALLBACK_URL" \
    --value "${GOOGLE_CALLBACK_URL}" \
    --type String \
    --overwrite \
    --region "${AWS_REGION}" \
    --profile "${AWS_PROFILE}" > /dev/null
echo -e "${GREEN}✓${NC}"

# Update FRONTEND_GOOGLE_CALLBACK_URL (points to CloudFront)
echo -n "  Updating FRONTEND_GOOGLE_CALLBACK_URL... "
aws ssm put-parameter \
    --name "/${PROJECT_NAME}/${ENVIRONMENT}/FRONTEND_GOOGLE_CALLBACK_URL" \
    --value "${FRONTEND_GOOGLE_CALLBACK_URL}" \
    --type String \
    --overwrite \
    --region "${AWS_REGION}" \
    --profile "${AWS_PROFILE}" > /dev/null
echo -e "${GREEN}✓${NC}"

# Update COOKIE_DOMAIN
echo -n "  Updating COOKIE_DOMAIN... "
aws ssm put-parameter \
    --name "/${PROJECT_NAME}/${ENVIRONMENT}/COOKIE_DOMAIN" \
    --value "${COOKIE_DOMAIN}" \
    --type String \
    --overwrite \
    --region "${AWS_REGION}" \
    --profile "${AWS_PROFILE}" > /dev/null
echo -e "${GREEN}✓${NC}"

# Update VITE_API_BASE_URL (points to ALB, NOT CloudFront!)
echo -n "  Updating VITE_API_BASE_URL... "
aws ssm put-parameter \
    --name "/${PROJECT_NAME}/${ENVIRONMENT}/VITE_API_BASE_URL" \
    --value "${API_URL}" \
    --type String \
    --overwrite \
    --region "${AWS_REGION}" \
    --profile "${AWS_PROFILE}" > /dev/null
echo -e "${GREEN}✓${NC}"

echo ""
echo -e "${GREEN}Parameter Store updated successfully!${NC}"

# -----------------------------------------------------------------------------
# FORCE ECS REDEPLOYMENT
# -----------------------------------------------------------------------------
echo ""
read -p "Force ECS redeployment to pick up new URLs? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Forcing ECS redeployment...${NC}"
    
    ECS_CLUSTER="${PROJECT_NAME}-${ENVIRONMENT}-cluster"
    ECS_SERVICE="${PROJECT_NAME}-${ENVIRONMENT}-backend-service"
    
    aws ecs update-service \
        --cluster "${ECS_CLUSTER}" \
        --service "${ECS_SERVICE}" \
        --force-new-deployment \
        --region "${AWS_REGION}" \
        --profile "${AWS_PROFILE}" > /dev/null
    
    echo -e "${GREEN}ECS redeployment initiated!${NC}"
    echo ""
    echo "Monitor deployment:"
    echo -e "  ${BLUE}aws ecs describe-services --cluster ${ECS_CLUSTER} --services ${ECS_SERVICE} --profile ${AWS_PROFILE} --query 'services[0].deployments'${NC}"
fi

# -----------------------------------------------------------------------------
# GOOGLE OAUTH UPDATE
# -----------------------------------------------------------------------------
echo ""
echo -e "${YELLOW}=========================================${NC}"
echo -e "${YELLOW}   UPDATE GOOGLE OAUTH CREDENTIALS${NC}"
echo -e "${YELLOW}=========================================${NC}"
echo ""
echo "Go to: Google Cloud Console > APIs & Services > Credentials"
echo ""
echo -e "${BLUE}Authorized JavaScript origins:${NC}"
echo "  ${FRONTEND_URL}"
echo "  http://${ALB_DNS}"
echo ""
echo -e "${BLUE}Authorized redirect URIs:${NC}"
echo "  ${GOOGLE_CALLBACK_URL}"
echo ""

# -----------------------------------------------------------------------------
# SUMMARY
# -----------------------------------------------------------------------------
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}   SUMMARY${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
echo -e "${BLUE}Parameter Store:${NC}"
echo "  FRONTEND_ORIGIN              = ${FRONTEND_URL}"
echo "  VITE_API_BASE_URL            = ${API_URL}"
echo "  GOOGLE_CALLBACK_URL          = ${GOOGLE_CALLBACK_URL}"
echo "  FRONTEND_GOOGLE_CALLBACK_URL = ${FRONTEND_GOOGLE_CALLBACK_URL}"
echo "  COOKIE_DOMAIN                = ${COOKIE_DOMAIN}"
echo ""
echo -e "${BLUE}Your Backend CORS should be:${NC}"
echo "  origin: '${FRONTEND_URL}'"
echo "  credentials: true"
echo ""
echo -e "${BLUE}Your Backend Cookies should have:${NC}"
echo "  domain: '${COOKIE_DOMAIN}'"
echo "  sameSite: 'none'"
echo "  secure: true  // Requires HTTPS!"
echo ""
echo -e "${GREEN}Done! 🎉${NC}"