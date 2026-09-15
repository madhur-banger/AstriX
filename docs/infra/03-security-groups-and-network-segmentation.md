# Security Groups & Network Segmentation

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md). Builds on [`02-networking-and-vpc-design.md`](./02-networking-and-vpc-design.md), which covers the VPC/subnet/NAT topology this file assumes as given — this file is specifically about *what is allowed to talk to what* inside and around that topology, not how the topology itself is laid out.

A VPC with public and private subnets tells you *where* things live. It says nothing about *who can reach whom*. Two EC2 instances in the same private subnet can, by default subnet routing alone, send each other packets freely — subnetting is an addressing and routing concept, not an access-control one. The access-control question — "can this ALB actually accept a connection on port 443 from a stranger on the internet," "can this ECS task accept a connection from anything other than the load balancer sitting in front of it" — is answered by a completely different mechanism: traffic filtering at the network layer. This file is about that mechanism: the different ways clouds and operating systems implement it, and the specific chain AstriX built with it.

It's worth taking this topic seriously on its own terms rather than treating it as boilerplate to click through in the AWS console. A security group misconfiguration is one of the most common root causes of real-world cloud breaches — not because the mechanism is exotic, but because it's easy to reach for the wrong primitive (a CIDR block instead of a group reference, a wide-open range "just to get it working," an `0.0.0.0/0` egress rule copy-pasted without thinking about what it actually permits) and have it work in testing while quietly leaving a door open in production.

---

## 1. The Landscape

There isn't one way to filter network traffic in a cloud environment — there are at least four distinct mechanisms, operating at different layers and with genuinely different semantics, and production systems often layer more than one of them.

### (a) Stateful, instance-attached security groups (AWS Security Groups, Azure NSGs, GCP firewall rules)

This is the model AWS Security Groups implement, and the model AstriX uses throughout. A security group is a virtual firewall attached to an elastic network interface (ENI) — in practice, to an EC2 instance, an ALB, an RDS instance, or an ECS Fargate task's network interface. It is **allow-only**: every rule you write is a permit; there is no way to write a "deny" rule inside a security group. Anything not explicitly permitted is implicitly denied. And it is **stateful**: if you allow an inbound connection on port 443, the corresponding return traffic (the response) is automatically allowed back out, without needing a matching egress rule. You only reason about one direction of a conversation, not both, and you never have to remember to open "the reply."

The single most powerful feature of this model, and one that not everyone reaches for even when it's available, is that a rule's source or destination can be **another security group**, not just an IP range:

```
ingress {
  from_port       = 3000
  to_port         = 3000
  security_groups = [aws_security_group.alb.id]   # a group, not a CIDR
}
```

This means the rule survives infrastructure churn automatically — if the ALB is destroyed and recreated (a new ENI, a new IP), or if you scale from one ALB to a fleet behind a Global Accelerator, this rule requires zero edits, because it never referenced an IP address in the first place. Azure's Network Security Groups and GCP's VPC firewall rules both support the equivalent construct (tags/service-accounts as the reference object instead of raw CIDRs), so this isn't an AWS-only idea — it is the general cloud-native pattern for expressing "traffic from that specific logical thing," and it is what AstriX uses for its entire internal traffic chain.

**Tradeoffs:** simplicity is the main win — you reason about one direction, rules are additive and easy to audit resource-by-resource, and SG-reference rules track infrastructure changes automatically. The real limitation is that you cannot express an explicit deny with a security group. If you need "allow this whole subnet except that one bad actor," a security group alone cannot say that — you'd need the next mechanism.

### (b) Stateless, subnet-level Network ACLs

A Network ACL (NACL) operates one layer up in scope: it's attached to an entire *subnet*, not an individual instance, and every packet crossing that subnet boundary is evaluated against it. Two things make NACLs structurally different from security groups. First, they're **stateless** — an inbound allow rule does not automatically permit the matching outbound response; you must write both directions yourself, or return traffic gets silently dropped. Second, NACLs support **explicit deny rules**, evaluated in **numbered order**, lowest number first, first match wins:

```
# illustrative NACL rule table — not AstriX config
Rule #   Type    Protocol   Port    Source          Action
100      Inbound TCP        443     0.0.0.0/0       ALLOW
200      Inbound TCP        22      203.0.113.0/24  ALLOW
300      Inbound ALL        ALL     198.51.100.4/32 DENY   <- explicit deny
*        Inbound ALL        ALL     0.0.0.0/0       DENY   (implicit default)
```

That numbered evaluation is the entire point: you can carve out a specific block for one bad IP (rule 300) ahead of a broader allow rule further down the list, something a security group's allow-only model structurally cannot do. AWS's default NACL that ships with every VPC allows all inbound and outbound traffic — it's a permissive placeholder, not a filter, until someone deliberately tightens it.

**Tradeoffs:** the explicit-deny-with-priority-order feature is genuinely more expressive than anything a security group offers, and it operates as defense-in-depth at the subnet boundary regardless of what any individual instance's security group says. The cost is real operational overhead: you must remember both directions for every rule (stateless), rule numbering has to be planned with gaps for future insertions, and a subnet-wide NACL is a blunt instrument compared to a per-resource security group — it can't distinguish "the ALB in this subnet" from "the ECS task in this same subnet," because it doesn't know about individual ENIs, only the subnet they sit in.

### (c) Host-based firewalls (iptables/nftables, Windows Firewall)

Both of the above are cloud-provider-managed, sitting outside the instance entirely. A host-based firewall runs *inside* the instance or container's own kernel — `iptables`/`nftables` on Linux, Windows Firewall on Windows — filtering packets after they've already been allowed in by the security group and NACL layers above. Many hardened production systems run one anyway, as a second layer:

```bash
# illustrative nftables rule — not AstriX config
nft add rule inet filter input tcp dport 3000 ip saddr 10.0.1.0/24 accept
nft add rule inet filter input drop
```

**Tradeoffs:** a host-based firewall is the last line of defense if the security group is ever misconfigured or bypassed (e.g., traffic from another workload that legitimately shares the same security group but shouldn't reach this particular service), and it's controllable from inside the OS image itself, useful for portability across clouds that don't share a security-group API. The cost is that it's one more thing to configure, keep in sync with the cloud-level rules, and potentially misconfigure into a self-inflicted outage — locking yourself out of an instance with a bad `iptables` rule is a classic, painful mistake. It also duplicates effort: if the security group already scopes traffic tightly and correctly, the host firewall is redundant defense-in-depth rather than a functional gap-filler.

### (d) Layer-7, HTTP-aware perimeter services (AWS WAF, Cloudflare, other CDN/WAF products)

All three mechanisms above operate at the network layer (L3/L4) — they reason about IP addresses, ports, and protocols, and they have no idea what's inside a TCP payload. A Web Application Firewall operates at L7: it terminates and inspects the actual HTTP request — method, headers, path, body — and can filter or rate-limit based on that content. AWS WAF (attachable to an ALB or CloudFront distribution) and Cloudflare are the two most common examples. A WAF is what stops a SQL-injection payload embedded in a query string, or a credential-stuffing burst of login attempts from a single client, or a known-bad user agent — none of which a security group or NACL can see, because to them a malicious HTTP POST and a legitimate one look identical: both are just a TCP packet to port 443.

**Tradeoffs:** a WAF catches an entire class of attack (application-layer, content-aware) that network-layer filtering is structurally blind to, and modern managed rule sets (AWS Managed Rules, Cloudflare's OWASP ruleset) get you broad coverage without hand-writing rules. The cost is added latency (another hop doing L7 inspection), added expense, and false-positive risk — an overly aggressive WAF rule can block legitimate traffic that merely resembles an attack pattern.

These four mechanisms are not mutually exclusive alternatives to pick one from — they're complementary layers that operate at different altitudes (L7 perimeter → subnet-wide L3/L4 → instance-level L3/L4 → in-kernel L3/L4), and a maximally defended system runs more than one simultaneously. What differs between projects is how many of these layers are actually turned on.

---

## 2. AstriX's Choice

AstriX relies on exactly one of these four mechanisms, used well: a chain of **stateful, security-group-reference-based rules** — internet → ALB security group → ECS security group, where the ECS group's ingress rule names the ALB's security group ID directly rather than any IP range. There is no NACL customization beyond the AWS-provided default (permissive, unmodified), no host-based firewall running inside the ECS containers, and — as verified below — no WAF currently attached to the public-facing distribution. This is a single-layer network-filtering design, but the one layer it does use is built with the strongest available primitive within that layer (group references, not CIDRs), rather than a wide, sloppy version of the same mechanism.

---

## 3. AstriX Implementation

The entire security posture for network traffic lives in one Terraform module, `infra/modules/security/`. Its own header comment states the intended shape before a single resource is declared:

```hcl
# infra/modules/security/main.tf:1-31
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
```

Worth checking this diagram against the actual resources rather than taking a comment on faith — a header comment is documentation, and documentation drifts. It holds up: the ALB security group really does allow 80/443 from anywhere and egress everything, and the ECS security group really does gate its inbound rule on the ALB's security group ID, not a CIDR (both confirmed below). One label is slightly imprecise: the diagram says the ALB's "outbound" goes "to ECS SG," but the actual egress rule (below) is an unscoped `0.0.0.0/0` allow-all — the ALB's outbound isn't restricted to the ECS SG at the Terraform level; it's the ECS SG's own *inbound* rule that does the real restricting, by only accepting traffic that already carries the ALB's group membership. The practical effect the diagram describes (ALB traffic reaches ECS, nothing else does) is correct even though the mechanism enforcing it sits on the receiving side, not the sending side.

### 3.1 The ALB security group — the internet-facing edge

```hcl
# infra/modules/security/main.tf:40-82
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
```

This is the only security group in the entire module with a `0.0.0.0/0` ingress rule, and it's attached directly to the ALB by the ALB module itself:

```hcl
# infra/modules/alb/main.tf:15-20
resource "aws_lb" "main" {
  name               = "${var.project_name}-${var.environment}-alb"
  internal           = false # Internet-facing
  load_balancer_type = "application"
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids
```

and wired up in the environment root:

```hcl
# infra/environments/dev/main.tf:276
  alb_security_group_id  = module.security.alb_security_group_id
```

### 3.2 The ECS tasks security group — the key security boundary

```hcl
# infra/modules/security/main.tf:91-127
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
```

Note the `ingress.security_groups = [aws_security_group.alb.id]` line — this is the single most important line in the whole module, and this file's central teaching point. It is not `cidr_blocks = ["10.0.1.0/24"]` (the private subnet range) or any other IP-based expression. It's a direct reference to the ALB security group's own resource ID. In AWS's implementation, this means: "permit inbound traffic on `var.app_port` from any ENI that is currently a member of the ALB security group" — regardless of what subnet that ENI lives in, what its private IP happens to be, or how many ALB nodes AWS is running behind the scenes for this one logical load balancer. `var.app_port` resolves to `3000` in the dev environment (`infra/environments/dev/terraform.tfvars:58`), overriding the module's own documented default of `8080` (`infra/modules/security/variables.tf:43-55`) — the app port is environment-configurable, not hardcoded into the security module itself.

This SG is what's actually attached to the running Fargate tasks, via the ECS module's network configuration:

```hcl
# infra/modules/ecs/main.tf:233-238
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_security_group_id]
    assign_public_ip = false # Tasks in private subnet, no public IP needed
  }
```

and `ecs_security_group_id` is populated from this exact module's output:

```hcl
# infra/environments/dev/main.tf:383
  ecs_security_group_id              = module.security.ecs_tasks_security_group_id
```

### 3.3 The database security group — deliberately no egress

This group is optional and, per its own `count`, not currently created in the dev environment (more on that in §5) — but it's worth reading in full because its design is the sharpest illustration in the whole module of *deny by omission*:

```hcl
# infra/modules/security/main.tf:175-216
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

  # No egress block: a database SG only accepts inbound connections, it
  # never initiates outbound ones - omitting egress rules here (rather than
  # declaring a 0.0.0.0/0 "allow all" rule that contradicted this SG's own
  # "no outbound needed" comment) means Terraform provisions zero egress
  # rules, which AWS treats as deny-all for this security group.

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-database-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}
```

Every other security group in this module has an explicit `egress { cidr_blocks = ["0.0.0.0/0"] }` block. This one deliberately doesn't. That's not an oversight caught later — the inline comment documents exactly why the block is absent rather than merely permissive, and it's worth internalizing the AWS mechanic behind it: a security group with **zero** egress rules at all denies **all** outbound traffic from anything attached to it. There is no separate "default egress" fallback to worry about here; the absence of the block *is* the policy.

### 3.4 The optional Lambda and VPC-endpoints groups

Two more groups round out the module, both gated behind boolean flags:

```hcl
# infra/modules/security/main.tf:136-167
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
```

```hcl
# infra/modules/security/main.tf:224-257
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
```

The VPC-endpoints group is the one place in the whole module where a CIDR (`var.vpc_cidr`, not `0.0.0.0/0`) is the right primitive rather than a compromise: a VPC endpoint's interface can legitimately be reached by anything inside the VPC, and there's no single upstream security group to reference — "anything in this VPC" is precisely a CIDR-shaped concept, not a group-membership one.

### 3.5 The conditional flags and how the dev environment wires them

```hcl
# infra/modules/security/variables.tf:76-117
variable "create_lambda_sg" {
  description = <<-EOT
    Whether to create a security group for VPC-attached Lambda functions.
    
    Set to true if your Lambda functions need:
    - Access to VPC resources (RDS, ElastiCache)
    - Fixed IP addresses (via NAT Gateway)
    
    Note: VPC-attached Lambdas have cold start penalty
  EOT
  type        = bool
  default     = true
}

variable "create_database_sg" {
  description = <<-EOT
    Whether to create a security group for database instances.
    
    Set to true if you plan to:
    - Use RDS instead of MongoDB Atlas
    - Use DocumentDB
    - Use ElastiCache
    
    Since you're using MongoDB Atlas, you might not need this.
  EOT
  type        = bool
  default     = false
}

variable "create_vpc_endpoints_sg" {
  description = <<-EOT
    Whether to create a security group for VPC Endpoints.
    
    VPC Endpoints allow private access to AWS services:
    - Avoid NAT Gateway data charges
    - Improve security (traffic stays in AWS)
    
    Useful for: ECR, S3, DynamoDB, SQS, SNS
  EOT
  type        = bool
  default     = false
}
```

And the module invocation in the dev environment, which passes these flags straight through from environment-level variables:

```hcl
# infra/environments/dev/main.tf:187-207
module "security" {
  source = "../../modules/security"

  project_name = var.project_name
  environment  = var.environment

  # VPC Configuration (from networking module)
  vpc_id   = module.networking.vpc_id
  vpc_cidr = module.networking.vpc_cidr

  # Application Configuration
  app_port      = var.app_port
  database_port = var.database_port

  # Optional Security Groups
  create_lambda_sg        = var.create_lambda_sg
  create_database_sg      = var.create_database_sg
  create_vpc_endpoints_sg = var.create_vpc_endpoints_sg

  common_tags = local.common_tags
}
```

Only the ALB and ECS tasks groups are created unconditionally — everything else in this module exists in the Terraform state only if the corresponding flag is set `true` for that environment.

---

## 4. Request/Data Flow

Trace one real HTTPS request from a browser to a running backend container, using only the security-group chain above — no application logic, just what's allowed to reach what:

1. **Browser → internet → ALB.** A browser opens a TCP connection to the ALB's public DNS name on port 443. The packet arrives at the ALB's ENI. The ALB security group's ingress rule for port 443 (`cidr_blocks = ["0.0.0.0/0"]`, `infra/modules/security/main.tf:57-63`) evaluates this connection: source is "anywhere," which matches. The connection is accepted at the network layer, and the ALB's TLS listener takes over from there (handled at the load-balancing layer, not this module — see file 07 for the listener/target-group mechanics).

2. **ALB → ECS task.** Having terminated TLS and picked a healthy target, the ALB opens a new, separate connection to that target — one of the running ECS tasks, on the app port (3000 in dev). This connection originates from an ENI that is a member of the ALB security group. It arrives at the ECS task's ENI, which is governed by the ECS tasks security group. That group's only ingress rule checks: does the source ENI belong to `aws_security_group.alb.id`? It does — this connection genuinely originated from the ALB — so it's accepted (`infra/modules/security/main.tf:98-104`).

3. **Now consider a hypothetical attacker trying to skip step 1 and reach the ECS task directly.** Say they've somehow learned or guessed the private IP of a running task (private IPs in AWS are not secret, just not publicly routable without a NAT/IGW path — a curious or malicious actor with access to the VPC, or to a compromised resource inside it, could enumerate them). They attempt a direct TCP connection to that IP on port 3000. This connection's source ENI is whatever launched the attempt — not a member of the ALB security group. The ECS security group's ingress evaluation fails: no rule matches. The connection is dropped before it ever reaches the container's listening socket. **This is true regardless of whether the ECS task has a public IP at all** — and in fact it doesn't: `assign_public_ip = false` (`infra/modules/ecs/main.tf:237`) means the task has no publicly routable address to attempt a connection to in the first place, since it lives in a private subnet (see file 02 for the subnet topology). But even setting that aside, the security group is what does the actual blocking here, not the absence of a public IP — a task's private IP is reachable by anything else inside the VPC's routing domain (another EC2 instance, another ECS task, a compromised Lambda), and it's the SG's reference-based ingress rule, not subnet placement, that decides whether that reachability turns into an accepted connection. Public-IP-lessness and subnet privacy raise the bar for an external attacker; the security group is what actually enforces the rule for anyone already inside the network boundary.

4. **Return traffic.** Because both security groups are stateful, the response — from ECS task back through the ALB back to the browser — needs no separate rule. The state table on each ENI remembers the inbound connection it just accepted and automatically permits the matching reply.

Every step above is enforced purely by which security group is attached to which ENI and what that group's ingress rules say — there is no NACL customization contributing anything beyond AWS's permissive default, and no host firewall inside the container filtering anything further at this stage of the trace.

---

## 5. Design Decisions & Tradeoffs

**Security-group references over CIDR blocks.** This is the decision worth internalizing above all others in this file. A CIDR-based rule (`cidr_blocks = ["10.0.1.0/24"]`) encodes an assumption about *where* traffic will come from — a specific subnet, a specific IP range — that has to be manually kept correct as infrastructure changes. If the ALB's subnet ever changes, if AWS reassigns the underlying ENIs during a scaling event, if a second ALB is added behind a global load balancer, a CIDR-based rule silently goes stale: either it stops matching (an outage) or, worse, it keeps matching a range that now includes something it was never meant to permit (a security hole). A security-group-reference rule (`security_groups = [aws_security_group.alb.id]`) encodes an assumption about *what* traffic will come from — "the ALB," as a logical identity — and that identity is stable across exactly the kind of infrastructure churn that breaks CIDR rules. It also reads as intent directly in the code: `security_groups = [aws_security_group.alb.id]` says "traffic from the ALB" in a way a subnet range never can — a future engineer reading this rule doesn't have to go look up what currently lives in `10.0.1.0/24`; the rule names the thing it means.

**No egress on the database security group.** The comment in `infra/modules/security/main.tf:203-207` makes an explicit design choice legible: rather than writing a `0.0.0.0/0` egress "allow all" rule (which every other group in this file has, and which would have been the path of least resistance to copy-paste), the author left the egress block out entirely. A database's role in this architecture is purely passive — it accepts connections and returns query results; it never needs to reach out and connect to anything else on its own initiative. Declaring zero egress rules means AWS enforces deny-all outbound for that group, which is a stronger and more honest expression of "this resource should never initiate an outbound connection" than an allow-all rule sitting next to a comment claiming the opposite. If this security group's attached resource were ever compromised — a database process exploited to run arbitrary code — this rule would prevent it from exfiltrating data outward or calling home to an attacker-controlled endpoint, which is exactly the scenario a database's threat model should account for.

**The conditional/optional security groups as a cost-and-complexity-avoidance pattern.** The Lambda, database, and VPC-endpoints groups are all gated behind a `count = var.create_x_sg ? 1 : 0` pattern rather than existing unconditionally. This matters because AstriX, as currently deployed, doesn't use a VPC-attached Lambda, doesn't run a database inside the VPC (MongoDB Atlas is external, reached over the internet from the ECS tasks' unrestricted egress rule), and doesn't currently front AWS-service traffic through VPC endpoints. Provisioning security groups for resources that don't exist yet would be pure noise in the Terraform state and the AWS console — extra objects to audit, extra surface area to reason about, for zero present-day benefit. The conditional pattern keeps the module ready to support these resources the moment they're actually needed (flip one boolean) without cluttering the deployed environment with unused scaffolding today. It's a reasonable, common pattern in mature Terraform modules — build the capability, but don't pay its cost until it's switched on.

---

## 6. Security Considerations

This entire file is, in a real sense, a security file — but a few points deserve calling out explicitly rather than leaving implicit.

**The ALB's `0.0.0.0/0` ingress is not a vulnerability by itself.** A public-facing web service, by definition, must accept connections from arbitrary, unauthenticated clients on the internet — that's what "public-facing" means. An `0.0.0.0/0` rule on ports 80/443, scoped to a load balancer whose entire job is to accept exactly that kind of traffic, is the correct and necessary configuration, not a misconfiguration. The question that actually matters for security is not "does anything accept traffic from the whole internet" (something has to) but "what happens to that traffic once it's accepted, and how far can it travel from there." That's precisely what the ECS security group's tight, reference-based scoping answers: even in the worst case where the ALB itself were fully compromised — its own OS-level controls bypassed, an attacker with full control of traffic flowing through it — the attacker still can't pivot to *other* resources in the VPC, because the ECS security group only accepts app-port traffic that carries ALB group membership, and nothing else the attacker might reach from that foothold shares that membership. This is the real value of the design: the internet-facing edge is intentionally wide, and everything behind it is intentionally narrow, chained one hop at a time.

**The security-group chain as defense-in-depth.** "Defense-in-depth" is often described in terms of stacking different *kinds* of controls (network + host + application), but it also applies within a single kind of control when it's built as a chain rather than a single flat rule. Here, reaching the backend requires satisfying two independent security-group checks in sequence — the internet has to pass the ALB's public 443 rule, and then whatever the ALB forwards has to independently satisfy the ECS group's ALB-reference rule. An attacker who somehow bypasses or spoofs their way past one of those checks still has to clear the other. Collapsing this into a single security group with a `0.0.0.0/0` rule directly on the ECS tasks — skipping the ALB "hop" for filtering purposes — would flatten this into one check instead of two, and remove the property that made the design meaningfully layered in the first place.

**The concrete failure mode of a CIDR mistake on the ECS security group.** It's worth spelling out exactly what would go wrong if someone "simplified" the ECS ingress rule from a security-group reference to a CIDR block — say, out of frustration debugging a connectivity issue, changing `security_groups = [aws_security_group.alb.id]` to `cidr_blocks = ["10.0.0.0/16"]` (the whole VPC range) "just to get it working," intending to tighten it later. The moment that change applies, *anything* with a network interface anywhere in that VPC — another ECS task from a completely different service, a misconfigured EC2 instance spun up for some unrelated purpose, a Lambda function, a bastion host, or in a worse variant of the mistake where the range gets widened to `0.0.0.0/0`, literally anything on the internet — could open a direct TCP connection to the backend on its app port, entirely bypassing the ALB. That bypass matters beyond "one extra hop skipped": the ALB is also where request routing, health-check gating, TLS termination, and (if one is ever attached) a WAF's L7 inspection and rate limiting all live. A direct connection to the container sidesteps every one of those controls simultaneously — no TLS requirement, no WAF rule evaluation, no rate limit, nothing standing between the request and the application code. It's a single line-level Terraform mistake with a large blast radius, and it's exactly the kind of error that a code reviewer who understands the SG-reference-vs-CIDR distinction would catch on sight, while one who doesn't would wave through as a harmless-looking connectivity fix.

---

## 7. Best Practice Check

**Security-group-reference ingress is unambiguously current (2026) best practice.** This isn't a case of "reasonable but dated" — chaining trust by security-group membership rather than IP range is what AWS's own Well-Architected guidance recommends, and it's the pattern used by essentially every mature, security-conscious AWS deployment for exactly the reasons in §5: stability under infrastructure churn, and rules that express intent rather than a snapshot of an IP layout. AstriX's ALB→ECS chain matches this standard cleanly, on the one interior hop where it matters most.

**The absence of a WAF is a real, honest gap for a production-facing ALB.** The CloudFront module accepts a `web_acl_id` variable specifically for attaching an AWS WAF Web ACL —

```hcl
# infra/modules/cloudfront_s3/variables.tf:119-120
variable "web_acl_id" {
  description = "AWS WAF Web ACL ID for CloudFront"
```
```hcl
# infra/modules/cloudfront_s3/main.tf:257
  web_acl_id          = var.web_acl_id
```

— and the dev environment wires it through from a root-level variable:

```hcl
# infra/environments/dev/main.tf:441
  web_acl_id                         = var.cloudfront_web_acl_id
```

But that variable is explicitly set to `null` in both the environment's actual configuration and its example template:

```hcl
# infra/environments/dev/terraform.tfvars:231
cloudfront_web_acl_id = null
```
```hcl
# infra/environments/dev/terraform.tfvars.example:179
cloudfront_web_acl_id              = null
```

So the plumbing for a WAF exists, but no Web ACL is actually attached in the deployed dev environment — the L7, HTTP-aware inspection layer described in §1(d) simply isn't present. This is worth naming plainly rather than glossing over: everything reaching the ALB and, through it, the backend is filtered only at the network layer (SG chain), never inspected for SQL injection patterns, credential-stuffing bursts, known-bad request signatures, or other content-level attack indicators. For a project at this stage that's a defensible, common tradeoff (a WAF is an ongoing cost and another surface to tune), but it is a gap, not a non-issue, and it's the kind of thing that should be closed before the "dev" environment's successor takes real production traffic at scale.

**Relying entirely on default NACLs, with zero customization, is a reasonable choice for a project this size.** NACLs earn their keep in environments large enough to need explicit-deny expressiveness at the subnet level — blocking a specific known-bad IP range VPC-wide regardless of what any individual resource's security group says, or satisfying a compliance framework that specifically mandates layered network controls, independent of application-level configuration. For a project with one VPC, a small number of well-understood resource types, and a security-group chain that's already correctly scoped, adding customized NACLs on top would mostly duplicate protection the security groups already provide, at the cost of the operational overhead described in §1(b) — remembering both directions per rule, managing numbered priority, auditing two overlapping filtering layers instead of one. A stricter compliance environment (PCI-DSS, FedRAMP, a large regulated enterprise) would very plausibly mandate NACL customization anyway, purely as an additional, independently-audited control — "the security groups are correct" and "there is a second, independent layer proving it" are different claims, and some compliance regimes want both. For AstriX's current scale and threat model, skipping that second layer is a sound engineering tradeoff, not a shortcut.

---

## 8. Debug Drill

**Scenario:** A team deploys a new revision of the backend task definition. The ECS service reports the new task as `RUNNING` and the target group's health checks show it registered — but the ALB never routes any real traffic to it, and requests either time out or fall back to older tasks. Where do you look, and in what order?

1. **Check the target group's health-check port against the container's actual listening port.** If a recent change moved the app to a different port (a new `PORT` env var, a Dockerfile change, a different framework default) without updating the ALB target group's health-check port to match, the health check itself would fail outright, not silently succeed while routing fails — so this is usually the *first* thing to rule out even though the story says "shows it as registered," because "registered" and "passing health checks continuously" are different states worth confirming aren't being conflated.

2. **Confirm the ECS security group actually allows the port the container is listening on.** This is the most likely culprit whenever "the app was reachable before a port change and isn't now." If the app's listening port changed but `var.app_port` (which flows into both the ECS task definition's `container_port` and the security group's `ingress.from_port`/`to_port` in `infra/modules/security/main.tf:99-101`) wasn't updated to match, the security group is still only permitting the *old* port. The ALB can reach the task's ENI at the network level, attempt a connection on the new port, and get silently refused — connection refused looks identical to "task not there" from the ALB's point of view, and it's easy to misdiagnose as a deployment or health-check problem rather than a one-line SG mismatch. Checking the actual `from_port`/`to_port` on the ECS security group's ingress rule against the container's real listening port is the fastest way to either confirm or rule this out.

3. **Verify the ingress rule is still a security-group reference, not a stale or incorrectly edited CIDR.** If someone touched this file recently — adding a new SG, refactoring the module, or "temporarily" loosening a rule to debug something else — check that the ingress rule for the app port still reads `security_groups = [aws_security_group.alb.id]` and not a CIDR block that no longer (or never did) correctly describe the ALB's actual traffic source. A CIDR that was accidentally scoped to the wrong subnet, or that references a subnet the ALB doesn't actually live in, produces exactly this symptom: the target group shows the task as registered (that's an ECS/ALB-level fact, unrelated to the SG), but real traffic from the ALB gets dropped at the network layer before it ever reaches the container.

4. **Check for a second, unrelated security group accidentally attached to the task.** ECS `network_configuration.security_groups` takes a list — if a previous debugging session or a copy-pasted module invocation left an extra, unrelated security group attached to the task (in addition to, or instead of, `module.security.ecs_tasks_security_group_id`), that group might not have an ALB-referencing ingress rule at all, blocking traffic that the "real" ECS security group would have allowed.

The unifying principle across all four steps: a target group reporting a task as "registered" and "healthy" tells you the ALB and ECS control planes agree the task exists and answered a health check — it tells you nothing about whether the network path between them stays open for *ordinary* traffic on the port your application actually cares about. Any time a task is visibly running and registered but effectively unreachable, the security group's port number and its source expression (reference vs. CIDR) are the first two things worth reading character-by-character, because a mismatch there produces symptoms — timeouts, silent connection failures — that look identical to a dozen other, harder-to-diagnose problems.
