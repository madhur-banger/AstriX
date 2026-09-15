# Compute & Container Orchestration: ECS Fargate

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md).

Every previous file in this module assumed a container image already exists somewhere runnable — [file 01](./01-containerization-and-docker.md) built it, [file 05](./05-container-registry-and-image-lifecycle.md) stored it in ECR. This file is about the missing piece between "an image sits in a registry" and "a request from a real user gets an HTTP response": something has to decide how many copies of that image run, where they run, what happens when one crashes, and how a new version replaces an old one without downtime. That "something" is a container orchestrator, and the landscape of real options for it is wide enough that picking one is a genuine architectural decision, not a checkbox.

---

## 1. The Landscape

Strip away vendor branding and every container-compute option answers the same four questions differently: who provisions the underlying host, who schedules containers onto it, who scales it, and who patches it. Four real, named approaches cover the vast majority of production systems today.

**(a) Raw EC2 — you run everything yourself.** No orchestrator at all: you launch EC2 instances, SSH or use a config-management tool (Ansible, Chef) to install a container runtime, write your own scripts (or a launch-template + Auto Scaling Group) to decide how many instances exist, and you are personally responsible for OS patching, security-group management at the instance level, and — if a container process dies — for the observability and restart logic to notice and recover. A minimal version looks like:

```bash
# a hand-rolled "orchestrator": cron + a restart script on a raw EC2 box
docker run -d --restart unless-stopped -p 8000:8000 myregistry/backend:latest
```

**Tradeoffs:** maximum control — you can tune the kernel, install arbitrary host-level agents, run anything a container can't easily express — at maximum operational burden. You own AMI patching, instance-level security hardening, capacity planning (over-provision and pay for idle, or under-provision and get paged), and you've built a bespoke, unaudited scheduler the moment you write "if the process isn't running, restart it" in a shell script. This is the right choice when you need host-level control containers don't give you (specialized hardware, kernel modules, licensing tied to bare metal) and increasingly rare otherwise.

**(b) ECS on EC2 — AWS's orchestrator, your EC2 fleet.** Amazon ECS is AWS's own container orchestrator: it schedules containers, tracks their health, and handles rolling deployments. In its original launch mode, ECS schedules those containers onto EC2 instances that you still own and register into the cluster as "container instances" — each one runs the `ecs-agent` daemon that reports capacity back to ECS and receives task placements from it.

```hcl
# EC2 launch type: the cluster is fundamentally a fleet of EC2 instances
# you provisioned, patch, and pay for whether or not tasks are running on them
resource "aws_autoscaling_group" "ecs_capacity" {
  # ... launches EC2 instances running the ECS agent
}
resource "aws_ecs_service" "app" {
  launch_type = "EC2"
}
```

**Tradeoffs:** you get ECS's scheduling, health checks, and deployment orchestration without hand-rolling them, and — because you control the instances — you can pack multiple tasks per instance for higher CPU/memory utilization than Fargate typically achieves, which matters at high, sustained scale where bin-packing efficiency translates directly into cost savings. The cost: you're back to owning an EC2 fleet — AMI patching, scaling the *instances* (a second, separate scaling policy from scaling the *tasks*), and capacity headroom for burst traffic that sits idle (and billed) the rest of the time.

**(c) ECS Fargate — AWS's orchestrator, serverless compute.** Same ECS scheduler and API as (b), but AWS itself owns the underlying compute — there is no EC2 instance to launch, patch, or scale at the infrastructure layer at all. You declare a task's CPU/memory shape, and AWS places it on managed capacity you never see or touch. **This is what AstriX uses**, detailed for the rest of this file.

**Tradeoffs:** no host-level operations whatsoever — no AMIs, no instance patch Tuesday, no capacity-planning spreadsheet — at a real, honest cost premium: Fargate bills per vCPU-second and GB-second of the *task's declared* shape, and that per-unit rate runs meaningfully higher than the equivalent EC2 on-demand (or reserved/spot) rate for the same vCPU/memory, because you're paying AWS to absorb the fleet-management work instead of doing it yourself. For a workload with modest, fairly steady request volume, that premium is a reasonable price for the operational time it buys back; for a workload running at large, sustained, predictable scale, ECS-on-EC2 (or EKS with reserved-instance node groups) can be materially cheaper per unit of compute once someone is dedicated to running the fleet.

**(d) Kubernetes/EKS — the industry-default, portable orchestrator.** Kubernetes is, by a wide margin, the orchestrator most engineers will encounter across their career, and naming it as "the alternative AstriX didn't pick" undersells how legitimate a choice it is for a huge number of real teams. Its core abstractions — a **Pod** (one or more co-located containers, the smallest deployable unit), a **Deployment** (a desired-state declaration of how many replicas of a Pod template should exist, with rolling-update semantics), and a **Service** (a stable network identity that load-balances across a Deployment's Pods as they come and go) — form a vocabulary that is identical whether the cluster runs on AWS's EKS, Google's GKE, Azure's AKS, bare metal, or a laptop via `minikube`:

```yaml
# the k8s vocabulary: Deployment (desired state) + Service (stable network identity)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: backend
          image: myregistry/backend:latest
---
apiVersion: v1
kind: Service
metadata:
  name: backend
spec:
  selector: { app: backend }
  ports: [{ port: 80, targetPort: 8000 }]
```

Real reasons a team reaches for it, honestly stated: **portability** — the same manifests run on any cloud or on-prem, which matters enormously to a company that sells software to customers who run their own Kubernetes, or that wants genuine multi-cloud leverage rather than lock-in to one vendor's proprietary orchestration API; **ecosystem** — an enormous, mature landscape of tooling built directly on the Kubernetes API (Helm for packaging, Argo CD/Flux for GitOps, Istio/Linkerd for service mesh, the entire CNCF landscape of operators for databases, message queues, and certificate management) that ECS simply doesn't have an equivalent depth of; and **organizational scale** — once a company runs dozens of services across multiple teams, Kubernetes's namespace isolation, fine-grained RBAC, and the sheer number of engineers who already know it from a previous job become real assets, not just resume-driven adoption.

Just as honestly: the reasons a project AstriX's size would *not* reach for it are real, not manufactured. Running EKS means running (or paying AWS a per-cluster hourly fee to run) a control plane, and even with that control plane managed, you still own node-group scaling, CNI/networking plugin choices, cluster upgrades on a real cadence, and a YAML surface area — Deployments, Services, Ingresses, ConfigMaps, RBAC bindings, admission controllers — that is genuinely large to learn and operate correctly. Fargate gets a team roughly 90% of the "I don't manage servers" benefit Kubernetes promises, with a small fraction of the operational surface: no cluster control plane to run at all, no node-group AMI to patch, no CNI plugin to pick. For a single-service (or few-service) project without a multi-cloud portability requirement or an existing organizational Kubernetes investment, that trade genuinely favors Fargate — which is exactly why Kubernetes appears here as a real, honestly-argued alternative and nowhere else in this codebase.

**(e) Lambda/serverless functions — a non-container-orchestrator alternative.** Worth naming even though it's a different compute model entirely: AWS Lambda (and its equivalents, Cloud Functions, Azure Functions) runs individual function invocations in response to events, with no persistent process, no container orchestration concept, and billing per invocation/duration rather than per always-on task. It's an excellent fit for event-driven, bursty, or infrequent workloads (a webhook handler, a nightly batch job, an image-resize trigger), and a poor fit for a long-lived, stateful, WebSocket-capable HTTP API server like AstriX's backend — cold starts, a 15-minute maximum execution time, and no persistent in-memory connection pooling make it the wrong shape for this specific workload, which is why it doesn't appear as a serious contender for AstriX's backend compute even though it's a legitimate, widely-used part of the real landscape.

---

## 2. AstriX's Choice

AstriX runs its backend on **ECS Fargate** — option (c) above: AWS's own container scheduler, with zero EC2 instances to provision, patch, or scale, paired with target-tracking autoscaling on CPU and memory and a deployment circuit breaker that automatically rolls back a bad deploy without a human in the loop. The rest of this file is that implementation in full.

---

## 3. AstriX Implementation

### 3.1 CloudWatch log group

Created ahead of the task definition specifically to avoid a race where the task starts logging before its destination exists:

```hcl
# infra/modules/ecs/main.tf:22-29
resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${var.project_name}-${var.environment}-backend"
  retention_in_days = var.log_retention_days

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-backend-logs"
  })
}
```

### 3.2 ECS cluster and capacity providers

```hcl
# infra/modules/ecs/main.tf:36-68
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
```

A cluster in ECS is a namespace, not a fleet — there's no host inventory to see here, because Fargate is the compute. The capacity provider strategy just tells ECS which billing/availability class of Fargate capacity to place tasks on: `FARGATE` (standard, always-available) versus `FARGATE_SPOT` (spare AWS capacity at a steep discount, reclaimable with two minutes' notice). AstriX's `default_capacity_provider_strategy` runs entirely on standard `FARGATE` — `fargate_weight = 1`, `fargate_base = 1` (`infra/modules/ecs/variables.tf:229-239`) — with the FARGATE_SPOT weight commented out and its variable defaulted to `0` (`infra/modules/ecs/variables.tf:241-245`), so Spot capacity is wired into the module but not actually in use for this deployment.

### 3.3 The ECS task definition

```hcl
# infra/modules/ecs/main.tf:75-209
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
      # node:20-alpine (the production image) doesn't ship curl - it does
      # ship BusyBox wget, so this avoids adding a package just for the
      # health check.
      healthCheck = {
        command     = ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:${var.container_port}${var.health_check_path} || exit 1"]
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

  # CI (deploy-backend.yml force-new-deployment against the ":latest" tag,
  # and rollback.yml registering a commit-SHA-pinned revision directly) owns
  # the running image after the first apply - not Terraform. Without this,
  # the next `terraform apply` re-registers a revision pointing at whatever
  # ":latest" currently resolves to in ECR, silently undoing any rollback.
  # Terraform still owns everything else about the task def (CPU/memory,
  # secrets wiring, log config, health check).
  lifecycle {
    ignore_changes = [container_definitions]
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-backend-task"
  })
}
```

A task definition is the "what to run" half of ECS — it names a family (a versioned template; every `register-task-definition` call creates a new numbered revision), the resource shape (`cpu`/`memory`, drawn from Fargate's fixed vCPU/memory combinations — AstriX's `dev` config uses `task_cpu = 512` / `task_memory = 1024`, i.e. 0.5 vCPU / 1 GB, `infra/environments/dev/terraform.tfvars:147-148`), the two IAM roles a Fargate task always needs (covered in §6 and in full in [file 04](./04-identity-and-access-management.md)), and — inside `container_definitions` — every container that runs inside the task's shared network namespace. AstriX runs a single `backend` container per task.

### 3.4 The ECS service

```hcl
# infra/modules/ecs/main.tf:216-269
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

  # Deployment Circuit Breakerdc
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
```

The service is the "keep this many running, this way" half — it's the resource that actually watches `desired_count`, launches/replaces tasks to match it, and drives a deployment (a rollout from one task-definition revision to the next) according to `deployment_minimum_healthy_percent`/`deployment_maximum_percent` (100/200 in AstriX's `dev` config, `infra/environments/dev/terraform.tfvars:150-151` — meaning a deployment never drops below the current desired count of healthy tasks and can temporarily run up to double, a classic rolling deployment shape covered in depth in [file 13](./13-deployment-strategies-and-rollback.md)). `network_configuration` places tasks into the private subnets from [file 02](./02-networking-and-vpc-design.md) behind the ECS security group from [file 03](./03-security-groups-and-network-segmentation.md), and `load_balancer` registers each task into the ALB target group ([file 07](./07-load-balancing-and-traffic-routing.md)) by container name and port — this single block is what makes a Fargate task reachable from the internet at all, since the task itself has no public IP.

### 3.5 Auto scaling target and policies

```hcl
# infra/modules/ecs/main.tf:276-318
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
```

`aws_appautoscaling_target` registers the ECS service's `DesiredCount` as a dimension the Application Auto Scaling service is allowed to adjust, bounded between `min_capacity` (1) and `max_capacity` (4) in AstriX's `dev` config (`infra/environments/dev/terraform.tfvars:154-155`). The two policies are both **target-tracking** — you declare a target value and AWS's own control loop (a PID-style controller, not a fixed step function) continuously adjusts `DesiredCount` to hold the metric near that target, rather than you writing "if CPU > X, add N tasks" step-scaling rules yourself. AstriX targets 70% CPU and 80% memory (`infra/environments/dev/terraform.tfvars:156-157`), with a 5-minute scale-in cooldown and a 1-minute scale-out cooldown (`infra/environments/dev/terraform.tfvars:158-159`) — asymmetric on purpose, discussed in §5.

### 3.6 CloudWatch alarms

These three alarms exist in the same file and are real, wired resources — they're covered here for completeness of what the module creates, but the deeper theory of alarm design, thresholds, and alerting strategy is [file 14](./14-observability-monitoring-and-alerting.md)'s job, not this one's:

```hcl
# infra/modules/ecs/main.tf:326-398
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

# high_memory: identical shape, MemoryUtilization, threshold 80 (infra/modules/ecs/main.tf:351-373)

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

Worth noting the `no_running_tasks` alarm specifically reads from the `ECS/ContainerInsights` namespace rather than `AWS/ECS` — `RunningTaskCount` is a Container Insights metric, meaning this particular alarm only produces data when `enable_container_insights` is on (§7).

### 3.7 Wiring in `dev/main.tf`

```hcl
# infra/environments/dev/main.tf:376-415
module "ecs" {
  source                             = "../../modules/ecs"
  project_name                       = var.project_name
  environment                        = var.environment
  aws_region                         = var.aws_region
  aws_account_id                     = data.aws_caller_identity.current.account_id
  private_subnet_ids                 = module.networking.private_subnet_ids
  ecs_security_group_id              = module.security.ecs_tasks_security_group_id
  target_group_arn                   = module.alb.target_group_arn
  ecs_task_execution_role_arn        = module.iam.ecs_task_execution_role_arn
  ecs_task_role_arn                  = module.iam.ecs_task_role_arn
  ecr_repository_url                 = module.ecr.backend_repository_url
  image_tag                          = var.ecs_image_tag
  container_port                     = var.app_port
  node_env                           = var.node_env
  health_check_path                  = var.health_check_path
  task_cpu                           = var.ecs_task_cpu
  task_memory                        = var.ecs_task_memory
  desired_count                      = var.ecs_desired_count
  deployment_minimum_healthy_percent = var.ecs_deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.ecs_deployment_maximum_percent
  health_check_grace_period          = var.ecs_health_check_grace_period
  enable_ecs_exec                    = var.enable_ecs_exec
  min_capacity                       = var.ecs_min_capacity
  max_capacity                       = var.ecs_max_capacity
  cpu_target_value                   = var.ecs_cpu_target_value
  memory_target_value                = var.ecs_memory_target_value
  scale_in_cooldown                  = var.ecs_scale_in_cooldown
  scale_out_cooldown                 = var.ecs_scale_out_cooldown
  fargate_weight                     = var.ecs_fargate_weight
  fargate_base                       = var.ecs_fargate_base
  fargate_spot_weight                = var.ecs_fargate_spot_weight
  log_retention_days                 = var.ecs_log_retention_days
  enable_container_insights          = var.enable_container_insights
  enable_alarms                      = var.enable_ecs_alarms
  alarm_actions                      = [aws_sns_topic.alerts.arn]

  common_tags = local.common_tags
  depends_on  = [module.alb, module.parameter_store]
}
```

This is a plain composition root — every input traces to either another module's output (the networking/security/ALB/IAM/ECR modules from earlier files) or a `dev`-environment variable, and the explicit `depends_on = [module.alb, module.parameter_store]` exists because Terraform can't infer that the ECS service needs the ALB's target group and the Parameter Store's parameters (referenced by ARN string interpolation, not a resource reference, inside the task definition's `secrets` block) to exist before it registers.

---

## 4. Request/Data Flow

**Scale-out under CPU pressure.** Traffic increases, the `backend` container's CPU usage climbs, and the `AWS/ECS` `CPUUtilization` metric for the service starts reporting values above the 70% target. The `scale_up_cpu` target-tracking policy's underlying CloudWatch alarm (AWS creates and manages this alarm automatically for a target-tracking policy — it isn't one of the three explicit alarms in §3.6) evaluates and, once sustained past the policy's internal evaluation window, calls Application Auto Scaling's `SetDesiredCapacity` against the registered scalable target from §3.5. That call increases `aws_ecs_service.backend`'s `desired_count`. The ECS service scheduler notices actual running count is now below desired count and asks Fargate to place new tasks — and because this is Fargate, "place a task" means AWS provisions the underlying host capacity itself, invisibly; there is no EC2 instance to launch, no capacity to pre-warm, no bin-packing decision for you to make. The new tasks pull the image from ECR (the execution role from [file 04](./04-identity-and-access-management.md) authorizes this), fetch their secrets from Parameter Store, and start. Each new task registers into the ALB target group per the `load_balancer` block in §3.4 — but registration alone doesn't mean traffic starts flowing: the ALB's own target-group health check (a separate, ALB-side check from the container's `healthCheck` in §3.3, both hitting the same `/health` path but evaluated by different systems — see [file 07](./07-load-balancing-and-traffic-routing.md) for the target group's health-check block) must pass before the ALB marks the target `healthy` and begins routing real requests to it. Only after that does the new capacity actually absorb load; a task that's "running" but not yet "healthy" contributes zero relief to the CPU pressure that triggered the scale-out in the first place.

**A bad deploy and the circuit breaker.** A new task-definition revision is deployed — CI registers it and calls `force-new-deployment` against the ECS service. The service starts launching new tasks on the new revision while (per `deployment_minimum_healthy_percent = 100`) keeping the old, still-healthy tasks running. Suppose the new revision has a bug that makes the container's `/health` endpoint return errors, or the process crash-loops before ever binding to its port. The container-level `healthCheck` in §3.3 starts failing after its `startPeriod` grace window (60 seconds) elapses, and ECS marks the new tasks `UNHEALTHY` after `retries` (3) consecutive failures at a 30-second `interval`. Because `deployment_circuit_breaker { enable = true, rollback = true }` is set (§3.4), ECS itself — not a human watching a dashboard — detects that the new deployment cannot reach a healthy steady state within its internal threshold for consecutive task failures, marks the deployment failed, and automatically re-deploys the last known-good task-definition revision in its place. The old tasks that were never torn down (because `deployment_minimum_healthy_percent = 100` never let healthy capacity drop) continue serving traffic throughout, so from the outside, a caught bad deploy looks like nothing happened at all. This automatic-rollback mechanism is a specific safety net, not the full deployment-strategy story — [file 13](./13-deployment-strategies-and-rollback.md) covers the complete rolling-deployment shape and the separate, manual `rollback.yml` workflow that exists for rollbacks a human decides to trigger deliberately.

---

## 5. Design Decisions & Tradeoffs

**Fargate over ECS-on-EC2.** AstriX never has to answer "how many EC2 instances should the cluster have" as a separate question from "how many tasks should run" — there's exactly one capacity knob (`desired_count`/autoscaling bounds), not two independently-scaled resources that can drift out of sync (an EC2 fleet with headroom nobody's using, or a fleet too small to schedule the tasks autoscaling just asked for). There's no AMI to patch, no `ecs-agent` version to keep current, no instance-level security patching cadence to own. The honest cost, named plainly in §1(c): Fargate's per-vCPU/GB-hour rate is a real premium over the equivalent EC2 on-demand rate for the same shape, because that premium is the price of AWS absorbing the fleet-management work Section §1(b) describes. At AstriX's current scale (`min_capacity = 1`, `max_capacity = 4`, `task_cpu = 512`), that premium is a small absolute dollar amount; it would be worth re-litigating if this service ever needed to run dozens of large, always-on tasks continuously, where ECS-on-EC2's bin-packing efficiency would start to meaningfully undercut Fargate's per-task pricing.

**Why `lifecycle { ignore_changes = [container_definitions] }` exists.** This solves a real, subtle ownership-boundary problem between Terraform and CI that's easy to get wrong. The task definition's `image` field is `"${var.ecr_repository_url}:${var.image_tag}"`, and `image_tag` defaults to `"latest"` — a *mutable* tag that points at whatever was most recently pushed. Without `ignore_changes`, every single `terraform apply` — even one made for a completely unrelated reason, like bumping the ALB's idle timeout — would re-evaluate `container_definitions`, re-resolve `:latest` to whatever image currently sits behind that tag in ECR, and silently re-register a task-definition revision pinned to it. If `rollback.yml` had just pinned the service to an older, known-good SHA-tagged revision because the `:latest` image was broken, the very next unrelated `terraform apply` would undo that rollback without anyone touching image configuration at all. The module's own comment states the resolution directly: *"CI (deploy-backend.yml force-new-deployment against the ':latest' tag, and rollback.yml registering a commit-SHA-pinned revision directly) owns the running image after the first apply — not Terraform... Terraform still owns everything else about the task def (CPU/memory, secrets wiring, log config, health check)"* (`infra/modules/ecs/main.tf:195-201`). Terraform declares the task's shape once; CI owns which image is actually running from then on.

**Why `lifecycle { ignore_changes = [desired_count] }` on the service.** The identical class of problem, one level up: `desired_count` is a Terraform input (`var.desired_count`, default 2), but autoscaling is *also* allowed to change it continuously in response to load. Without this `ignore_changes`, a routine `terraform apply` would see the service's actual `desired_count` (say, 4, because autoscaling scaled out under load) diverge from the Terraform-declared value of 2, and "correct" it back down to 2 — fighting the autoscaling policy that scaled up for a real reason, on every single apply, regardless of current load. `ignore_changes = [desired_count]` (`infra/modules/ecs/main.tf:258-261`) hands ongoing ownership of that field to `aws_appautoscaling_target`/the two target-tracking policies once the resource first exists, the same ownership-handoff pattern as `container_definitions` above, just for a different owner (autoscaling instead of CI).

**Two separate policies (CPU and memory) instead of one.** A single service can be bottlenecked on either resource independently — a CPU-bound workload (heavy JSON serialization, cryptographic hashing) can peg CPU while memory sits comfortably low, and a memory-bound workload (large in-process caches, connection pools holding buffered data) can do the reverse. Target-tracking scaling policies each track exactly one metric; there's no single "resource pressure" composite metric to target instead. Running both policies against the same scalable target means ECS scales out if *either* signal crosses its target — whichever policy's alarm fires first drives the `SetDesiredCapacity` call — giving the service protection against both failure modes without requiring an operator to predict in advance which resource this specific workload will bottleneck on first.

**Asymmetric cooldowns.** `scale_out_cooldown = 60` seconds is short and `scale_in_cooldown = 300` seconds (5 minutes) is five times longer (`infra/environments/dev/terraform.tfvars:158-159`). This is deliberate, not an oversight: reacting slowly to rising load risks real request failures or latency spikes while capacity catches up, so scaling out is biased toward speed. Reacting quickly to falling load risks the opposite failure — scaling back in the moment a brief lull appears, only to immediately need to scale back out again when traffic resumes seconds later, a thrashing pattern that provides no cost benefit (Fargate bills per-second while a task runs, so a task that lives 5 extra minutes past a lull costs little) and real risk (tearing down capacity right before a second traffic wave). Biasing scale-in toward patience while biasing scale-out toward speed is the standard shape of this tradeoff industry-wide, not an AstriX-specific choice.

**The deployment circuit breaker as a safety net, not the deployment strategy itself.** `deployment_circuit_breaker { enable = true, rollback = true }` doesn't decide *how* traffic shifts from an old revision to a new one — that's still the rolling deployment shape governed by `deployment_minimum_healthy_percent`/`deployment_maximum_percent` (§3.4). What it adds is a failure detector layered on top of that rollout: an automatic promise that a deployment which can never reach a healthy steady state gets reverted without a human needing to notice and intervene manually. It's a meaningfully different mechanism from blue-green or canary strategies (which shift traffic gradually or to a fully separate environment before committing) — the full comparison of those strategies against AstriX's rolling-plus-circuit-breaker approach belongs to [file 13](./13-deployment-strategies-and-rollback.md).

---

## 6. Security Considerations

**Two IAM roles, two distinct trust boundaries.** The task definition declares `execution_role_arn` and `task_role_arn` separately (`infra/modules/ecs/main.tf:82-84`) — the execution role is what the ECS agent itself assumes to pull the image from ECR and fetch the `secrets` block's Parameter Store values before the container ever starts; the task role is what the application code inside the running container assumes for any AWS SDK calls it makes at runtime. Collapsing these into one role would mean the application process holds the same permissions needed to pull arbitrary images and read arbitrary secrets, a strictly larger blast radius than it needs. The full role definitions and their least-privilege policy scoping live in [file 04](./04-identity-and-access-management.md); this file only needs the ownership split, not a re-derivation of it.

**Secrets are injected via ARN reference, never baked into the image or `environment`.** Every credential the backend needs — the Mongo connection string, both JWT signing secrets, the Google OAuth client secret — appears in the `secrets` array as a `valueFrom` pointing at a Parameter Store ARN (`infra/modules/ecs/main.tf:115-160`), resolved by the ECS agent at container start using the execution role's permissions, and never appears in `environment`, in the image layers, or in Terraform state as plaintext. This matters concretely: `docker inspect` on a running task, or an `ecr:BatchGetImage` pull by an unrelated principal, reveals nothing — the secret only ever exists inside the container's own process memory once injected. The deeper mechanics of Parameter Store, the KMS key that encrypts these values, and the manual rotation runbook are [file 09](./09-secrets-and-configuration-management.md)'s subject.

**`assign_public_ip = false` — tasks have no public IP, ever.** (`infra/modules/ecs/main.tf:237`) A backend task cannot be reached directly from the internet under any circumstance; the only path in is through the ALB, which itself only forwards to the target group after the ECS security group's ingress rule permits traffic from the ALB's security group specifically — the full chain is [file 03](./03-security-groups-and-network-segmentation.md)'s subject. This is defense in depth on top of the private-subnet placement from [file 02](./02-networking-and-vpc-design.md): even a security-group misconfiguration that accidentally opened a port wouldn't matter without a public IP for anyone external to reach in the first place.

**The health check runs `wget`, not `curl`, and that's a real constraint, not a stylistic choice.** The module's own comment is explicit: *"node:20-alpine (the production image) doesn't ship curl - it does ship BusyBox wget, so this avoids adding a package just for the health check"* (`infra/modules/ecs/main.tf:173-175`). This is the same Alpine-minimalism tradeoff [file 01](./01-containerization-and-docker.md) covers for the image itself — a smaller base image means a smaller attack surface and fewer packages to patch, but it also means common tools (`curl`, `bash` in some minimal variants) aren't assumed to exist, and infrastructure code has to work around their absence rather than assume they're there. The health check itself is a liveness signal ECS uses at the container level (distinct from, though pointed at the same `/health` path as, the ALB's own target-group health check) — a container that fails it repeatedly is one ECS stops trusting to receive traffic and, per the deployment circuit breaker in §4, one whose deployment ECS will eventually give up on and roll back.

---

## 7. Best Practice Check

**Target-tracking autoscaling on CPU and memory** is still squarely the 2026 baseline for ECS/Fargate workloads — it remains the right default because it requires no manual threshold-tuning beyond picking a target percentage, and AWS's own control loop handles the scale math. Where some more mature 2026 setups go further is scaling on **custom application-level metrics** — request-queue depth, p99 latency, or a custom CloudWatch metric published from the application itself (e.g., active WebSocket connection count) — via `aws_appautoscaling_policy` resources with a `customized_metric_specification` block instead of `predefined_metric_specification`. CPU and memory are proxies for load; a custom queue-depth or latency metric measures the thing you actually care about (is the service keeping up with demand) more directly, and can catch scaling needs that CPU/memory alone miss — for instance, a service blocked on slow downstream I/O can show low CPU while still falling behind on request throughput. AstriX doesn't do this today; naming it here as a real, honest next step for a service that outgrows CPU/memory as sufficient proxies, not as a deficiency in the current setup.

**Is Container Insights actually on?** Checking rather than assuming: the module's own variable default is `false` (`infra/modules/ecs/variables.tf:261-265`, comment: `"Set to true in prod"`), and the `dev` environment's own variable default is also `false` (`infra/environments/dev/variables.tf:441-445`) — but the actual configured value in `infra/environments/dev/terraform.tfvars:164` (and mirrored in `terraform.tfvars.example:141`) sets `enable_container_insights = true`. So the `dev` deployment as actually configured runs with Container Insights **enabled**, overriding both defaults. That's a reasonable choice, not a wasteful one: Container Insights carries its own CloudWatch cost (additional metrics and log-derived data), and turning it off by default at the module/variable level keeps that cost opt-in for environments that don't need it, while the actual `dev` deployment opts in anyway — plausibly because the `no_running_tasks` alarm (§3.6) specifically depends on the `ECS/ContainerInsights` namespace's `RunningTaskCount` metric to function at all. Enabling it in a single-environment `dev` deployment that's standing in for what would eventually be a production environment is a sensible tradeoff, not a place where cost-cutting compromised observability.

**Is the deployment circuit breaker + rollback pattern current best practice?** Yes, plainly — this is exactly the pattern AWS itself recommends and most mature ECS deployments in 2026 run with enabled. Automatic detection-and-rollback of a deployment that can't reach a healthy steady state, with zero required human intervention, is the current standard; the only way to meaningfully exceed it is a fuller progressive-delivery strategy (canary/blue-green with automated metric-based promotion gates), which is a different, larger investment than the circuit breaker alone, covered where it belongs in [file 13](./13-deployment-strategies-and-rollback.md).

---

## 8. Debug Drill

**Scenario:** an ECS service's running task count keeps flapping — tasks start, briefly appear in the console, then get killed and replaced, over and over, never settling at the configured desired count.

**Where to look first, and why:**

1. **Task-level stopped-reason first, before anything else.** `aws ecs describe-tasks --cluster <cluster> --tasks <task-arn>` (or the equivalent console view) on one of the recently-stopped tasks returns a `stoppedReason` field directly — this is the fastest, most specific signal available and should be checked before forming any theory. A reason like `"Task failed ELB health checks in (target-group arn)"` points at the ALB-side health check failing even though the task itself may be running fine; `"Essential container in task exited"` points at the container process itself crashing; a resource-related stop reason points at something else entirely (e.g. a task that can't be placed at all due to capacity, which looks different from a task that starts and then dies).

2. **Compare the health-check grace period against actual application startup time.** `health_check_grace_period_seconds` (§3.4, `var.health_check_grace_period`, defaulting to 60) is the window during which the ECS service ignores ALB-reported unhealthy status for a newly-started task, on the assumption the application needs that long to finish booting (opening its database connection, warming caches) before it can honestly answer its own health endpoint. If the application genuinely takes longer than that window to become ready — a slow database connection handshake, a large in-memory cache warm-up — the ALB will report the target unhealthy and the service will kill and replace the task *before* it ever had a real chance to pass, and the replacement will hit the exact same timing problem, producing exactly the "starts and dies repeatedly" flapping pattern in the scenario. The container-level `healthCheck`'s own `startPeriod` (60 seconds, §3.3) is a second, separate grace window operating at the container-runtime level rather than the ALB level — worth checking that both numbers are actually consistent with real measured startup time, not just consistent with each other.

3. **CloudWatch Logs for the container's actual stdout/stderr**, at `aws_cloudwatch_log_group.ecs.name` (`/ecs/<project>-<environment>-backend`, streamed via `awslogs-stream-prefix = "ecs"`, §3.1/§3.3) — `aws logs tail <log-group> --follow` shows whatever the application printed in the seconds before each death, which is usually the fastest route to a root cause if the issue is inside the application itself (an unhandled startup exception, a failed required-environment-variable check, a database connection error) rather than in ECS's scheduling or health-check configuration.

4. **Check whether the target group's health check and the container's own health check are actually looking for the same thing.** Two independent health checks exist here — the ALB target group's (evaluated by the load balancer, hitting the path from [file 07](./07-load-balancing-and-traffic-routing.md)'s target group configuration) and the container's own `healthCheck` command (evaluated by the ECS agent inside the task, §3.3). Both point at the same `/health` path in AstriX's configuration, but they run on different intervals/timeouts/threshold counts and are evaluated by entirely different systems — it's possible for one to consider a task healthy while the other doesn't, especially if the application's `/health` endpoint itself does something non-idempotent or resource-intensive that behaves differently under concurrent probing from both checkers at once. Confirming both checks are hitting a genuinely lightweight, side-effect-free endpoint, and that their timing parameters (interval, timeout, threshold counts) aren't fighting each other, rules out a whole class of flapping that has nothing to do with the application's actual health.

Only after these four — stop reason, grace-period-vs-startup-time, application logs, and health-check consistency — should the investigation move to less likely explanations (a resource limit like `ulimits`'s `nofile` cap being hit under real load, or a security-group rule silently blocking the ALB's health-check traffic specifically while allowing real user traffic through some other path). Starting with the task's own stated stop reason is almost always the fastest path to a real answer, because ECS already knows why it killed the task — the investigation is usually a matter of reading that answer rather than guessing at one.
