# =============================================================================
# IAM MODULE
# =============================================================================
# This module creates IAM roles and policies for:
# - ECS Task Execution Role (AWS permissions to run tasks)
# - ECS Task Role (application permissions)
# - Lambda Execution Role (Lambda function permissions)
# - GitHub Actions Role (CI/CD deployment permissions)
#
# Role Architecture:
# ┌──────────────────────────────────────────────────────────────────────────┐
# │                                                                          │
# │   ECS TASK EXECUTION ROLE                                                │
# │   ├── Used by: ECS Agent (not your app code)                            │
# │   ├── Purpose: Pull images, write logs, get secrets                     │
# │   └── AWS Managed: AmazonECSTaskExecutionRolePolicy                     │
# │                                                                          │
# │   ECS TASK ROLE                                                          │
# │   ├── Used by: Your application code                                    │
# │   ├── Purpose: What your app can do (S3, SQS, DynamoDB, etc.)          │
# │   └── Custom Policy: Defined based on app needs                         │
# │                                                                          │
# │   LAMBDA EXECUTION ROLE                                                  │
# │   ├── Used by: Lambda functions                                         │
# │   ├── Purpose: CloudWatch logs, VPC access, service access             │
# │   └── Custom Policy: Based on function needs                            │
# │                                                                          │
# │   GITHUB ACTIONS ROLE                                                    │
# │   ├── Used by: CI/CD pipeline                                           │
# │   ├── Purpose: Deploy ECS, update Lambda, sync S3                       │
# │   └── Trust: GitHub OIDC provider                                       │
# │                                                                          │
# └──────────────────────────────────────────────────────────────────────────┘
# =============================================================================

# -----------------------------------------------------------------------------
# ECS TASK EXECUTION ROLE
# -----------------------------------------------------------------------------
# This role is used by the ECS agent (not your application)
# It needs permissions to:
# - Pull container images from ECR
# - Write logs to CloudWatch
# - Retrieve secrets from Parameter Store/Secrets Manager


resource "aws_iam_role" "ecs_task_execution" {
  name = "${var.project_name}-${var.environment}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-ecs-execution-role"
  })
}

# Attach AWS managed policy for basic ECS task execution
resource "aws_iam_role_policy_attachment" "ecs_task_execution_policy" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Additional policy for secrets access (Parameter Store)
resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name = "${var.project_name}-${var.environment}-ecs-execution-secrets"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "GetSecrets"
        Effect = "Allow"
        Action = [
          "ssm:GetParameters",
          "ssm:GetParameter",
          "ssm:GetParametersByPath"
        ]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/*"
        ]
      },
      {
        Sid    = "DecryptSecrets"
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = var.kms_key_arn != null ? [var.kms_key_arn] : ["*"]
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# ECS TASK ROLE
# -----------------------------------------------------------------------------
# This role is assumed by your application code running in the container
# It defines what AWS services your application can access

resource "aws_iam_role" "ecs_task" {
  name = "${var.project_name}-${var.environment}-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-ecs-task-role"
  })
}


# Application permissions policy
resource "aws_iam_role_policy" "ecs_task_app_permissions" {
  name = "${var.project_name}-${var.environment}-ecs-task-app-policy"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # SNS: Publish events
      {
        Sid    = "SNSPublish"
        Effect = "Allow"
        Action = [
          "sns:Publish"
        ]
        Resource = [
          "arn:aws:sns:${var.aws_region}:${var.aws_account_id}:${var.project_name}-${var.environment}-*"
        ]
      },
      # SQS: Read from queues (if needed for consumer pattern)
      {
        Sid    = "SQSAccess"
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = [
          "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${var.project_name}-${var.environment}-*"
        ]
      },
      # S3: File uploads/downloads
      {
        Sid    = "S3Access"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          "arn:aws:s3:::${var.project_name}-${var.environment}-*",
          "arn:aws:s3:::${var.project_name}-${var.environment}-*/*"
        ]
      },
      # DynamoDB: Activity logs, notifications
      {
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = [
          "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${var.project_name}-${var.environment}-*",
          "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${var.project_name}-${var.environment}-*/index/*"
        ]
      },
      # CloudWatch: Custom metrics
      {
        Sid    = "CloudWatchMetrics"
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "cloudwatch:namespace" = "${var.project_name}/${var.environment}"
          }
        }
      },
      # X-Ray: Tracing (optional but recommended)
      {
        Sid    = "XRayTracing"
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords"
        ]
        Resource = "*"
      }
    ]
  })
}


# -----------------------------------------------------------------------------
# LAMBDA EXECUTION ROLE
# -----------------------------------------------------------------------------
# This role is used by Lambda functions for:
# - CloudWatch Logs (required)
# - VPC access (if VPC-attached)
# - AWS service access (SNS, SQS, DynamoDB, etc.)

resource "aws_iam_role" "lambda_execution" {
  name = "${var.project_name}-${var.environment}-lambda-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-lambda-execution-role"
  })
}


# Basic Lambda execution policy (logs)
resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# VPC access for Lambda (if needed)
resource "aws_iam_role_policy_attachment" "lambda_vpc_access" {
  count      = var.lambda_vpc_access ? 1 : 0
  role       = aws_iam_role.lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Lambda application permissions
resource "aws_iam_role_policy" "lambda_app_permissions" {
  name = "${var.project_name}-${var.environment}-lambda-app-policy"
  role = aws_iam_role.lambda_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # SQS: Process messages from queues
      {
        Sid    = "SQSConsumer"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = [
          "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${var.project_name}-${var.environment}-*"
        ]
      },
      # SNS: Publish events
      {
        Sid    = "SNSPublish"
        Effect = "Allow"
        Action = [
          "sns:Publish"
        ]
        Resource = [
          "arn:aws:sns:${var.aws_region}:${var.aws_account_id}:${var.project_name}-${var.environment}-*"
        ]
      },
      # DynamoDB: Store activity, notifications
      {
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:BatchWriteItem"
        ]
        Resource = [
          "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${var.project_name}-${var.environment}-*",
          "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${var.project_name}-${var.environment}-*/index/*"
        ]
      },
      # S3: Read/write files
      {
        Sid    = "S3Access"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = [
          "arn:aws:s3:::${var.project_name}-${var.environment}-*/*"
        ]
      },
      # SES: Send emails
      {
        Sid    = "SESSendEmail"
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail"
        ]
        Resource = "*"
      },
      # Parameter Store: Read config
      {
        Sid    = "SSMGetParameters"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath"
        ]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/*"
        ]
      }
    ]
  })
}

# -----------------------------------------------------------------------------
# GITHUB ACTIONS OIDC PROVIDER
# -----------------------------------------------------------------------------
# This allows GitHub Actions to assume AWS roles without access keys
# Much more secure than storing AWS credentials in GitHub Secrets

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc ? 1 : 0

  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]

  # GitHub's OIDC thumbprint
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-github-oidc-provider"
  })
}

# -----------------------------------------------------------------------------
# GITHUB ACTIONS DEPLOYMENT ROLE
# -----------------------------------------------------------------------------
# This role is assumed by GitHub Actions for CI/CD deployments
# Permissions: ECR push, ECS deploy, S3 sync, Lambda update, Terraform

resource "aws_iam_role" "github_actions" {
  count = var.create_github_oidc ? 1 : 0

  name = "${var.project_name}-${var.environment}-github-actions-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github[0].arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:repository_owner" = var.github_org
          }
          StringLike = {
            # Only allow from your specific repository and branches
            "token.actions.githubusercontent.com:sub" = "repo:${var.github_org}/${var.github_repo}::ref:refs/heads/main"
          }
        }
      }
    ]
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-github-actions-role"
  })
}

# GitHub Actions deployment permissions
resource "aws_iam_role_policy" "github_actions_deploy" {
  count = var.create_github_oidc ? 1 : 0

  name = "${var.project_name}-${var.environment}-github-actions-policy"
  role = aws_iam_role.github_actions[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # ECR: Push Docker images
      {
        Sid    = "ECRPush"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload"
        ]
        Resource = "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${var.project_name}-${var.environment}-*"
      },
      # ECS: Deploy services
      {
        Sid    = "ECSDeploy"
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "ecs:DescribeServices",
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition",
          "ecs:DeregisterTaskDefinition",
          "ecs:DescribeClusters"
        ]
        "Resource": [
          "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:service/${var.project_name}-${var.environment}-*",
          "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/${var.project_name}-${var.environment}-*:*"
        ]

      },
      # ECS: Pass role to task
      {
        Sid    = "PassRole"
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          aws_iam_role.ecs_task_execution.arn,
          aws_iam_role.ecs_task.arn
        ]
      },
      # S3: Deploy frontend
      {
        Sid    = "S3Deploy"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          "arn:aws:s3:::${var.project_name}-${var.environment}-*",
          "arn:aws:s3:::${var.project_name}-${var.environment}-*/*"
        ]
      },
      # CloudFront: Invalidate cache
      {
        Sid    = "CloudFrontInvalidate"
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation",
          "cloudfront:GetInvalidation"
        ]
        Resource = "*"
      },
      # Lambda: Update functions
      {
        Sid    = "LambdaUpdate"
        Effect = "Allow"
        Action = [
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:GetFunction"
        ]
        Resource = [
          "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${var.project_name}-${var.environment}-*"
        ]
      }
    ]
  })
}