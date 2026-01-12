# =============================================================================
# ALB MODULE - OUTPUTS
# =============================================================================

output "alb_id" {
  description = "ID of the ALB"
  value       = aws_lb.main.id
}

output "alb_arn" {
  description = "ARN of the ALB"
  value       = aws_lb.main.arn
}

output "alb_dns_name" {
  description = "DNS name of the ALB (use this to access your backend)"
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Zone ID of the ALB (for Route53 alias records)"
  value       = aws_lb.main.zone_id
}

output "target_group_arn" {
  description = "ARN of the target group (ECS service will register here)"
  value       = aws_lb_target_group.backend.arn
}

output "target_group_name" {
  description = "Name of the target group"
  value       = aws_lb_target_group.backend.name
}

output "http_listener_arn" {
  description = "ARN of HTTP listener"
  value       = aws_lb_listener.http.arn
}

output "backend_url" {
  description = "Full backend URL to use in frontend env vars"
  value       = "http://${aws_lb.main.dns_name}/api"
}
