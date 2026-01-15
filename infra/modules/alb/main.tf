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

  enable_deletion_protection = var.environment == "prod" ? true : false
  enable_http2              = true
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
    healthy_threshold   = 2   # 2 consecutive successful checks = healthy
    unhealthy_threshold = 3   # 3 consecutive failed checks = unhealthy
    timeout             = 5
    interval            = 30  # Check every 30 seconds
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
# For now, accepts HTTP traffic
# In production, this should redirect to HTTPS


resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = "80"
  protocol          = "HTTP"

  # Default action - forward to backend target group
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }

  tags = var.common_tags
}

# -----------------------------------------------------------------------------
# HTTPS LISTENER (Port 443) - Optional
# -----------------------------------------------------------------------------
# Uncomment when you have an ACM certificate

# resource "aws_lb_listener" "https" {
#   count = var.certificate_arn != null ? 1 : 0
#
#   load_balancer_arn = aws_lb.main.arn
#   port              = "443"
#   protocol          = "HTTPS"
#   ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
#   certificate_arn   = var.certificate_arn
#
#   default_action {
#     type             = "forward"
#     target_group_arn = aws_lb_target_group.backend.arn
#   }
#
#   tags = var.common_tags
# }

# -----------------------------------------------------------------------------
# REDIRECT HTTP to HTTPS (when certificate is added)
# -----------------------------------------------------------------------------
# Uncomment when using HTTPS

# resource "aws_lb_listener" "http_redirect" {
#   count = var.certificate_arn != null ? 1 : 0
#
#   load_balancer_arn = aws_lb.main.arn
#   port              = "80"
#   protocol          = "HTTP"
#
#   default_action {
#     type = "redirect"
#
#     redirect {
#       port        = "443"
#       protocol    = "HTTPS"
#       status_code = "HTTP_301"
#     }
#   }
#
#   tags = var.common_tags
# }
