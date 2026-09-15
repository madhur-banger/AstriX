# Load Balancing & Traffic Routing

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md). Builds on [`06-compute-and-container-orchestration-ecs-fargate.md`](./06-compute-and-container-orchestration-ecs-fargate.md), which covers how ECS Fargate runs the backend's tasks — this file is about how traffic actually finds those tasks in the first place.

A running container is useless to the internet until something decides which of possibly many identical copies of it should handle any given request, and does that decision-making fast enough and reliably enough that clients never notice tasks starting, stopping, or failing underneath them. That's the job description for the entire category of infrastructure this file covers: load balancing and traffic routing. It sounds like a narrow, mechanical problem — "spread requests across N servers" — but the actual design space is wide, because "spread requests" means something different depending on whether you're routing raw TCP connections, HTTP requests you can inspect and rewrite, or calls into a serverless function that doesn't have a long-lived process at all. AstriX picked one specific point in that space — a single public Application Load Balancer terminating TLS in front of a fleet of Fargate tasks — and this file surveys the landscape those alternatives live in before getting into exactly how AstriX's ALB is built, wired, and defended.

---

## 1. The Landscape

### (a) Application Load Balancers / Layer-7 load balancers generally

An L7 load balancer understands the protocol riding on top of TCP — for AWS's Application Load Balancer (ALB) and its self-managed equivalents, that protocol is HTTP/HTTPS. Because it can actually read the request — the path, the `Host` header, cookies, custom headers — it can make routing decisions no L4 device can: forward `/api/*` to one target group and `/static/*` to another, route `api.example.com` and `admin.example.com` (different `Host` headers hitting the same IP) to entirely different backend fleets, or terminate TLS once at the edge so every backend server is spared the CPU cost and certificate-management burden of doing it itself. AWS's ALB is the managed, cloud-native example; the self-managed equivalent of the exact same L7 concept is a reverse proxy you run yourself — **Nginx** or **HAProxy** sitting in front of a pool of application servers, doing the identical job (path/host-based routing, TLS termination, health checks) but as software you own, patch, and scale rather than a managed AWS service.

```nginx
# illustrative nginx.conf — not AstriX code
upstream backend_pool {
    server 10.0.1.10:3000;
    server 10.0.1.11:3000;
}
server {
    listen 443 ssl;
    location /api/ {
        proxy_pass http://backend_pool;
    }
}
```

**Tradeoffs:** HTTP-awareness is the entire value proposition — content-based routing, TLS termination, and rich health checks (an actual `GET /health` request, not just "is the TCP port open") all require understanding the protocol. The cost is throughput ceiling and per-request overhead relative to a device that never has to parse anything past the TCP header — an L7 balancer does real work (parsing headers, sometimes buffering a request) on every single request, which matters at extreme scale but is irrelevant for the overwhelming majority of web backends, AstriX included. Nginx/HAProxy specifically trade AWS's "fully managed, patch it never" convenience for total control — you choose the exact routing algorithm, tune the TLS stack yourself, and are also the one who owns upgrading it when a CVE lands.

### (b) Network Load Balancers / Layer-4 load balancers

An L4 load balancer operates purely at the TCP/UDP level — it sees source IP, destination IP, and port, and nothing about what's inside the packets. AWS's Network Load Balancer (NLB) is the canonical managed example: it can push millions of requests per second with microsecond-level added latency, because there's no protocol parsing happening at all — it's essentially a very fast, very reliable packet router with health checks. NLBs are the right tool when the protocol isn't HTTP at all (a raw TCP service, a custom binary protocol, gRPC in some architectures, UDP-based traffic like DNS or media streaming), or when the sheer volume of traffic makes even L7's modest per-request overhead too expensive to pay.

**Tradeoffs:** raw throughput and the lowest possible latency, at the cost of giving up every routing decision that requires seeing inside the request — no path-based routing, no header inspection, no native TLS termination with content awareness (an NLB can do TLS *passthrough* or basic termination, but it can't look at a decrypted request and route on its contents the way an ALB can). If your load balancer never needs to know what `/checkout` versus `/health` means, an NLB is strictly more efficient; the moment it does, you need L7.

### (c) API Gateway

A managed API gateway (AWS API Gateway is the most common example in this ecosystem) sits a layer above both ALB and NLB conceptually — it's purpose-built for fronting APIs, especially serverless/Lambda-backed ones, and bundles request/response transformation, per-client API-key authentication, request throttling, and usage-plan quotas as first-class, no-code-required features. Where an ALB in front of long-running containers is mostly "route this HTTP request to a healthy target," an API Gateway in front of Lambda is often doing real work on the request itself — validating it against a schema, transforming its shape before it ever reaches your function code, rejecting it outright if a caller has exceeded their quota — because Lambda functions are short-lived and stateless in a way that makes it natural to push more responsibility onto the layer in front of them.

**Tradeoffs:** enormous built-in convenience for exactly the serverless use case — no infrastructure to run, throttling and API-key management without writing any of that logic yourself — at the cost of vendor lock-in to that gateway's specific configuration model and, for high-volume APIs, real per-request cost that a self-managed or ALB-fronted solution doesn't carry in the same way. It's also a poor fit for AstriX's actual shape: AstriX runs long-lived containers on Fargate, not Lambda functions, and doesn't need per-client API-key throttling — an ALB in front of containers is the more natural pairing than an API Gateway would be here.

### (d) Service mesh sidecar proxies (Envoy, Istio, Linkerd)

In Kubernetes-based systems, a different load-balancing problem shows up once you have many internal services calling each other — this is **east-west traffic** (service-to-service, inside the cluster), as opposed to **north-south traffic** (external client to the system's edge, which is what an ALB or ingress controller handles). A service mesh solves east-west routing by injecting a sidecar proxy (Envoy is the most common data-plane implementation; Istio and Linkerd are control planes that configure fleets of Envoy or their own lightweight proxies) next to every service instance, so every call between internal services gets load-balanced, retried, encrypted (often via mutual TLS), and observed uniformly without any of that logic living in application code.

**Tradeoffs:** this is genuinely a different problem from the one an ALB solves — a mesh is about traffic *between* your own services, not traffic arriving from the internet — and it's out of scope for AstriX specifically because AstriX doesn't run on Kubernetes and doesn't have a large internal service-to-service mesh to manage; a single backend service talking to MongoDB and a couple of external HTTP APIs doesn't have an east-west problem worth a mesh's operational overhead. It's named here because it's a real, industry-standard answer to a load-balancing question, just not the one this file — or AstriX — is answering.

---

## 2. AstriX's Choice

AstriX uses a single, internet-facing **Application Load Balancer** terminating TLS at the edge, forwarding all traffic through one HTTP listener rule to one target group of Fargate tasks registered by IP address. No path-based routing, no host-based routing, no API Gateway, no service mesh — one ALB, one target group, one backend service. It's the L7-managed option from §1(a), chosen because AstriX's actual traffic shape (one backend API, one set of clients, no need for per-client throttling or Lambda-specific request transformation) doesn't need anything more elaborate than that.

---

## 3. AstriX Implementation

### 3.1 The ALB itself

```hcl
# infra/modules/alb/main.tf:15-39
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
```

`internal = false` and placement in `var.public_subnet_ids` are what make this ALB reachable from the internet at all — it lives in the VPC's public subnets (see file 02 for that subnet topology) with an internet-routable path, while the ECS tasks it forwards to sit in private subnets with no direct route in. `enable_cross_zone_load_balancing = true` means the ALB spreads requests evenly across targets in *every* Availability Zone it operates in, not just the AZ that happened to receive the client connection — without it, an AZ with fewer registered targets would get disproportionately more traffic per target, since cross-zone balancing defaults to off for NLBs but AWS enables it by default for ALBs (this module makes it explicit anyway, which is the more defensible way to write it — a reader shouldn't have to know AWS's per-load-balancer-type default to know AstriX's actual behavior). Access logs are conditional on `var.enable_access_logs` via a `dynamic` block — Terraform's way of saying "attach this nested config block only if a condition holds," used here because `access_logs { enabled = false }` still requires a syntactically valid `bucket` argument even when disabled, so the cleanest way to fully omit it is to omit the block itself.

### 3.2 The target group

```hcl
# infra/modules/alb/main.tf:47-83
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
```

This is the piece ECS actually plugs into — every Fargate task that comes up registers itself (via the ECS service's own `load_balancer` block, shown in §3.6) as a target inside this group, identified by its own IP address rather than an instance ID. `protocol = "HTTP"` here is the *target group's* protocol — traffic between the ALB and the tasks is plain HTTP, even though the ALB's public-facing listener speaks HTTPS; §6 covers what that implies.

### 3.3 The HTTP listener — forward or redirect, chosen at plan time

```hcl
# infra/modules/alb/main.tf:85-120
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
```

A single listener resource, but two mutually exclusive shapes for its `default_action`, chosen with a pair of `dynamic` blocks whose `for_each` conditions are exact opposites of each other (`var.redirect_http_to_https ? [] : [1]` and its inverse) — Terraform allows at most one `default_action` to actually materialize per listener, and this pattern guarantees exactly one of the two blocks emits content. When `redirect_http_to_https = false` (a domain-less ALB with no TLS cert at all — the module's own comment calls this out explicitly), plain HTTP forwards straight to the target group, because redirecting to a nonexistent HTTPS listener would just break every request. When `redirect_http_to_https = true`, the listener instead issues a 301 redirect to the same host on port 443 — HTTP never reaches the target group at all in that mode.

### 3.4 Why the HTTPS listener lives outside this module

```hcl
# infra/modules/alb/main.tf:122-126
# The HTTPS listener (port 443) is created by the caller (see
# environments/dev/main.tf: aws_lb_listener.https), not by this module,
# because the ACM certificate ARN it depends on is produced by the acm
# module, which depends on this module's alb_dns_name output - creating it
# here would be a circular dependency.
```

This is a real Terraform module-dependency constraint, not a stylistic choice. Walk the dependency chain in order: the ACM module (file 08) needs the ALB's DNS name to issue a certificate scoped to it — you can't request a certificate for a domain (or a domain-less ALB DNS name) before that name exists. So `acm` depends on `alb`. But the HTTPS listener needs the certificate's ARN as its `certificate_arn` argument — so if the HTTPS listener lived *inside* the `alb` module, `alb` would need an output from `acm`, and `acm` would need an output from `alb`. Terraform resolves dependencies as a directed acyclic graph; a cycle like that isn't just discouraged, it's a hard error the planner refuses to resolve. The fix is structural: pull the HTTPS listener resource up one layer, into the environment's own `main.tf`, where it can depend on both modules' outputs without either module depending on the other.

```hcl
# infra/environments/dev/main.tf:269-288
module "alb" {
  source = "../../modules/alb"

  project_name           = var.project_name
  environment            = var.environment
  vpc_id                 = module.networking.vpc_id
  public_subnet_ids      = module.networking.public_subnet_ids
  alb_security_group_id  = module.security.alb_security_group_id
  backend_port           = var.app_port
  health_check_path      = var.health_check_path
  enable_stickiness      = var.enable_stickiness
  certificate_arn        = null # Certificate added after ACM
  enable_access_logs     = var.enable_access_logs
  access_logs_bucket     = var.access_logs_bucket
  redirect_http_to_https = var.enable_https && var.redirect_http_to_https
  enable_alarms          = var.enable_ecs_alarms
  alarm_actions          = [aws_sns_topic.alerts.arn]

  common_tags = local.common_tags
}
```

```hcl
# infra/environments/dev/main.tf:312-331
resource "aws_lb_listener" "https" {
  count = var.enable_https ? 1 : 0

  load_balancer_arn = module.alb.alb_arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = module.acm.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = module.alb.target_group_arn
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-https-listener"
  })

  depends_on = [module.acm]
}
```

Note `redirect_http_to_https = var.enable_https && var.redirect_http_to_https` on the `module "alb"` block — the HTTP listener's redirect behavior is explicitly gated on HTTPS actually being enabled, not just on the standalone `redirect_http_to_https` flag in isolation, which is exactly the safety property the module's own comment insists on ("plaintext HTTP must never forward to the target group in parallel with HTTPS" — and the inverse is equally true: it must never redirect to an HTTPS listener that doesn't exist). The HTTPS listener resource itself is gated with `count = var.enable_https ? 1 : 0` rather than always created, and its `certificate_arn` consumes `module.acm.certificate_arn` directly — how that ACM module actually issues that certificate is file 08's subject, not this one's.

### 3.5 CloudWatch alarms — a separate signal from ECS-level health

```hcl
# infra/modules/alb/main.tf:128-180
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

Both alarms are conditional on `var.enable_alarms`, and both point their `alarm_actions`/`ok_actions` at the same SNS topic (`aws_sns_topic.alerts.arn`, passed in from the environment as `alarm_actions = [aws_sns_topic.alerts.arn]` in the `module "alb"` block above) that the ECS-level alarms (file 06) also notify — one alert topic, fed by two independent layers of alarms watching for different failure modes.

### 3.6 How ECS actually plugs into this target group

```hcl
# infra/modules/ecs/main.tf:241-245
load_balancer {
  target_group_arn = var.target_group_arn
  container_name   = "backend"
  container_port   = var.container_port
}
```

This is the other half of the wiring — inside the ECS service resource (file 06 covers the rest of that resource), this block is what tells ECS "when a task starts, register its ENI IP with this target group on this container port, and when it stops, deregister it." `var.target_group_arn` here is `module.alb.target_group_arn` from the `aws_lb_target_group.backend` resource above, passed down from the environment's `main.tf` the same way the security group IDs are.

---

## 4. Request/Data Flow

**A normal HTTPS request:**

1. A browser resolves the ALB's DNS name (`module.alb.alb_dns_name`, an AWS-generated `*.elb.amazonaws.com` hostname, or whatever CNAME/alias record points at it) to one of the ALB's node IPs.
2. The browser opens a TCP connection to that IP on port 443.
3. The ALB terminates TLS right there, using the certificate attached to `aws_lb_listener.https` — the cert whose ARN comes from `module.acm.certificate_arn`. From this point on, the ALB is holding a decrypted HTTP request in memory.
4. The listener's single `default_action` (a `forward`, per §3.4) sends that request to `aws_lb_target_group.backend`.
5. The target group picks one of its currently-healthy registered targets — a Fargate task's ENI IP — using its internal load-balancing algorithm (round robin by default for an ALB target group).
6. The ALB opens a new, separate HTTP connection to that task's IP on `var.backend_port`, and forwards the request over that plaintext connection.
7. The container's app process (listening on that port) handles the request and returns a response.
8. The response travels back through the ALB, which re-encrypts nothing — it simply relays the response bytes back over the original TLS connection to the browser.

**The HTTP→HTTPS redirect path** (a client that connects on port 80 instead of 443, as most browsers still try first for a bare URL with no scheme): the connection hits `aws_lb_listener.http`, whose `default_action` — because `redirect_http_to_https` is true in the deployed dev configuration — is the `redirect` block, not `forward`. The ALB immediately returns an HTTP 301 with a `Location` header pointing at the same host on port 443, without the request ever reaching the target group or a container at all. The browser then opens a *second* TCP connection, this time on 443, and repeats steps 2–8 above. That's one extra full round trip (open a TCP connection, send the request, receive a 301, close it, open a new TLS connection) before any real content loads — the cost of the safety property described in §6.

**A target failing its health check:** the target group polls `var.health_check_path` (defaulting to `/health`) on every registered target every 30 seconds. Per the `health_check` block in §3.2, one failed check doesn't do anything by itself — the target group needs `unhealthy_threshold = 3` *consecutive* failures before it marks a target unhealthy and pulls it out of rotation; it needs `healthy_threshold = 2` consecutive successes to bring a target back in. Once a target is marked unhealthy, the ALB simply stops sending it new requests — existing in-flight requests to it aren't forcibly killed, but nothing new is routed there until it starts passing checks again. If enough targets go unhealthy, `aws_cloudwatch_metric_alarm.unhealthy_hosts` — configured with `threshold = 0`, meaning it fires the moment even one target is registered-but-unhealthy for two consecutive 60-second periods — sends a notification through the shared SNS topic.

---

## 5. Design Decisions & Tradeoffs

**Why `target_type = "ip"` instead of `"instance"`.** A target group with `target_type = "instance"` registers targets by *EC2 instance ID* — it assumes there's an actual EC2 instance backing every target, and it routes to that instance's primary network interface. Fargate tasks have no such instance to point to; each task gets its own elastic network interface (ENI) with its own private IP, directly in a VPC subnet, entirely independent of any EC2 host (file 06 covers this in more depth as part of Fargate's architecture generally). `target_type = "ip"` is the only mode that can register a target by raw IP address rather than by instance identity, which is exactly what a Fargate task's ENI needs — this isn't really a "design decision AstriX made" so much as a hard requirement that falls out of choosing Fargate as the compute model in the first place; the target group's shape is downstream of that choice.

**Why `deregistration_delay = 30`.** When a target is being removed from a target group — because a deployment is rolling a new task definition in and draining the old one, or because a task is being scaled down — the ALB doesn't yank it out of rotation instantly. It stops sending *new* requests to that target immediately, but keeps the target in a "draining" state for `deregistration_delay` seconds, during which any requests already in flight to it are allowed to finish. Thirty seconds is a deliberate middle ground: long enough that a typical request (even a moderately slow database query or external API call) has time to complete rather than getting cut off mid-response, but short enough that deploys don't drag on — with dozens of tasks cycling through deploys, a much longer drain window would make rolling deployments visibly slower without a correspondingly large safety benefit for a backend whose requests are mostly short-lived HTTP calls. The tradeoff is explicit and tunable: a service with occasional long-running requests (large file uploads, long-polling, slow report generation) would want a longer delay to avoid truncating those in-flight calls during a deploy; a service confident every request finishes in well under a second could shorten it to speed up deploys further.

**Why `stickiness` exists in the config but defaults to disabled.** The `stickiness` block is present unconditionally in the Terraform, but its `enabled` field is wired to `var.enable_stickiness`, whose default is `false` in both `infra/modules/alb/variables.tf:47-51` and the environment's own `infra/environments/dev/variables.tf` (`enable_stickiness` variable, same default). Session stickiness (`type = "lb_cookie"`) works by having the ALB set a cookie on the first response and using it to route every subsequent request from that browser back to the *same* target for the cookie's duration — useful specifically when a backend keeps per-connection state in the process memory of whichever instance first handled a client (in-memory session data, a WebSocket-adjacent long-lived connection, server-side caching keyed to one instance). Leaving it off by default is the correct call for a backend that's actually stateless at the infra level: if session/auth state lives in a JWT the client presents on every request, or in a shared datastore (a database, a shared cache) that every task can read identically, then it genuinely doesn't matter which task answers which request — any healthy task is equally capable of handling it. This file won't re-litigate how AstriX's auth tokens are actually structured (that's a backend-module topic), but the infra-level implication is worth stating plainly: an ALB configured this way is a bet that the backend doesn't need instance affinity, and if that bet is wrong — if some future feature quietly starts keeping meaningful state in a single task's memory — requests would get load-balanced across tasks that don't actually share that state, and the failure would show up as confusing, request-dependent bugs rather than an obvious error.

**Why ALB-level alarms exist as a signal separate from ECS-level alarms.** File 06 covers ECS's own CPU/memory/task-count alarms, which watch the *cluster's* resource consumption and task-scheduling health. Those alarms have a blind spot the module's own comment states directly: "a target can look perfectly healthy to ECS while still returning 5xx to real clients, which the ECS-level CPU/memory/task-count alarms can't see." A task can be running, passing its ECS-level checks, consuming entirely normal CPU and memory, and still be returning HTTP 500s to every request — because of a downstream dependency failure (the database is unreachable), a bug triggered by a specific request shape, or an application-level exception the process itself doesn't crash from. ECS only knows "is the process alive and within its resource limits"; only something watching actual HTTP response codes — which is exactly what the ALB, sitting in the request path, is positioned to do — can see that gap. `target_5xx` watches for a rate of 5xx responses across the fleet; `unhealthy_hosts` watches for targets the *target group itself* has stopped trusting via its own health checks. Together they're the layer that answers "is the app actually serving traffic correctly right now," which is a materially different question from "is the container process technically alive."

---

## 6. Security Considerations

**TLS termination at the edge, plaintext inside the VPC.** The ALB decrypts every request the instant it arrives and forwards it to the target group over plain HTTP (`protocol = "HTTP"` on `aws_lb_target_group.backend`, confirmed in §3.2) — meaning traffic between the ALB and an ECS task travels unencrypted for that one hop. Is this a real gap or an accepted tradeoff? Read plainly: that hop never leaves AWS's own private network — it's ALB-to-ENI traffic inside a VPC's private subnets, never touching a shared or public link, and AWS's own network fabric provides isolation between tenants at a level most threat models for a project like this don't need to second-guess. For traffic that never crosses a trust boundary a reasonable person would consider "outside AWS," plaintext-inside-the-VPC is the standard, accepted shape of this architecture across the industry, not a shortcut specific to AstriX. It stops being a non-issue the moment a compliance regime (PCI-DSS handling cardholder data, HIPAA with certain interpretations, FedRAMP) requires demonstrable encryption-in-transit for *all* hops regardless of network boundary — at that point the answer is mutual TLS (mTLS) between the ALB and the targets, which is a real, available AWS feature but a meaningfully larger operational lift (certificate distribution and rotation to every task, not just the one ALB-facing cert) that AstriX doesn't currently need and doesn't implement.

**The HTTP→HTTPS redirect as a plaintext-credential guard.** The `redirect_http_to_https` behavior in §3.3/§3.4 isn't just a convenience — it's the mechanism that prevents a client from ever completing a plaintext HTTP exchange with the backend at all. Without it, a client that happens to type `http://` instead of `https://`, or follows an old plain-HTTP link, would send its request — and any cookies, auth headers, or credentials attached to it — over an unencrypted connection before anything redirects it. With the redirect active (as it is in the deployed dev configuration, `redirect_http_to_https = true`), that same request never reaches the application layer over plaintext at all; it gets bounced to HTTPS before any sensitive data leaves the connection unencrypted, at the one-round-trip cost described in §4.

**`enable_deletion_protection` is real, and effectively inert right now.** The line is exactly `enable_deletion_protection = var.environment == "prod" ? true : false` (`infra/modules/alb/main.tf:22`) — a genuine conditional, not a placeholder. But AstriX currently has exactly one deployed environment, `"dev"` (confirmed by `environment = "dev"` in `infra/environments/dev/terraform.tfvars:13`), and there is no `prod` environment directory or deployment yet. That means this conditional, as written, always evaluates to `false` in every environment that actually exists today — the protection logic is correctly written for a future where a `prod` environment exists, but it is not currently protecting anything, because nothing currently deployed satisfies its condition. That's worth naming as an honest observation about where the project is in its lifecycle, not a flaw in the code itself — the conditional is exactly what you'd want once a real prod environment exists; it just hasn't had the chance to matter yet.

**The ALB security group's `0.0.0.0/0` ingress.** `aws_security_group.alb` in `infra/modules/security/main.tf` allows inbound 80 and 443 from anywhere on the internet — file 03 covers the full security-group chain and why that's the intended shape for the one resource in the whole system that's supposed to be reachable from the public internet at all; it isn't re-litigated here beyond noting that this ALB is exactly the resource that security-group design assumes will carry that exposure, with every downstream resource (the ECS security group) scoped to accept traffic only from this ALB's security group, not from the internet directly.

---

## 7. Best Practice Check

**Is TLS-termination-at-the-edge-with-plaintext-inside-the-VPC still accepted practice in 2026?** Yes, plainly, for the large majority of workloads that aren't under a specific regulatory mandate requiring encryption on every hop regardless of network boundary. This is still the default architecture AWS's own reference material recommends for ALB-fronted container workloads, and it's what the overwhelming majority of production systems at this scale actually run. The stricter alternative — mTLS or otherwise fully end-to-end encrypted traffic all the way to the container — is a real, available pattern, and some compliance regimes require it outright, but it isn't the 2026 industry default for a general-purpose backend API; it's the exception adopted specifically where regulation or an unusually conservative threat model demands it.

**Is a single ALB with no WAF attached worth flagging again here, specifically in the load-balancing context?** Briefly, yes — file 03 already covers the WAF gap in depth as a network-security-layer observation (the `cloudfront_web_acl_id` variable exists and is explicitly set to `null`), and it's worth restating narrowly in this file's own terms: the ALB is the single ingress point for every request this system serves, and it currently does zero content-level inspection of any of them — no SQL-injection pattern matching, no rate-based blocking of a credential-stuffing burst, nothing beyond the network-layer security-group filtering covered in file 03. That's a defensible tradeoff for a project at this stage (a WAF is recurring cost and another moving part to tune correctly), but it means every request that passes the security group's port check reaches the application layer with no inspection in between — worth having in mind specifically because this is the file about how traffic actually gets routed, and "how it gets inspected on the way" is the missing half of that same story.

**Is access logging enabled by default, and is that reasonable for dev?** No — `enable_access_logs` defaults to `false` in `infra/modules/alb/variables.tf:65-69`, and the dev environment's `terraform.tfvars` doesn't override it, so access logging is genuinely off in the deployed dev environment. For a dev environment specifically, that's a reasonable, common choice: access logs cost extra (S3 storage, plus the operational overhead of actually looking at them), and a lower-traffic dev environment usually has other ways to debug a specific request (application logs, CloudWatch metrics, reproducing the request directly) that don't require durable per-request ALB logs. It would be a different, weaker call in a production environment serving real user traffic, where per-request access logs are often the only artifact that lets you reconstruct exactly what a specific client sent after the fact — but for the environment that actually exists today, off-by-default is a sound tradeoff, not an oversight.

---

## 8. Debug Drill

**Scenario:** Users intermittently get 502 or 504 errors from the ALB, even though the ECS console shows every task in the service as `RUNNING` and the target group shows targets as `healthy`. Where do you look first, and in what order?

1. **Distinguish 502 from 504 immediately — they point in different directions.** A 502 (Bad Gateway) from an ALB usually means a target *did* respond, but with something the ALB couldn't parse as a valid HTTP response — a connection reset mid-response, a malformed response, or the target closing the connection unexpectedly. A 504 (Gateway Timeout) means the ALB never got a response in time at all — the target either never responded or the ALB's own idle-timeout expired first. Conflating the two wastes time investigating the wrong layer; check the actual status codes being returned (from a browser dev tools network tab, or, if it were enabled, from access logs) before doing anything else.

2. **Check the health-check settings against the container's real startup and response behavior.** The target group's `health_check` block in §3.2 uses `healthy_threshold = 2`, `unhealthy_threshold = 3`, `interval = 30`, and `timeout = 5`. If the application occasionally takes longer than 5 seconds to answer `/health` under load — a cold cache, a slow downstream dependency, a garbage-collection pause — the health check itself can flap a target between healthy and unhealthy even though the app is fundamentally fine, and a request that lands on a target mid-flap can see a 502/504 in the narrow window before the target is pulled from rotation. This is the first thing worth ruling out precisely because "targets show healthy" only reflects the *most recent* check outcome, not the target's behavior in the seconds between checks.

3. **Check deployment timing against `deregistration_delay`.** If the 502/504 errors cluster specifically around deploy times, the 30-second drain window from §5 is a strong suspect: a target that's mid-drain is no longer receiving *new* requests, but if a request was already routed to it right before it started draining, and that in-flight request takes longer than expected to finish (or the container is terminated forcibly before the drain window elapses because of a task-definition or platform-level timeout mismatch), the client sees a failed or truncated response. Correlating error timestamps against ECS deployment events is usually the fastest way to confirm or rule this out.

4. **Check whether the container's actual listening port and application-level timeout match what the target group and ALB expect.** A backend that occasionally holds a connection open longer than the ALB's own idle timeout (60 seconds by default for an ALB, configurable but easy to overlook) will see the ALB close the connection out from under it, which surfaces to the client as a 504. If a specific slow endpoint is disproportionately represented in the errors, this — rather than anything about target health — is the more likely explanation, and the fix is either speeding up that endpoint or explicitly raising the ALB's idle timeout to accommodate it.

The pattern across all four steps: "the target group says healthy" and "ECS says running" are both point-in-time, control-plane facts — they say a target passed its most recent check and its process is alive, not that every request reaching it in between checks gets a clean, timely response. Intermittent 502/504s with an otherwise-healthy-looking fleet almost always live in that gap between what the control plane samples periodically and what real traffic experiences continuously, which is exactly why timing (health-check interval and timeout, deploy windows and drain delay, per-request latency) is the axis worth investigating before assuming anything about the target group's configuration is outright wrong.
