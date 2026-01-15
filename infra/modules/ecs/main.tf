# =============================================================================
# ECS MODULE - FARGATE CLUSTER, SERVICE, AND AUTO SCALING
# =============================================================================
# This module creates an ECS Fargate cluster with a backend service.
#
# What it creates:
# - ECS Cluster with Container Insights
# - Task Definition (pulls from ECR, uses Parameter Store secrets)
# - ECS Service (connects to ALB target group)
# - Auto Scaling (CPU/Memory based)
# - CloudWatch Log Group
#
# Architecture:
# Internet → ALB → ECS Service (Fargate) → MongoDB Atlas
# =============================================================================

# -----------------------------------------------------------------------------
# CLOUDWATCH LOG GROUP
# -----------------------------------------------------------------------------
# Create log group BEFORE task definition to avoid race condition

resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${var.project_name}-${var.environment}-backend"
  retention_in_days = var.log_retention_days

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-backend-logs"
  })
}

# -----------------------------------------------------------------------------
# ECS CLUSTER
# -----------------------------------------------------------------------------
# Fargate cluster for running containers without managing EC2 instances

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-${var.environment}-cluster"

  # Enable Container Insights for monitoring
  setting {
    name  = "containerInsights"
    value = var.enable_container_insights ? "enabled" : "disabled"
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-cluster"
  })
}

# Fargate capacity provider (default for Fargate)
resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = var.fargate_weight
    base              = var.fargate_base
  }
  # Optional: Use FARGATE_SPOT for cost savings (up to 70% cheaper)
  # Uncomment if you want spot instances
  # default_capacity_provider_strategy {
  #   capacity_provider = "FARGATE_SPOT"
  #   weight            = var.fargate_spot_weight
  # }
  
}

# -----------------------------------------------------------------------------
# ECS TASK DEFINITION
# -----------------------------------------------------------------------------
# Defines the container configuration, resources, and secrets

resource "aws_ecs_task_definition" "backend" {
  family                   = "${var.project_name}-${var.environment}-backend"
  network_mode             = "awsvpc" # Required for Fargate
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.task_cpu
  memory                   = var.task_memory

  # IAM Roles
  execution_role_arn = var.ecs_task_execution_role_arn # For ECS agent (pull image, get secrets)
  task_role_arn      = var.ecs_task_role_arn           # For application (AWS SDK calls)

  # Container Definition
  container_definitions = jsonencode([
    {
      name      = "backend"
      image     = "${var.ecr_repository_url}:${var.image_tag}"
      essential = true

      # Port Mapping
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]

      # Environment Variables (non-sensitive)
      environment = [
        {
          name  = "PORT"
          value = tostring(var.container_port)
        },
        {
          name  = "NODE_ENV"
          value = var.node_env
        }
      ]

      # Secrets from Parameter Store (sensitive)
      secrets = [
        {
          name      = "MONGO_URI"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/MONGO_URI"
        },
        {
          name      = "JWT_ACCESS_TOKEN_SECRET"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/JWT_ACCESS_TOKEN_SECRET"
        },
        {
          name      = "JWT_ACCESS_TOKEN_EXPIRES_IN"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/JWT_ACCESS_TOKEN_EXPIRES_IN"
        },
        {
          name      = "JWT_REFRESH_TOKEN_SECRET"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/JWT_REFRESH_TOKEN_SECRET"
        },
        {
          name      = "JWT_REFRESH_TOKEN_EXPIRES_IN"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/JWT_REFRESH_TOKEN_EXPIRES_IN"
        },
        {
          name      = "GOOGLE_CLIENT_ID"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/GOOGLE_CLIENT_ID"
        },
        {
          name      = "GOOGLE_CLIENT_SECRET"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/GOOGLE_CLIENT_SECRET"
        },
        {
          name      = "GOOGLE_CALLBACK_URL"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/GOOGLE_CALLBACK_URL"
        },
        {
          name      = "FRONTEND_ORIGIN"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/FRONTEND_ORIGIN"
        },
        {
          name      = "FRONTEND_GOOGLE_CALLBACK_URL"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/FRONTEND_GOOGLE_CALLBACK_URL"
        },
        {
          name      = "COOKIE_DOMAIN"
          valueFrom = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/COOKIE_DOMAIN"
        }
      ]

      # Logging Configuration
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }

      # Health Check
      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:${var.container_port}${var.health_check_path} || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }

      # Resource Limits (optional but recommended)
      ulimits = [
        {
          name      = "nofile"
          softLimit = 65536
          hardLimit = 65536
        }
      ]
    }
  ])

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-backend-task"
  })
}

# -----------------------------------------------------------------------------
# ECS SERVICE
# -----------------------------------------------------------------------------
# Runs and maintains the desired number of tasks

resource "aws_ecs_service" "backend" {
  name            = "${var.project_name}-${var.environment}-backend-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  # Platform version (latest = 1.4.0 as of 2024)
  platform_version = "LATEST"

  # Deployment Configuration
  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.deployment_maximum_percent

  # Enable ECS Exec for debugging (optional)
  enable_execute_command = var.enable_ecs_exec

  # Network Configuration
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_security_group_id]
    assign_public_ip = false # Tasks in private subnet, no public IP needed
  }

  # Load Balancer Configuration
  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "backend"
    container_port   = var.container_port
  }

  # Health Check Grace Period
  # Give task time to start before ALB starts health checks
  health_check_grace_period_seconds = var.health_check_grace_period

  # Deployment Circuit Breaker
  # Automatically roll back failed deployments
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Lifecycle: Ignore changes to desired_count (managed by auto-scaling)
  lifecycle {
    ignore_changes = [desired_count]
  }

  # Dependency: Ensure target group is created first
  depends_on = [aws_cloudwatch_log_group.ecs]

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-backend-service"
  })
}

# -----------------------------------------------------------------------------
# AUTO SCALING
# -----------------------------------------------------------------------------

# Auto Scaling Target
resource "aws_appautoscaling_target" "ecs" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.backend.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# Scale Up Policy - Based on CPU
resource "aws_appautoscaling_policy" "scale_up_cpu" {
  name               = "${var.project_name}-${var.environment}-scale-up-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = var.cpu_target_value
    scale_in_cooldown  = var.scale_in_cooldown
    scale_out_cooldown = var.scale_out_cooldown
  }
}

# Scale Up Policy - Based on Memory
resource "aws_appautoscaling_policy" "scale_up_memory" {
  name               = "${var.project_name}-${var.environment}-scale-up-memory"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
    target_value       = var.memory_target_value
    scale_in_cooldown  = var.scale_in_cooldown
    scale_out_cooldown = var.scale_out_cooldown
  }
}

# -----------------------------------------------------------------------------
# CLOUDWATCH ALARMS (Optional)
# -----------------------------------------------------------------------------


# Alarm: High CPU Utilization
resource "aws_cloudwatch_metric_alarm" "high_cpu" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-ecs-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Alert when ECS CPU utilization is high"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.backend.name
  }

  tags = var.common_tags
}

# Alarm: High Memory Utilization
resource "aws_cloudwatch_metric_alarm" "high_memory" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-ecs-high-memory"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Alert when ECS memory utilization is high"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.backend.name
  }

  tags = var.common_tags
}

# Alarm: No Running Tasks
resource "aws_cloudwatch_metric_alarm" "no_running_tasks" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-ecs-no-tasks"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Average"
  threshold           = 1
  alarm_description   = "Alert when no ECS tasks are running"
  treat_missing_data  = "breaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.backend.name
  }

  tags = var.common_tags
}


