# =============================================================================
# SECURITY MODULE
# =============================================================================
# This module creates security groups for all infrastructure components:
# - ALB Security Group (public facing)
# - ECS Tasks Security Group (backend containers)
# - Lambda Security Group (if VPC-attached)
#
# Security Model:
# ┌──────────────────────────────────────────────────────────────────────────┐
# │                                                                          │
# │   INTERNET                                                               │
# │       │                                                                  │
# │       │ HTTPS (443), HTTP (80)                                          │
# │       ▼                                                                  │
# │   ┌──────────────────────────────────────────────────────────────────┐  │
# │   │   ALB Security Group                                              │  │
# │   │   Inbound: 80, 443 from 0.0.0.0/0                                │  │
# │   │   Outbound: All to ECS SG                                        │  │
# │   └──────────────────────────────────────────────────────────────────┘  │
# │       │                                                                  │
# │       │ Port 3000 (app port)                                            │
# │       ▼                                                                  │
# │   ┌──────────────────────────────────────────────────────────────────┐  │
# │   │   ECS Security Group                                              │  │
# │   │   Inbound: 3000 from ALB SG only                                 │  │
# │   │   Outbound: All (for external API calls, DB, etc.)               │  │
# │   └──────────────────────────────────────────────────────────────────┘  │
# │                                                                          │
# └──────────────────────────────────────────────────────────────────────────┘
# =============================================================================

# -----------------------------------------------------------------------------
# ALB SECURITY GROUP
# -----------------------------------------------------------------------------
# Controls traffic to the Application Load Balancer
# This is the only security group that accepts traffic from the internet


resource "aws_security_group" "alb" {
  name        = "${var.project_name}-${var.environment}-alb-sg"
  description = "Security group for Application Load Balancer"
  vpc_id      = var.vpc_id

  # Inbound: Allow HTTP from anywhere
  # Used for: HTTP to HTTPS redirect
  ingress {
    description = "HTTP from anywhere"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Inbound: Allow HTTPS from anywhere
  # Used for: Production traffic
  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Outbound: Allow all traffic
  # ALB needs to reach ECS tasks on the app port
  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-alb-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}


# -----------------------------------------------------------------------------
# ECS TASKS SECURITY GROUP
# -----------------------------------------------------------------------------
# Controls traffic to ECS Fargate tasks (your backend containers)
# Only accepts traffic from the ALB - never directly from internet

resource "aws_security_group" "ecs_tasks" {
  name        = "${var.project_name}-${var.environment}-ecs-tasks-sg"
  description = "Security group for ECS Fargate tasks"
  vpc_id      = var.vpc_id

  # Inbound: Allow traffic from ALB only on app port
  # This is the key security boundary - only ALB can reach containers
  ingress {
    description     = "App port from ALB"
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Outbound: Allow all traffic
  # ECS tasks need to:
  # - Pull images from ECR
  # - Connect to MongoDB Atlas (external)
  # - Call external APIs
  # - Send to SNS/SQS
  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-ecs-tasks-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# -----------------------------------------------------------------------------
# LAMBDA SECURITY GROUP (Optional - for VPC-attached Lambdas)
# -----------------------------------------------------------------------------
# If your Lambda functions need to access VPC resources (like RDS),
# they need to be VPC-attached and have a security group


resource "aws_security_group" "lambda" {
  count = var.create_lambda_sg ? 1 : 0

  name        = "${var.project_name}-${var.environment}-lambda-sg"
  description = "Security group for VPC-attached Lambda functions"
  vpc_id      = var.vpc_id

  # Lambda functions typically don't need inbound rules
  # They are invoked by AWS services, not by network traffic

  # Outbound: Allow all traffic
  # Lambda needs to:
  # - Connect to MongoDB Atlas
  # - Send emails via SES
  # - Write to DynamoDB
  # - Publish to SNS
  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-lambda-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}


# -----------------------------------------------------------------------------
# DATABASE SECURITY GROUP (Optional - for RDS if you migrate from Atlas)
# -----------------------------------------------------------------------------
# If you ever move from MongoDB Atlas to RDS/DocumentDB

resource "aws_security_group" "database" {
  count = var.create_database_sg ? 1 : 0

  name        = "${var.project_name}-${var.environment}-database-sg"
  description = "Security group for database instances"
  vpc_id      = var.vpc_id

  # Inbound: Allow from ECS tasks only
  ingress {
    description     = "Database port from ECS"
    from_port       = var.database_port
    to_port         = var.database_port
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  # Inbound: Allow from Lambda if Lambda SG exists
  dynamic "ingress" {
    for_each = var.create_lambda_sg ? [1] : []
    content {
      description     = "Database port from Lambda"
      from_port       = var.database_port
      to_port         = var.database_port
      protocol        = "tcp"
      security_groups = [aws_security_group.lambda[0].id]
    }
  }

  # Outbound: None needed for databases
  egress {
    description = "No outbound needed"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-database-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# -----------------------------------------------------------------------------
# VPC ENDPOINTS SECURITY GROUP (Optional - for cost optimization)
# -----------------------------------------------------------------------------
# VPC Endpoints allow private access to AWS services without NAT Gateway
# This can reduce costs and improve security

resource "aws_security_group" "vpc_endpoints" {
  count = var.create_vpc_endpoints_sg ? 1 : 0

  name        = "${var.project_name}-${var.environment}-vpce-sg"
  description = "Security group for VPC Endpoints"
  vpc_id      = var.vpc_id

  # Inbound: Allow HTTPS from VPC
  # VPC Endpoints use HTTPS (443)
  ingress {
    description = "HTTPS from VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  # Outbound: Allow all
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-vpce-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}
