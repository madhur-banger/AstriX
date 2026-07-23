# =============================================================================
# ALB MODULE
# =============================================================================
# This module creates an Application Load Balancer that:
# - Receives traffic from the internet (HTTP/HTTPS)
# - Routes traffic to ECS tasks running in private subnets
# - Performs health checks
# - Handles SSL termination (when certificate is added)
# =============================================================================

# -----------------------------------------------------------------------------
# APPLICATION LOAD BALANCER
# -----------------------------------------------------------------------------

resource "aws_lb" "main" {
  name               = "${var.project_name}-${var.environment}-alb"
  internal           = false # Internet-facing
  load_balancer_type = "application"
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection       = var.environment == "prod" ? true : false
  enable_http2                     = true
  enable_cross_zone_load_balancing = true

  # Access logs (optional, costs extra)
  dynamic "access_logs" {
    for_each = var.enable_access_logs ? [1] : []
    content {
      bucket  = var.access_logs_bucket
      enabled = true
      prefix  = "alb"
    }
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-alb"
  })
}

# -----------------------------------------------------------------------------
# TARGET GROUP
# -----------------------------------------------------------------------------
# This is where ECS tasks register themselves
# ALB sends traffic to healthy targets in this group

resource "aws_lb_target_group" "backend" {
  name        = "${var.project_name}-${var.environment}-tg"
  port        = var.backend_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip" # Required for Fargate

  # Health check configuration
  health_check {
    enabled             = true
    healthy_threshold   = 2 # 2 consecutive successful checks = healthy
    unhealthy_threshold = 3 # 3 consecutive failed checks = unhealthy
    timeout             = 5
    interval            = 30 # Check every 30 seconds
    path                = var.health_check_path
    matcher             = "200-299"
    protocol            = "HTTP"
  }

  # Deregistration delay - how long to wait before removing target
  deregistration_delay = 30

  # Stickiness (optional - for session persistence)
  stickiness {
    enabled         = var.enable_stickiness
    type            = "lb_cookie"
    cookie_duration = 86400 # 1 day
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-tg"
  })

  #   lifecycle {
  #     create_before_destroy = true
  #   }
}

# -----------------------------------------------------------------------------
# HTTP LISTENER (Port 80)
# -----------------------------------------------------------------------------
# Forwards to the backend target group only when no HTTPS listener exists
# (var.redirect_http_to_https = false, e.g. a domain-less dev ALB with no
# cert at all). Once HTTPS is enabled, this 301-redirects instead - plaintext
# HTTP must never forward to the target group in parallel with HTTPS.

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = "80"
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = var.redirect_http_to_https ? [] : [1]
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.backend.arn
    }
  }

  dynamic "default_action" {
    for_each = var.redirect_http_to_https ? [1] : []
    content {
      type = "redirect"

      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  tags = var.common_tags
}

# The HTTPS listener (port 443) is created by the caller (see
# environments/dev/main.tf: aws_lb_listener.https), not by this module,
# because the ACM certificate ARN it depends on is produced by the acm
# module, which depends on this module's alb_dns_name output - creating it
# here would be a circular dependency.

# -----------------------------------------------------------------------------
# CLOUDWATCH ALARMS
# -----------------------------------------------------------------------------
# These answer "is the app actually serving traffic correctly right now" -
# a target can look perfectly healthy to ECS while still returning 5xx to
# real clients, which the ECS-level CPU/memory/task-count alarms can't see.

resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-alb-target-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "Alert when the backend returns an elevated rate of 5xx responses"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
  }

  tags = var.common_tags
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.project_name}-${var.environment}-alb-unhealthy-hosts"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Average"
  threshold           = 0
  alarm_description   = "Alert when a target is registered but failing health checks"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.backend.arn_suffix
  }

  tags = var.common_tags
}
