# Observability, Monitoring & Alerting

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md).

Every system that runs in production eventually fails in a way nobody predicted at design time — a slow memory leak, a dependency that starts timing out, a bad deploy that passes health checks but corrupts responses. The difference between an incident that gets fixed in ten minutes and one that gets discovered by an angry user three hours later is almost never the underlying bug. It's whether the system was watching itself closely enough to notice, and whether "noticing" actually reached a human being. That's what observability, monitoring, and alerting are for: three related but distinct disciplines — collecting evidence about what a running system is doing (logs, metrics, traces), deciding what "wrong" looks like in that evidence (alarms, thresholds), and getting that judgment in front of a person who can act on it (notification, paging, escalation).

This chapter surveys the real, industry-standard ways teams build that pipeline, then walks through AstriX's answer in full: CloudWatch as the entire observability backbone, three ECS-level alarms and two ALB-level alarms feeding a single SNS topic that fans out to email, and AWS Budgets layered on top as a cost-specific guardrail that has nothing to do with CloudWatch at all. The [compute/orchestration chapter](./06-compute-and-container-orchestration-ecs-fargate.md) and the [deployment-strategies chapter](./13-deployment-strategies-and-rollback.md) cover what ECS *does* when things go wrong (autoscaling, the deployment circuit breaker, rollback); this chapter is about how anyone finds out something went wrong in the first place.

---

## 1. The Landscape

"How do you know your production system is healthy, and how do you find out the moment it isn't" has four genuinely different, widely-adopted answers in industry. They differ in who operates the infrastructure that does the watching, how expressive the resulting queries and dashboards are, and how tightly you get locked into one vendor's way of doing things.

### (a) Cloud-native monitoring — AWS CloudWatch (and its Azure/GCP equivalents)

The monitoring service is part of the same cloud platform running your compute, and it's on by default for most resource types with zero extra infrastructure to stand up. Every ECS task, ALB, RDS instance, Lambda function, and dozens of other AWS resource types emit metrics to CloudWatch automatically the moment they exist; logs can be shipped there directly by the container runtime with no sidecar or agent to install. Alarms are first-class objects that watch a metric and can invoke a shared notification mechanism (SNS, Lambda, Auto Scaling actions) the instant a threshold is crossed.

```hcl
resource "aws_cloudwatch_metric_alarm" "example" {
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
```

**Tradeoff:** the integration is the whole pitch — no agents to deploy, no separate service to keep alive, and metrics/logs/alarms/notifications all live inside the same IAM and billing boundary as everything else. The cost is that CloudWatch's own tooling is comparatively weak at the query and visualization layer: CloudWatch Logs Insights is a real query language, but it's nowhere near as expressive as PromQL or Kibana's DSL for ad hoc exploration, and CloudWatch's native dashboards are functional rather than polished. It also only sees AWS-native resources well — if part of your stack runs outside AWS (a different cloud, on-prem, a third-party SaaS dependency), CloudWatch has no native visibility into it at all. Cost scales with log ingestion volume, custom metric count, and alarm count, which is usually fine at small-to-medium scale and can become a real line item at high log volume.

### (b) Self-hosted Prometheus + Grafana

The CNCF-standard metrics-and-dashboarding stack, and the dominant choice in the Kubernetes ecosystem specifically — most Kubernetes distributions ship a `kube-prometheus-stack` Helm chart as the default answer to "how do I monitor this cluster," with Grafana as the near-universal dashboarding layer on top regardless of what's collecting the metrics underneath. Prometheus is pull-based: it scrapes an HTTP `/metrics` endpoint that each service exposes on its own, on a schedule, rather than services pushing data to it. Alertmanager, a separate component in the same project family, evaluates alerting rules against that time-series data and handles routing, deduplication, and silencing before notifications go out.

```yaml
# prometheus.yml scrape config
scrape_configs:
  - job_name: "backend"
    static_configs:
      - targets: ["backend:9100"]
```

**Tradeoff:** PromQL is a genuinely powerful query language for time-series data, the ecosystem of pre-built exporters (for databases, load balancers, language runtimes) is enormous, and because it's self-hosted open source, there's no vendor lock-in and no per-host or per-metric billing surprise. The cost is that you now operate a stateful system yourself: Prometheus's local time-series database needs storage sizing, retention tuning, and — if you need it to survive a single node dying — a remote-write backend or a project like Thanos/Cortex for long-term, highly-available storage, none of which is trivial to run correctly. It also assumes something is scraping metrics endpoints on a schedule, which fits naturally in Kubernetes (service discovery is built in) and requires more manual wiring in a non-Kubernetes environment like plain ECS.

### (c) SaaS APM platforms — Datadog, New Relic

Commercial, fully-managed observability platforms that combine metrics, logs, distributed tracing, and application performance monitoring (APM) in a single product, typically via a lightweight agent installed alongside the application. Datadog's agent, for instance, auto-instruments many popular frameworks and libraries with minimal code changes, correlating a slow database query directly with the HTTP request and the specific line of application code that issued it.

```yaml
# datadog agent sidecar, conceptually
env:
  - name: DD_API_KEY
    valueFrom: { secretKeyRef: { name: datadog-secret, key: api-key } }
  - name: DD_APM_ENABLED
    value: "true"
```

**Tradeoff:** the operational burden is close to zero — there's no metrics database to run, no dashboard server to patch, and distributed tracing that would otherwise require standing up and maintaining Jaeger or Tempo comes largely for free. Built-in on-call and escalation-policy features (or tight integrations with PagerDuty/Opsgenie) make the "get a human's attention correctly" half of the problem someone else's job too. The cost is real and compounding vendor lock-in — dashboards, monitors, and saved queries are written against that platform's proprietary model and don't port cleanly to a competitor — plus billing that scales with hosts, ingested log/metric volume, and custom metrics in ways that are notoriously easy to underestimate at signup and expensive to discover after the fact. It also means shipping detailed operational telemetry, and potentially some amount of request data, to a third party, which is its own compliance and data-residency conversation depending on the industry.

### (d) Dedicated log-aggregation stacks — ELK / OpenSearch

A stack purpose-built around full-text search over logs rather than time-series metrics: Elasticsearch (or its OpenSearch fork, created after Elastic's 2021 licensing change) as the search/storage engine, Logstash or a lighter shipper like Filebeat to get logs in, and Kibana (or OpenSearch Dashboards) to query and visualize them.

```json
GET /logs-*/_search
{
  "query": { "match": { "level": "error" } }
}
```

**Tradeoff:** nothing else on this list matches ELK/OpenSearch's ad hoc, full-text search power over large volumes of unstructured or semi-structured log data — "find every log line mentioning this user ID across every service in the last 30 days" is exactly the query shape it's built for. The cost is that you're now operating a distributed search cluster: shard and index-sizing decisions, hot/warm/cold storage tiering to keep costs sane at scale, and a whole separate skill set to run well. It also isn't a complete answer on its own — ELK/OpenSearch is a logs product, not a metrics-and-alerting product, so most real deployments pair it with Prometheus or a vendor's APM layer for the metrics/alarms half of the problem rather than using it standalone.

*(Brief landscape note, not a deep dive: in a Kubernetes-native shop, "observability" and "Prometheus + Grafana" are close to synonymous, which is part of why option (b) above singles out Kubernetes by name — AstriX runs on ECS Fargate, not Kubernetes, a choice covered in full in the [compute chapter](./06-compute-and-container-orchestration-ecs-fargate.md), so that gravitational pull toward Prometheus doesn't apply here the way it would in a k8s shop.)*

---

## 2. AstriX's Choice

AstriX uses **option (a), CloudWatch, as its entire observability backbone** — logs, metrics, and alarms all live in the same AWS service, with no self-hosted metrics database, no third-party SaaS agent, and no separate log-search cluster. Container logs reach CloudWatch Logs through the ECS `awslogs` log driver with no shipping agent of its own to run; ECS and ALB metrics are collected automatically by AWS; five CloudWatch alarms (three watching the ECS service, two watching the ALB) publish state changes to one shared Amazon SNS topic, which fans out to a single subscribed email address. Layered independently on top — a separate AWS service with no dependency on CloudWatch — AWS Budgets tracks month-to-date spend and emails the same address when spend crosses two configured thresholds. It's a deliberately small, low-operational-overhead pipeline: nothing here requires patching a server, sizing a time-series database, or paying a SaaS vendor.

---

## 3. AstriX Implementation

### 3.1 The CloudWatch log group

Created before the task definition specifically to avoid a race condition — the ECS task's `awslogs` driver needs the log group to already exist the first time a container tries to write to it.

```hcl
resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${var.project_name}-${var.environment}-backend"
  retention_in_days = var.log_retention_days

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-backend-logs"
  })
}
```
`infra/modules/ecs/main.tf:22-29`

`retention_in_days` is wired from `var.log_retention_days`, which the dev environment sets via `ecs_log_retention_days`. That variable's default is `7`:

```hcl
variable "ecs_log_retention_days" {
  description = "CloudWatch log retention period in days"
  type        = number
  default     = 7
}
```
`infra/environments/dev/variables.tf:435-439`

and `terraform.tfvars` sets it explicitly to the same value — `ecs_log_retention_days = 7` (`infra/environments/dev/terraform.tfvars:163`) — so the deployed dev environment keeps exactly one week of application logs before CloudWatch deletes them for good. Worth noting precisely because it's easy to assume a value like this was deliberately tuned: it wasn't overridden away from the default, it just happens to match it.

### 3.2 Container Insights on the cluster

```hcl
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
```
`infra/modules/ecs/main.tf:36-48`

The variable defaults to `false`:

```hcl
variable "enable_container_insights" {
  description = "Enable Container Insights for monitoring"
  type        = bool
  default     = false
}
```
`infra/environments/dev/variables.tf:441-445`

but the deployed dev environment overrides it — `enable_container_insights = true` (`infra/environments/dev/terraform.tfvars:164`) — so Container Insights is genuinely turned on for the running cluster. This matters beyond "more dashboards": Container Insights is what publishes the `ECS/ContainerInsights` namespace's per-service metrics, including `RunningTaskCount`, which one of the three ECS alarms below depends on directly. Turn Container Insights off without touching that alarm, and its metric source disappears.

### 3.3 The task definition's `logConfiguration`

Inside the container definition, the `awslogs` driver ships everything the container writes to stdout/stderr straight to the log group above, stamped with a stream prefix so multiple task instances (and task revisions) don't collide in the same log group.

```hcl
      # Logging Configuration
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ecs.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
```
`infra/modules/ecs/main.tf:162-170`

No sidecar container, no log-shipping daemon, no separate agent to keep alive — the ECS agent underlying every Fargate task handles this natively as part of running the task at all. That's the practical payoff of "cloud-native" from the landscape survey: this entire piece of the pipeline is three lines of driver configuration, not a service to operate.

### 3.4 The three ECS-level alarms

```hcl
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
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions

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
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions

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
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.backend.name
  }

  tags = var.common_tags
}
```
`infra/modules/ecs/main.tf:326-398`

All three are gated behind `count = var.enable_alarms ? 1 : 0` — the module creates zero alarm resources at all unless the caller opts in. In the dev environment, `enable_alarms` is wired from `enable_ecs_alarms` (`infra/environments/dev/main.tf:410`), which defaults to `false`:

```hcl
variable "enable_ecs_alarms" {
  description = "Enable CloudWatch alarms for ECS"
  type        = bool
  default     = false
}
```
`infra/environments/dev/variables.tf:447-451`

but `terraform.tfvars` turns it on — `enable_ecs_alarms = true` (`infra/environments/dev/terraform.tfvars:165`) — so all three alarms, plus the two ALB alarms below (which read the exact same variable — see §5), genuinely exist in the deployed dev environment.

Look closely at each alarm's shape and they aren't interchangeable copies with different metric names. `high_cpu` and `high_memory` both watch an `AWS/ECS`-namespace `Average` statistic over `2` evaluation periods of `60` seconds each — the metric has to sit above `80` for two consecutive minutes before either fires, which absorbs a brief, ordinary spike rather than paging out on it. `no_running_tasks` is stricter on timing (`evaluation_periods = 1`, so a single 60-second period is enough) because there's no ambiguous "elevated but survivable" zone for a service with zero running tasks the way there is for CPU load — it's binary, so there's no reason to wait for confirmation.

### 3.5 The two ALB-level alarms

```hcl
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
```
`infra/modules/alb/main.tf:128-180`

That comment is the module's own explanation for why these exist as a *distinct* signal from the ECS alarms above, and it's worth taking at face value: ECS's CPU/memory/task-count metrics describe the container's internal resource state and process liveness, none of which guarantees the application is producing correct HTTP responses. A task can be running, healthy by its own health-check endpoint, using 20% CPU, and still be throwing an unhandled exception on every request to a specific route — something only visible from the ALB's vantage point as the client actually experiences it. `target_5xx` catches the "responding, but wrong" case (a `Sum` of 5xx codes over two minutes exceeding `10`); `unhealthy_hosts` catches the "the ALB itself has already given up routing to a target" case, and its `threshold = 0` is deliberately the strictest possible setting — any unhealthy host registered in the target group at all, sustained for two 60-second checks, is worth a notification.

### 3.6 The SNS topic and subscription

```hcl
resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-${var.environment}-alerts"

  tags = local.common_tags
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email != null ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
```
`infra/environments/dev/main.tf:107-118`

`alert_email` defaults to `null`:

```hcl
variable "alert_email" {
  description = "Email address subscribed to the CloudWatch alarm SNS topic. Required if enable_ecs_alarms is true - alarms with no subscriber change state silently."
  type        = string
  default     = null
}
```
`infra/environments/dev/variables.tf:453-457`

That description line is worth reading twice — it's the module author warning the reader, in the variable's own docstring, about exactly the class of failure covered in depth in §5: an alarm can be perfectly correctly configured and still notify nobody. The dev environment does set a real address in `terraform.tfvars` (the same address the `terraform.tfvars.example` template documents with a placeholder — `alert_email = "you@example.com"`, `infra/environments/dev/terraform.tfvars.example:145`), so the subscription resource is genuinely created in the deployed stack.

### 3.7 The AWS Budgets cost guardrail

```hcl
resource "aws_budgets_budget" "monthly" {
  count = var.monthly_budget_usd != null && var.alert_email != null ? 1 : 0

  name         = "${var.project_name}-${var.environment}-monthly-budget"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
}
```
`infra/environments/dev/main.tf:127-151`

`monthly_budget_usd` defaults to `50`:

```hcl
variable "monthly_budget_usd" {
  description = "Monthly AWS cost budget (USD) - triggers an email at 80% and 100% forecasted spend. Set to null to skip creating a budget."
  type        = number
  default     = 50
}
```
`infra/environments/dev/variables.tf:459-463`

and neither `terraform.tfvars` nor `terraform.tfvars.example` overrides it — the deployed dev budget really is running on the bare `$50/month` default, never deliberately tuned to AstriX's actual expected spend. This resource is entirely independent of everything above it: it's an AWS Billing/Cost-Management API resource, not a CloudWatch metric or alarm, and it reads AWS's own billing data rather than anything CloudWatch collects from ECS or the ALB.

### 3.8 The operational commands

```hcl
    view_task_logs   = "aws logs tail ${module.ecs.log_group_name} --follow --profile prod-terraform"
    ...
    check_health     = "curl -I http://${module.alb.alb_dns_name}${var.health_check_path}"
```
`infra/environments/dev/output.tf:366,373`

`terraform output` in the dev environment directory prints these as ready-to-paste commands. `aws logs tail <log-group> --follow` is the CLI's near-real-time tail against a CloudWatch log group — the fastest way to watch what the container is writing without opening the AWS console at all.

---

## 4. Request/Data Flow

**The incident path**, end to end:

1. The application container writes a line to stdout or stderr — say, `pino` logging an unhandled exception with a stack trace and a request ID (see [error handling](../backend/04-error-handling-patterns.md) for what generates that line on the backend side).
2. The Fargate agent, using the `awslogs` driver configured in `logConfiguration` (§3.3), ships that line to the `/ecs/astrix-dev-backend` log group (§3.1), stamped with an `ecs/`-prefixed stream name identifying which task wrote it.
3. Independently, ECS and the ALB continuously publish metrics — `CPUUtilization`, `MemoryUtilization`, and (because Container Insights is on) `RunningTaskCount` into `AWS/ECS`/`ECS/ContainerInsights`; `HTTPCode_Target_5XX_Count` and `UnHealthyHostCount` into `AWS/ApplicationELB` — at the granularity the alarms request (every 60 seconds, matching each alarm's `period`).
4. A CloudWatch alarm evaluates its metric on each period. If the value satisfies its `comparison_operator`/`threshold` for the number of consecutive periods given in `evaluation_periods`, the alarm transitions from `OK` (or `INSUFFICIENT_DATA`) to `ALARM`. This is a real state machine with three states, not a boolean — an alarm can also sit in `INSUFFICIENT_DATA` if it simply hasn't collected enough data points yet to evaluate at all, which is different from either `OK` or `ALARM`.
5. On that state transition, the alarm invokes every ARN listed in `alarm_actions` — here, always the single `aws_sns_topic.alerts.arn` (§3.6) — publishing a notification to the SNS topic. The same thing happens in reverse via `ok_actions` when the alarm later recovers to `OK`, which is why a human gets both a "this broke" and a "this recovered" email rather than just the first one.
6. SNS fans that publish out to every confirmed subscription on the topic. Today that's exactly one: the email subscription created in §3.6.
7. The subscribed address receives an email from AWS with the alarm name, the new state, and the reason (e.g., "Threshold Crossed: 2 out of the last 2 datapoints were greater than the threshold (80.0)").
8. A human, now aware something is wrong, runs `aws logs tail /ecs/astrix-dev-backend --follow --profile prod-terraform` (the exact command from §3.8, sourced from the `view_task_logs` Terraform output) to watch the application's own logs in near-real time and correlate them against the alarm's timing, or runs `check_health` to hit the ALB's health-check path directly and see the current response firsthand.

**The cost-guardrail path** runs on a completely separate schedule and completely separate data source — AWS's own billing pipeline, not CloudWatch:

1. AWS Cost Management continuously tracks the account's month-to-date actual spend and, using that trend, computes a forecasted spend for the full month.
2. At the moment forecasted spend crosses 80% of the `$50` limit (`notification_type = "FORECASTED"`, `threshold = 80`), AWS Budgets emails the subscribed address — this can fire *before* the month is even half over, purely on the trendline, which is the entire point of a forecast-based alert: catching a runaway cost trajectory while there's still time to intervene rather than after the money is already spent.
3. Separately, if actual month-to-date spend crosses 100% of the same `$50` limit (`notification_type = "ACTUAL"`, `threshold = 100`), a second email fires — this one reports money that has genuinely already been spent, not a projection.
4. Both notifications are advisory only. AWS Budgets, configured this way, does not stop anything, throttle anything, or scale anything down automatically — it has no `alarm_actions`-equivalent hook into ECS or any other resource in this Terraform. It's an email and nothing more; whatever happens next is entirely on the human who reads it.

---

## 5. Design Decisions & Tradeoffs

**One shared SNS topic for every alarm, rather than per-severity topics.** A more elaborate setup might route "the service is completely down" to a paging tool with a phone call and an escalation policy, while routing "CPU is a bit elevated" to a lower-urgency Slack channel. AstriX doesn't do that: `no_running_tasks`, `high_cpu`, `high_memory`, `target_5xx`, and `unhealthy_hosts` all publish to the exact same `aws_sns_topic.alerts`, which has exactly one subscriber. That's the right call at this project's actual scale — a single environment with a single person able to act on any of these — because a severity-routing scheme only pays for itself once there's a corresponding difference in *who* responds or *how urgently*, and here there isn't one: every alarm on this list currently reaches the same inbox regardless of how it's tiered. Building the routing machinery ahead of having a second person or a second response channel to route to would be complexity added against a need that doesn't exist yet. The moment there's an on-call rotation, or a desire to page for `no_running_tasks` while merely emailing for `high_cpu`, splitting topics (or moving the single topic's consumer to something like PagerDuty that natively supports severity routing) is the natural next step — and nothing about the current alarm resources would need to change, only what's listed in `alarm_actions`.

**`treat_missing_data` genuinely differs across the alarms, and the difference is deliberate, not incidental.** Four of the five alarms — `high_cpu`, `high_memory`, `target_5xx`, and `unhealthy_hosts` — use `treat_missing_data = "notBreaching"`: if CloudWatch simply doesn't receive a data point for a period (a brief metrics-pipeline gap, a quiet moment with zero requests to compute a 5xx rate from), the alarm assumes everything is fine rather than assuming the worst. That's the right default for metrics where "no data" is an ambiguous, often benign state. `no_running_tasks` is the one exception, set to `treat_missing_data = "breaching"` — and that's correct for the opposite reason: for this specific alarm, missing data *is* effectively the failure condition it exists to catch. If the ECS service has been scaled to zero, or crashed in a way that stops it from reporting `RunningTaskCount` at all, "no data" and "confirmed zero tasks" are indistinguishable in terms of what a human needs to know, so both are treated as an active alarm rather than silence.

That distinction surfaces a real, easy-to-miss coupling worth naming explicitly: `no_running_tasks` reads its metric from the `ECS/ContainerInsights` namespace (§3.4), not the plain `AWS/ECS` namespace the CPU/memory alarms use — and the `ECS/ContainerInsights` namespace only exists at all because `enable_container_insights` is turned on (§3.2). In the deployed dev environment that's true (`enable_container_insights = true`), so the alarm has a real metric to evaluate. But the two settings are configured through entirely separate variables with independent defaults — `enable_container_insights` defaults to `false`, `enable_ecs_alarms` defaults to `false` — and nothing in Terraform enforces that they move together. Flip Container Insights back off in a future `tfvars` edit while leaving alarms enabled, and `no_running_tasks` would very likely have no metric data to evaluate at all — which, combined with `treat_missing_data = "breaching"`, means the alarm would sit permanently in `ALARM` state rather than silently doing nothing. Not a bug exactly (a stuck-in-ALARM state is at least loud, unlike a silently broken alarm), but a genuine hidden dependency between two independently-toggleable booleans that's worth knowing about before touching either one.

**The SNS-email-confirmation gotcha — the single most important operational fact in this entire chapter.** `infra/README.md`'s Alerting section states it plainly:

> CloudWatch alarms (ECS CPU/memory/task-count in `modules/ecs`, ALB 5xx/unhealthy-host in `modules/alb`) publish to a single SNS topic (`aws_sns_topic.alerts` in `environments/dev/main.tf`), subscribed via the `alert_email` tfvar. **AWS sends a confirmation email to that address after the first `terraform apply` that creates the subscription — you must click it, or the subscription stays pending and nothing actually gets delivered.**

`infra/README.md:87`

This is worth internalizing as a general lesson, not just an AstriX-specific footnote: **alerting infrastructure can look completely deployed while silently delivering nothing.** `terraform apply` will succeed, `terraform plan` will show the subscription resource created with no errors, `aws sns list-subscriptions-by-topic` will show a subscription ARN — and none of that tells you whether the confirmation link was ever clicked. An unconfirmed SNS email subscription sits in `PendingConfirmation` state indefinitely; every alarm state change published to that topic is simply dropped for that subscriber, with no error surfaced anywhere in the alarm, the topic, or Terraform's own state. The exact same failure mode shows up constantly in other forms across the industry — a Slack incoming-webhook URL that was pasted with a typo, a PagerDuty integration key that was never actually verified against a live service, an email-based alert routed to an address nobody checks. The infrastructure-as-code layer can only prove that the *resources* exist; it can't prove that the human-in-the-loop step downstream of resource creation (clicking a link, verifying a webhook) actually happened. The practical takeaway is to always confirm delivery end-to-end after standing up a new alerting channel — trigger a real test alarm, or in AWS's case run `aws sns list-subscriptions-by-topic --topic-arn <arn>` and check for `SubscriptionArn` values that are still `"PendingConfirmation"` rather than an actual ARN — rather than trusting that "the `terraform apply` succeeded" is the same claim as "someone will actually be notified."

---

## 6. Security Considerations

**CloudWatch Logs can carry sensitive application data.** Every line the container writes to stdout/stderr — including a full stack trace on an unhandled exception, and whatever request context a log statement chooses to include — lands in this log group verbatim, with the same durability and access characteristics as any other CloudWatch resource. There's no redaction or scrubbing pipeline sitting between the application's `pino` logger and CloudWatch in this setup; whatever the application logs is exactly what ends up stored. That places real weight on application-level logging discipline (never logging a raw password, token, or full payment detail) as the actual control here, since the infrastructure layer applies none of its own.

**Log retention is a genuine security/compliance-relevant setting, and AstriX's is short.** At 7 days (`ecs_log_retention_days`, §3.1), the retention window cuts both ways. Shorter retention is a data-minimization win — it bounds how long any sensitive information that did end up in a log line remains recoverable, and it limits the blast radius if the log group's IAM permissions were ever misconfigured or a credential with read access were compromised. The cost is on the incident-response side: if a security review or an audit needs to reconstruct what happened more than a week ago, that evidence is already gone. Seven days is a reasonable dev-environment default; a production environment with real compliance obligations (retaining evidence for a defined incident-response window, or meeting a specific regulatory retention requirement) would typically set this considerably longer, and would pair it with actually exporting logs to a durable, cheaper archive (e.g., a scheduled export to S3) rather than relying on CloudWatch's native retention alone for anything long-lived.

**Who can read this log group matters as much as what's in it.** The [IAM chapter](./04-identity-and-access-management.md) covers ECS's execution/task role split and the account's broader least-privilege posture in full; the narrow point specific to this file is that the log group is only as protected as the IAM policies granting `logs:GetLogEvents`/`logs:FilterLogEvents` on it, and every principal (human or automated) with that permission can read anything the application ever wrote to stdout, sensitive or not.

**The alarm/SNS pipeline is itself an availability-relevant control, not just a convenience.** Its entire job is reducing mean-time-to-detection for an incident — including the availability-impacting kind, like a task crash-looping or a sustained wave of 5xx responses that could just as easily be a genuine outage as an active denial-of-service attempt. If that pipeline is silently broken (the unconfirmed-subscription failure mode from §5 being the most concrete example), the system loses its only automated early-warning mechanism entirely, and detection reverts to "a user or a developer happens to notice." That makes the alerting pipeline's own reliability worth treating as seriously as any other piece of infrastructure — verifying it actually delivers, not just that it was successfully applied, deserves to be part of any post-deploy checklist.

---

## 7. Best Practice Check

**Is CloudWatch as the sole observability backbone reasonable in 2026, for a project at this scale?** Yes, plainly. For a single backend service behind one ALB, in one environment, with no dedicated platform or SRE team to operate a separate metrics database or pay a SaaS APM bill, CloudWatch's zero-extra-infrastructure integration is exactly the right-sized choice — every alternative surveyed in §1 trades that simplicity for either an operational burden (Prometheus/Grafana, ELK/OpenSearch) or a recurring cost and lock-in profile (Datadog/New Relic) that doesn't pay for itself yet at this scale. The point at which that calculus flips — multiple services, a team large enough to have dedicated on-call, log volumes or query needs CloudWatch Logs Insights genuinely can't satisfy — is also the point at which the operational and financial cost of the alternatives starts being worth paying.

**Structured logging: this is a real strength, not a gap.** The backend logs through `pino`/`pino-http` (`backend/src/utils/logger.ts`, `backend/src/index.ts`) with structured JSON output and a per-request ID attached to every log line — not a `console.log`-based, unstructured-text setup. That's directly useful here: because the ECS `awslogs` driver ships that JSON straight into CloudWatch Logs, CloudWatch Logs Insights can query on individual JSON fields (log level, request ID, status code) rather than doing brittle text-pattern matching over free-form strings, and because every log line for a given request carries the same request ID, correlating an alarm's timing against the specific request(s) that triggered it is realistic even without a dedicated tracing system.

**Named, honest gaps:**

- **No distributed tracing / OpenTelemetry.** There's no trace context propagation, no spans, and no tracing backend (AWS X-Ray or otherwise) anywhere in this stack. In a microservices architecture — the environment distributed tracing was built to solve — this would be a significant blind spot, since a single failing request could cross a dozen service boundaries with no way to see which hop actually introduced the latency or the error. AstriX is a single backend service talking to one external dependency (MongoDB Atlas) today, not a microservices mesh, so the specific problem tracing solves — "which of these many services did this request's time actually go" — mostly doesn't apply yet. The structured, request-ID-tagged logging described above covers a meaningful fraction of what tracing would otherwise be needed for at this architecture's current size; the gap becomes considerably more consequential the moment the backend is split into more than one deployed service.
- **No alarm severity differentiation or paging-tool integration.** Every alarm, regardless of how urgent its underlying condition actually is, reaches the same single email address with no distinction between "worth investigating this week" and "wake someone up right now." As covered in §5, that's the appropriate tradeoff for a single-person, single-environment project — the missing machinery (severity-tiered topics, a PagerDuty/Opsgenie integration with escalation policies) is exactly the kind of investment that earns its keep once there's an actual on-call rotation or team large enough to need differentiated response, not before.

---

## 8. Debug Drill

**Scenario:** CPU usage is visibly elevated in the CloudWatch console — the `CPUUtilization` metric graph for the ECS service clearly shows it sitting well above 80% — but the `high_cpu` alarm never transitioned to `ALARM`, and no email ever arrived. Where do you look first, and in what order?

1. **Confirm the alarm resource exists at all.** Every alarm in this module is gated behind `count = var.enable_alarms ? 1 : 0` (§3.4). If `enable_ecs_alarms` were ever `false` at apply time, `terraform apply` would have quietly created zero alarm resources — no error, just nothing to evaluate anything. Check with `aws cloudwatch describe-alarms --alarm-names astrix-dev-ecs-high-cpu`; if it comes back empty, the alarm was never created, and the fix is a Terraform variable check, not a CloudWatch investigation.
2. **If the alarm exists, check which dimensions and namespace it's actually evaluating against.** `high_cpu` filters on `ClusterName`/`ServiceName` dimensions within the `AWS/ECS` namespace (§3.4). If the CPU graph a person is looking at in the console is scoped differently — a per-task view, a different service, or a Container-Insights-specific CPU metric under a different namespace than the one the alarm reads — the two aren't actually looking at the same data series, even though both are labeled "CPU." Confirm the alarm's `Dimensions` field in `describe-alarms` output matches the exact cluster and service name shown in the console graph the human is looking at.
3. **Check the alarm's current state and state-transition history directly**, rather than trusting the console graph's color coding: `aws cloudwatch describe-alarms --alarm-names astrix-dev-ecs-high-cpu --query 'MetricAlarms[0].[StateValue,StateReason]'`. An alarm sitting in `INSUFFICIENT_DATA` rather than `OK` or `ALARM` means CloudWatch hasn't actually received the two consecutive 60-second data points `evaluation_periods = 2` requires — worth ruling out before assuming the threshold logic itself is wrong.
4. **Re-derive whether the threshold was actually, sustainedly crossed for the required window** — `comparison_operator = "GreaterThanThreshold"`, `threshold = 80`, over `evaluation_periods = 2` at `period = 60`. A brief spike to 95% for 30 seconds that dips back down before the second consecutive 60-second period completes will show as "visibly high" on a console graph with a coarse enough time axis, while never actually satisfying "two full consecutive periods above 80" as the alarm's own logic requires. This is the single most common gap between "looks alarming on a graph" and "the alarm didn't fire" — the graph shows every data point; the alarm only reacts to a specific, sustained pattern across it.
5. **Once the alarm state itself is confirmed correct (it really did transition to `ALARM`), move to the SNS delivery side rather than the alarm configuration** — this is where the §5 confirmation-email gotcha becomes the prime suspect for "the alarm fired but nothing was delivered." Run `aws sns list-subscriptions-by-topic --topic-arn <alerts topic arn>` and check whether the subscription's `SubscriptionArn` is a real ARN or still the literal string `"PendingConfirmation"`. If it's pending, the alarm did exactly what it was configured to do; the notification simply had nowhere confirmed to go.

The general pattern: a console graph, an alarm's evaluated state, and actual notification delivery are three separate things that can each be correct or broken independently of the other two. "It looks wrong on the dashboard" only rules out the first; confirming the alarm resource exists, evaluating the right metric, in the right state, and that its target subscription is actually confirmed are four more, entirely separate facts worth checking in order before assuming the alarm's own threshold logic is at fault.
