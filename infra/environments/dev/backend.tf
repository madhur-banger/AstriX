# =============================================================================
# DEV ENVIRONMENT - BACKEND CONFIGURATION
# =============================================================================
# Remote state storage in S3 with DynamoDB locking.
# This configuration uses the backend you already created.
# =============================================================================

terraform {
  backend "s3" {
    # S3 bucket for state storage (created in your setup)
    bucket = "prod-terraform-state-586794439017"
    
    # State file path within the bucket
    # Using environment/component structure for organization
    key = "dev/infrastructure/terraform.tfstate"
    
    # Region where the bucket exists
    region = "us-east-1"
    
    # DynamoDB table for state locking
    dynamodb_table = "terraform-locks"
    
    # Enable server-side encryption
    encrypt = true
    
    # KMS key for encryption (optional but recommended)
    # kms_key_id = "arn:aws:kms:us-east-1:586794439017:key/f72c4cc6-b22a-45d0-9c13-6ffb428cf30b"
  }
}
