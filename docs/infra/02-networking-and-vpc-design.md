# Networking & VPC Design

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md).

Every piece of compute AstriX runs — an ECS task, a NAT Gateway, an ALB — has to live *somewhere* on a network, and that network has to answer two questions before a single line of application code runs: who can reach this thing from the internet, and what can this thing reach on the internet in return? Get the answer wrong in either direction and you've either built something unreachable or something an attacker doesn't need to work hard for. A Virtual Private Cloud (VPC) is AWS's answer to "give me an isolated slice of network I fully control," but a VPC by itself is just an empty address space — 65,536 IP addresses and nothing else. Everything this chapter covers — subnets, gateways, route tables — is the work of turning that empty address space into a network with actual, defensible shape: some parts reachable from the internet, some parts deliberately not, and a documented path for how traffic gets between them. This file walks through the general landscape of how that shape gets designed, then reads AstriX's real Terraform, resource by resource, to see exactly which shape it chose and why.

---

## 1. The Landscape

Before opening `infra/modules/networking/main.tf`, it's worth surveying how the industry actually carves up a network, because the four shapes below aren't arranged from worst to best — they're arranged by how much isolation you're willing to pay for in operational complexity, and different projects at different maturity stages land in different places on that curve. Recognizing which one you're looking at is the skill that transfers to any unfamiliar cloud codebase, not just this one.

### (a) Flat / single-subnet VPC

The simplest possible shape: one VPC, one subnet (or several subnets that are functionally identical), everything gets a public IP, everything routes directly to an Internet Gateway. There's no network-level distinction between "things the internet should be able to reach" and "things it shouldn't" — that job is left entirely to security groups (instance-level firewalls) or, in the worst version of this pattern, to nothing at all.

```
# illustrative - not AstriX code
VPC: 10.0.0.0/16
  Subnet: 10.0.0.0/24  (everything lives here: web server, database, cache)
  Route: 0.0.0.0/0 -> Internet Gateway
```

This is extremely common in quick prototypes, hackathon projects, and a lot of `terraform init && terraform apply` tutorials, because it minimizes the number of moving parts you have to reason about — no NAT Gateway, no route table split, no "why can't my Lambda reach the internet" debugging. The honest cost is that it collapses defense-in-depth to a single layer: if a security group is ever misconfigured (a `0.0.0.0/0` ingress rule added for a debugging session and never removed, a database left on a public subnet with a public IP), there is no network-level backstop. The subnet itself has a route to the internet regardless of what any given resource's security group says today or might say after tomorrow's change.

### (b) Two-tier public/private subnet design — the AstriX pattern

Subnets are split into two tiers by role. **Public subnets** hold anything that legitimately needs to be reachable from, or reach out directly to, the internet — load balancers, NAT gateways, bastion hosts. **Private subnets** hold the actual workloads — application servers, databases, background workers — and have no route table entry sending traffic straight to an Internet Gateway. Outbound internet access from private subnets, when needed, is forced through a NAT Gateway sitting in a public subnet, which is a deliberate chokepoint rather than an accident.

```
# illustrative shape, not AstriX's exact CIDRs (see §3 for those)
VPC
  Public subnet  -> route 0.0.0.0/0 to Internet Gateway
  Private subnet -> route 0.0.0.0/0 to NAT Gateway (which lives in a public subnet)
```

This is the default reference architecture AWS itself has published for over a decade, and it's what you get by default from `aws vpc create` wizards, most Terraform VPC modules, and CDK's `aws-ec2.Vpc` construct out of the box. The tradeoff versus (a): you gain a real network-level isolation boundary — a private-subnet resource has no inbound path from the internet no matter what its security group says — at the cost of a NAT Gateway (a real, metered, non-trivial line item on the AWS bill) and one more layer of indirection to reason about when debugging connectivity.

### (c) Three-tier design with an isolated data subnet

A stricter variant of (b): a third subnet tier is added specifically for data stores, and unlike the "private" tier in (b), this isolated tier has **no route to a NAT Gateway at all** — not even outbound. Nothing in that tier can reach the internet, full stop; it can only be reached by, and only talk to, other resources inside the VPC. This is the shape AWS's own "Well-Architected" reference VPC and a lot of PCI-DSS/HIPAA-influenced designs converge on: web tier (public) → application tier (private, NAT-routed) → data tier (isolated, no NAT route whatsoever).

```
# illustrative - not AstriX code
Public subnet    -> route 0.0.0.0/0 to Internet Gateway   (ALB)
Private subnet   -> route 0.0.0.0/0 to NAT Gateway         (app servers)
Isolated subnet  -> no default route at all                (RDS, ElastiCache)
```

The gain over (b) is a stronger guarantee: even if an application-tier resource were fully compromised and its security groups were somehow bypassed, the data tier still has no *routable path* out to the internet to exfiltrate data over — a network-layer guarantee that no security-group rule change (even a rushed emergency one) can weaken by accident, because the route simply doesn't exist. The cost is one more subnet tier per AZ to provision, tag, and keep route tables correct for, and — often overlooked — this pattern only actually makes sense for resources that genuinely never need outbound internet access. A database that needs to call out to a SaaS API for an extension or a scheduled backup-to-S3-via-gateway-endpoint job needs a VPC endpoint added deliberately, or it doesn't belong in the fully isolated tier.

### (d) Fully serverless / no-VPC architectures

Some compute models remove the VPC decision from the developer's hands entirely. An AWS Lambda function that isn't explicitly attached to a VPC runs in an AWS-managed network with direct internet access and no subnet, route table, or NAT Gateway for the developer to configure — Lambda handles it. Platforms like Vercel, Netlify, and Cloudflare Workers go further: there is no VPC concept exposed to the developer at all; the platform's own multi-tenant infrastructure is the network, and "which subnet does this run in" is not a question the platform's user interface or configuration surface even has a field for.

The appeal is obvious — zero networking code, zero NAT Gateway bill, zero "why can't this Lambda resolve DNS" debugging session. The real cost is a loss of control that matters once a resource on the other end of a connection needs to trust *where* a request is coming from: a Lambda with no VPC attachment gets a different, unpredictable-to-you IP on every invocation, which breaks any downstream system that wants to IP-allowlist your traffic (a partner API, a legacy on-prem firewall). It's also structurally incompatible with reaching resources that are intentionally *not* internet-exposed — an RDS instance sitting in a private subnet with no public endpoint is invisible to a non-VPC Lambda, which is exactly why "should this Lambda be VPC-attached" becomes its own real design decision the moment serverless compute needs to talk to VPC-resident infrastructure.

---

## 2. AstriX's Choice

AstriX uses the two-tier public/private design from (b): a single VPC split into public and private subnets across two Availability Zones, an Internet Gateway for the public side, and a NAT Gateway for private-subnet egress — with that NAT Gateway defaulting to a single, cost-optimized instance shared across both AZs rather than one per AZ. There's no third, fully-isolated data tier (AstriX's data store is MongoDB Atlas, reached over the internet via NAT rather than a self-hosted database that would live in-VPC), and there's no serverless/no-VPC posture — the whole point of the module is giving ECS Fargate tasks a private subnet with controlled, NAT-mediated egress.

---

## 3. AstriX Implementation

All of the following is real, unedited Terraform from `infra/modules/networking/`.

The module file opens with an ASCII diagram in its header comment, which is worth reading first and then checking against the actual resources below it — documentation drifts, code doesn't:

```hcl
# infra/modules/networking/main.tf:1-30
# =============================================================================
# NETWORKING MODULE
# =============================================================================
# This module creates the foundational network infrastructure:
# - VPC with DNS support
# - Public subnets (for ALB, NAT Gateway)
# - Private subnets (for ECS tasks, Lambda)
# - Internet Gateway (public internet access)
# - NAT Gateway (outbound access for private subnets)
# - Route tables with proper associations
#
# Architecture:
# ┌─────────────────────────────────────────────────────────────────────────┐
# │                           VPC: 10.0.0.0/16                              │
# │                                                                         │
# │   AZ-A (us-east-1a)                    AZ-B (us-east-1b)                │
# │   ┌─────────────────────────┐         ┌─────────────────────────┐       │
# │   │ Public: 10.0.1.0/24     │         │ Public: 10.0.2.0/24     │       │
# │   │ • NAT Gateway           │         │ • (ALB)                 │       │
# │   │ • ALB                   │         │                         │       │
# │   └─────────────────────────┘         └─────────────────────────┘       │
# │                                                                         │
# │   ┌─────────────────────────┐         ┌─────────────────────────┐       │
# │   │ Private: 10.0.10.0/24   │         │ Private: 10.0.20.0/24   │       │
# │   │ • ECS Tasks             │         │ • ECS Tasks             │       │
# │   │ • Lambda (if VPC)       │         │ • Lambda (if VPC)       │       │
# │   └─────────────────────────┘         └─────────────────────────┘       │
# │                                                                         │
# └─────────────────────────────────────────────────────────────────────────┘
# =============================================================================
```

That diagram is a reasonable mental model but slightly idealized — it draws the NAT Gateway as living only in AZ-A's public subnet and the ALB only in AZ-B's, when in reality (verified against the resource blocks below) the ALB is provisioned across *both* public subnets by the separate `alb` module, and the number of NAT Gateways that actually get created depends entirely on the `single_nat_gateway` variable covered in §3.3 — in the default (`true`) configuration the diagram is accurate (one NAT, shared), but it would be misleading if read as a hard architectural constraint rather than the current default. Diagrams document intent at the time they were drawn; the `count` expressions below are the actual source of truth.

### 3.1 The VPC

```hcl
# infra/modules/networking/main.tf:57-72
resource "aws_vpc" "main" {
  cidr_block = var.vpc_cidr

  # Enable DNS hostnames - required for:
  # - ECS service discovery
  # - RDS endpoint resolution
  # - Many AWS services that need DNS names
  enable_dns_hostnames = true

  # Enable DNS support - required for internal DNS resolution
  enable_dns_support = true

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-vpc"
  })
}
```

`var.vpc_cidr` defaults to `10.0.0.0/16` (`infra/modules/networking/variables.tf:35-52`) — a /16 giving 65,536 addresses, comfortably oversized for what AstriX actually provisions inside it, which is the normal, recommended posture: a VPC's CIDR is essentially free to over-allocate up front and expensive to change later, since every subnet is carved out of it.

### 3.2 Public and private subnets

```hcl
# infra/modules/networking/main.tf:83-98
resource "aws_subnet" "public" {
  count = length(var.public_subnet_cidrs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = var.public_subnet_cidrs[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]

  # Auto-assign public IPs to instances launched in this subnet
  # Required for resources that need direct internet access
  map_public_ip_on_launch = true

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-public-${count.index + 1}"
    Tier = "public"
  })
}
```

```hcl
# infra/modules/networking/main.tf:109-123
resource "aws_subnet" "private" {
  count = length(var.private_subnet_cidrs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = data.aws_availability_zones.available.names[count.index]

  # No public IPs for private subnet resources
  map_public_ip_on_launch = false

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-private-${count.index + 1}"
    Tier = "private"
  })
}
```

Both resources use `count` over a *list* of CIDRs (`var.public_subnet_cidrs`, `var.private_subnet_cidrs`), and both index into `data.aws_availability_zones.available.names` with the same `count.index` — so `public[0]`/`private[0]` land in whatever the first AZ the region reports is, `public[1]`/`private[1]` in the second, and so on. This is the mechanism that keeps public and private subnets paired *by AZ index* throughout the rest of the module, which matters a lot once NAT routing enters the picture in §3.4. The defaults, from `variables.tf:58-97`, are `public_subnet_cidrs = ["10.0.1.0/24", "10.0.2.0/24"]` and `private_subnet_cidrs = ["10.0.10.0/24", "10.0.20.0/24"]` — matching the header diagram exactly. The one field that differs meaningfully between the two resources is `map_public_ip_on_launch`: `true` for public, `false` for private — this single boolean is what determines whether an instance launched into the subnet gets a public IP assigned automatically at all, independent of anything else about routing.

The AZ data source feeding both of these is worth including too, since it's what makes `count.index` resolve to real AZ names rather than a hardcoded list:

```hcl
# infra/modules/networking/main.tf:37-45
data "aws_availability_zones" "available" {
  state = "available"

  # Exclude local zones and wavelength zones for simplicity
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}
```

### 3.3 Internet Gateway

```hcl
# infra/modules/networking/main.tf:131-137
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-igw"
  })
}
```

One Internet Gateway per VPC is normal and sufficient — it's a horizontally-scaled, highly-available AWS-managed edge device, not a single point of failure the way a NAT Gateway can be; there's no "one per AZ" version of this resource because AWS doesn't need one.

### 3.4 NAT Gateway topology — the single-vs-per-AZ switch

This is the part of the module with the most real design rationale written directly into the comments, and it's worth reading verbatim rather than paraphrased:

```hcl
# infra/modules/networking/main.tf:139-164
# -----------------------------------------------------------------------------
# NAT GATEWAY TOPOLOGY
# -----------------------------------------------------------------------------
# Two shapes, selected by var.single_nat_gateway:
#
#   single_nat_gateway = true  (default, ~$32/month)
#     One NAT in the first public subnet; every private subnet routes through
#     it. Cheapest, but an AZ failure in that one AZ takes outbound internet
#     away from private subnets in *every* AZ - ECS tasks in the healthy AZ
#     stop being able to pull images or reach MongoDB Atlas.
#
#   single_nat_gateway = false (~$32/month per AZ)
#     One NAT + one EIP per public subnet/AZ, and one private route table per
#     AZ pointing at the NAT in its own AZ. An AZ failure is then contained to
#     that AZ. This is the correct production shape.
#
# Flipping this to false costs real money per AZ, so it stays true until
# somebody decides to spend it.

locals {
  nat_gateway_count = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : length(var.public_subnet_cidrs)) : 0

  # One route table shared by all private subnets when a single NAT serves
  # everything; one per private subnet when each AZ has its own NAT.
  private_route_table_count = var.enable_nat_gateway && !var.single_nat_gateway ? length(var.private_subnet_cidrs) : 1
}
```

Every downstream `count` in the module — the EIPs, the NAT Gateways themselves, the private route tables — is derived from these two `locals`, so this comment block is genuinely the load-bearing design decision for the entire NAT topology, not just documentation floating near it.

The Elastic IPs attached to each NAT Gateway:

```hcl
# infra/modules/networking/main.tf:166-184
# -----------------------------------------------------------------------------
# ELASTIC IPS FOR NAT GATEWAYS
# -----------------------------------------------------------------------------
# Static IP addresses for the NAT Gateways.
# These IPs won't change even if a NAT Gateway is recreated - which matters for
# any third party that allowlists this environment's egress IPs.

resource "aws_eip" "nat" {
  count = local.nat_gateway_count

  domain = "vpc"

  # Ensure IGW exists before creating EIP
  depends_on = [aws_internet_gateway.main]

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-nat-eip-${count.index + 1}"
  })
}
```

And the NAT Gateways themselves:

```hcl
# infra/modules/networking/main.tf:187-216
resource "aws_nat_gateway" "main" {
  count = local.nat_gateway_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-nat-${count.index + 1}"
  })

  # NAT Gateway needs IGW to exist first
  depends_on = [aws_internet_gateway.main]

  lifecycle {
    precondition {
      condition     = var.single_nat_gateway || length(var.private_subnet_cidrs) <= length(var.public_subnet_cidrs)
      error_message = "Per-AZ NAT Gateways (single_nat_gateway = false) need at least as many public subnets as private subnets - each private subnet routes to the NAT in its own AZ."
    }
  }
}
```

Note the `subnet_id = aws_subnet.public[count.index].id` line: each NAT Gateway is placed in the public subnet with the *same index* as itself, which — combined with the earlier AZ-index pairing between public and private subnets — is exactly what makes "the NAT in this AZ" a coherent phrase in the per-AZ mode. The `precondition` block is a genuine safety rail: Terraform will refuse to apply a per-AZ configuration where there are fewer public subnets than private ones, because the module has nowhere to put the extra NAT Gateways.

The module's own comment on the NAT Gateway resource also names the realistic cost-reduction alternatives worth knowing even though AstriX doesn't currently use any of them:

```hcl
# infra/modules/networking/main.tf:187-195
# -----------------------------------------------------------------------------
# NAT GATEWAYS
# -----------------------------------------------------------------------------
# Allows private subnet resources to access the internet (outbound only).
#
# COST NOTE: ~$32/month each + data transfer. Other ways to cut this:
# - Scheduling NAT deletion on weekends
# - VPC endpoints for ECR/S3/SSM (removes most NAT data transfer)
# - NAT instances (more work, but cheaper)
```

### 3.5 Route tables

Public subnets get one shared route table, with a `0.0.0.0/0` route to the Internet Gateway:

```hcl
# infra/modules/networking/main.tf:220-248
# -----------------------------------------------------------------------------
# PUBLIC ROUTE TABLE
# -----------------------------------------------------------------------------
# Routes for public subnets:
# - Local traffic stays in VPC (implicit)
# - Everything else (0.0.0.0/0) goes to Internet Gateway

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-public-rt"
  })
}

# Route to Internet Gateway for public subnets
resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

# Associate public subnets with public route table
resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
```

Private subnets get a `count`-driven set of route tables — one shared table in single-NAT mode, one per AZ in per-AZ mode — each routed to the NAT Gateway that shares its index:

```hcl
# infra/modules/networking/main.tf:251-296
# -----------------------------------------------------------------------------
# PRIVATE ROUTE TABLES
# -----------------------------------------------------------------------------
# Routes for private subnets:
# - Local traffic stays in VPC (implicit)
# - Everything else (0.0.0.0/0) goes to a NAT Gateway (if enabled)
#
# One table shared by every private subnet in single-NAT mode; one table per AZ
# otherwise, so each AZ's egress stays inside that AZ.
#
# MIGRATION NOTE: this resource gained `count`, so its state address moved from
# aws_route_table.private to aws_route_table.private[0]. On an environment
# applied before this change, run this once or Terraform will propose
# destroying and recreating the route table:
#   terraform state mv 'module.networking.aws_route_table.private' \
#                      'module.networking.aws_route_table.private[0]'

resource "aws_route_table" "private" {
  count = local.private_route_table_count

  vpc_id = aws_vpc.main.id

  tags = merge(var.common_tags, {
    Name = local.private_route_table_count == 1 ? "${var.project_name}-${var.environment}-private-rt" : "${var.project_name}-${var.environment}-private-rt-${count.index + 1}"
  })
}

# Route to NAT Gateway for private subnets (only if NAT is enabled).
# In per-AZ mode each table points at the NAT sharing its index, which is the
# NAT in the same availability zone (public and private subnets are both
# indexed against the same AZ list).
resource "aws_route" "private_nat" {
  count = var.enable_nat_gateway ? local.private_route_table_count : 0

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[var.single_nat_gateway ? 0 : count.index].id
}

# Associate private subnets with their route table
resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[local.private_route_table_count == 1 ? 0 : count.index].id
}
```

The `nat_gateway_id = aws_nat_gateway.main[var.single_nat_gateway ? 0 : count.index].id` line is the crux of the whole switch: in single-NAT mode, every route table's ternary collapses to index `0`, so all private route tables point at the one NAT Gateway that exists; in per-AZ mode, the ternary passes `count.index` straight through, so each table points at the NAT Gateway sharing its own index — the one physically sitting in that same AZ's public subnet. The migration-note comment above the resource is also worth flagging as real operational history, not decoration: adding `count` to a previously-singular resource changes its Terraform state address, and the comment documents the exact `terraform state mv` command needed so an existing environment doesn't get its route table destroyed and recreated by accident.

### 3.6 VPC Flow Logs (optional)

```hcl
# infra/modules/networking/main.tf:298-317
# -----------------------------------------------------------------------------
# VPC FLOW LOGS (Optional - for debugging/compliance)
# -----------------------------------------------------------------------------
# Captures network traffic information for analysis
# Useful for: security analysis, troubleshooting connectivity issues
#
# COST NOTE: Flow logs can add costs. Disabled by default for dev.

resource "aws_flow_log" "main" {
  count = var.enable_flow_logs ? 1 : 0

  vpc_id          = aws_vpc.main.id
  traffic_type    = "ALL"
  iam_role_arn    = aws_iam_role.flow_logs[0].arn
  log_destination = aws_cloudwatch_log_group.flow_logs[0].arn

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-flow-logs"
  })
}


resource "aws_cloudwatch_log_group" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name              = "/aws/vpc/${var.project_name}-${var.environment}/flow-logs"
  retention_in_days = var.flow_logs_retention_days

  tags = var.common_tags
}
```

The flow log itself needs an IAM role and inline policy to write into CloudWatch Logs, both also gated behind the same `count`:

```hcl
# infra/modules/networking/main.tf:329-372
resource "aws_iam_role" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name = "${var.project_name}-${var.environment}-flow-logs-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "vpc-flow-logs.amazonaws.com"
        }
      }
    ]
  })

  tags = var.common_tags
}

resource "aws_iam_role_policy" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name = "${var.project_name}-${var.environment}-flow-logs-policy"
  role = aws_iam_role.flow_logs[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams"
        ]
        Effect   = "Allow"
        Resource = "*"
      }
    ]
  })
}
```

All four flow-log resources — the flow log, its log group, its IAM role, and its policy — share the exact same `count = var.enable_flow_logs ? 1 : 0` gate, so they're either all four present or all four absent; there's no partial state where a role exists without the flow log using it.

### 3.7 Relevant variables and outputs

The two booleans driving all of this are declared with the cost/availability tradeoff spelled out directly in their descriptions:

```hcl
# infra/modules/networking/variables.tf:119-137
variable "single_nat_gateway" {
  description = <<-EOT
    Whether all private subnets share one NAT Gateway.

    true  (default): one NAT in the first public subnet. ~$32/month total.
                     Losing that one AZ removes outbound internet from private
                     subnets in EVERY AZ - ECS tasks in the surviving AZ can no
                     longer pull images or reach MongoDB Atlas. Acceptable
                     while cost matters more than AZ-fault isolation.

    false:           one NAT + EIP per public subnet/AZ, with each private
                     subnet routing through the NAT in its own AZ.
                     ~$32/month PER AZ. This is the production shape.

    Requires at least as many public subnets as private subnets when false.
  EOT
  type        = bool
  default     = true
}
```

```hcl
# infra/modules/networking/variables.tf:144-158
variable "enable_flow_logs" {
  description = <<-EOT
    Whether to enable VPC Flow Logs.
    
    Flow logs capture network traffic for:
    - Security analysis
    - Troubleshooting connectivity issues
    - Compliance requirements
    
    COST: CloudWatch Logs ingestion + storage costs
    Recommended: false for dev, true for prod
  EOT
  type        = bool
  default     = false
}
```

And the two outputs most relevant to the security discussion in §6 — the module hands back every NAT Gateway's public IP and every private route table's ID for anything downstream that needs them:

```hcl
# infra/modules/networking/output.tf:92-95
output "nat_gateway_public_ips" {
  description = "Public IPs of every NAT Gateway - this is the full egress IP set to hand to anyone allowlisting this environment"
  value       = aws_eip.nat[*].public_ip
}
```

```hcl
# infra/modules/networking/output.tf:111-114
output "private_route_table_ids" {
  description = "IDs of every private route table (one per AZ when single_nat_gateway is false)"
  value       = aws_route_table.private[*].id
}
```

### 3.8 How the `dev` environment wires it

```hcl
# infra/environments/dev/main.tf:158-180
module "networking" {
  source = "../../modules/networking"

  project_name = var.project_name
  environment  = var.environment

  # VPC Configuration
  vpc_cidr             = var.vpc_cidr
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs

  # Cost optimization: single NAT shared by both AZs. Set single_nat_gateway
  # to false to get one NAT per AZ (removes the single-AZ egress dependency,
  # adds ~$32/month per AZ).
  enable_nat_gateway = var.enable_nat_gateway
  single_nat_gateway = var.single_nat_gateway

  # Disable flow logs for dev (save costs)
  enable_flow_logs         = var.enable_flow_logs
  flow_logs_retention_days = var.flow_logs_retention_days

  common_tags = local.common_tags
}
```

Nothing here overrides the module's own defaults with a literal — every argument is passed through from a `dev`-level variable, which itself defaults to the same values as the module (`single_nat_gateway = true`, `enable_flow_logs = false`, per `infra/environments/dev/variables.tf`). The environment's comment restates the module's own rationale rather than introducing new logic, which is a reasonable sign that the two files were written to agree with each other rather than drift.

---

## 4. Request/Data Flow

**Outbound: an ECS task in a private subnet calling MongoDB Atlas or Google's OAuth API.** An ECS Fargate task is launched into one of the two private subnets — say `10.0.10.0/24`, the one whose `aws_subnet.private[0]` sits in the first AZ. The task makes an outbound HTTPS connection to, for example, `oauth2.googleapis.com`. That packet leaves the task's elastic network interface and hits the routing table for its subnet: `aws_route_table_association.private[0]` ties subnet `10.0.10.0/24` to whichever private route table owns index `0` — in the default single-NAT configuration, that's the one and only entry in `aws_route_table.private`, since `local.private_route_table_count` evaluates to `1`. That table's `aws_route.private_nat` entry sends anything matching `0.0.0.0/0` to `aws_nat_gateway.main[0]` (the ternary `var.single_nat_gateway ? 0 : count.index` collapses to `0`). That NAT Gateway lives in `aws_subnet.public[0]`, translates the private task's address to the NAT Gateway's own Elastic IP, and forwards the packet on to `aws_internet_gateway.main`, which hands it off to the actual internet. The response comes back through the same path in reverse — the NAT Gateway's connection-tracking table knows which private-subnet task originated the request and un-translates the address on the way in. From MongoDB Atlas's or Google's point of view, the request arrived from the NAT Gateway's Elastic IP, not from any address inside `10.0.0.0/16` — the private CIDR space is never visible outside the VPC at all.

If a second ECS task happens to be running in the *other* AZ's private subnet (`10.0.20.0/24`, `aws_subnet.private[1]`), in the default single-NAT configuration it makes exactly the same trip through the exact same NAT Gateway (`aws_route_table_association.private[1]` in single-NAT mode also resolves to route table index `0` per `private_route_table_count == 1 ? 0 : count.index`). Only in per-AZ mode (`single_nat_gateway = false`) would that second task instead route through `aws_nat_gateway.main[1]`, the NAT Gateway physically sitting in its own AZ's public subnet.

**Inbound: a browser reaching the ALB.** A browser resolves the ALB's DNS name and opens a TCP connection to it. The ALB (provisioned by the separate `alb` module, out of scope for this file but placed into the public subnets this module outputs via `public_subnet_ids`) has an elastic network interface in each of `10.0.1.0/24` and `10.0.2.0/24`. Both of those subnets are associated, via `aws_route_table_association.public`, with the single shared `aws_route_table.public`, whose `aws_route.public_internet` entry sends `0.0.0.0/0` traffic to `aws_internet_gateway.main` — but for *inbound* traffic that route is almost incidental; what actually makes the ALB reachable from the internet is that its subnets have `map_public_ip_on_launch = true` and the ALB itself is provisioned as internet-facing with an Elastic IP or AWS-assigned public IP in front of it, routable back through that same Internet Gateway. The ALB terminates the connection and, per its target group configuration, forwards the request onward to an ECS task's private IP — a packet that now travels entirely inside the VPC, never touching the Internet Gateway or the NAT Gateway at all, since both endpoints (the ALB's network interface and the ECS task's) live on the same private network.

---

## 5. Design Decisions & Tradeoffs

**Why 2 AZs, not 1 or 3.** Two is both a hard platform requirement and a reasonable stopping point. An Application Load Balancer will not provision at all with subnets in only a single Availability Zone — AWS enforces at least two AZs for ALB registration, which is why `variables.tf:72-75` validates `length(var.public_subnet_cidrs) >= 2` with the error message "At least 2 public subnets are required for ALB high availability," and the same validation exists for private subnets at `variables.tf:93-96`. Three or more AZs would buy marginally more fault tolerance (surviving two simultaneous AZ failures instead of one) at the cost of another subnet pair, another set of route table associations, and — if per-AZ NAT were also enabled — another $32/month NAT Gateway; for a project whose current blast-radius concern is "one AZ goes down," two is the minimum that satisfies the ALB's own hard requirement and the natural default until a specific reason to go to three shows up.

**Single NAT vs. per-AZ NAT.** This is the tradeoff the module's own comments (quoted in full in §3.4) already make explicit, and it's worth restating in plain terms rather than re-deriving it: a single, shared NAT Gateway costs about $32/month total and means every private subnet in every AZ depends on one NAT Gateway living in one specific AZ's public subnet. If that AZ has an outage, the NAT Gateway goes down with it, and — critically — this doesn't just affect workloads *in that AZ*. Because `aws_route_table.private` is a single shared table in this mode, an ECS task in the perfectly healthy second AZ loses outbound internet access too, since its route table still points at the now-unreachable NAT Gateway. It can't pull a new container image, and it can't reach MongoDB Atlas or the Google OAuth endpoint anymore, even though the compute it's running on is fine. Per-AZ NAT costs roughly $32/month *per AZ* — so double the bill for a 2-AZ setup — but gives each AZ its own NAT Gateway and its own private route table, so an AZ failure is contained to the workloads actually running in that AZ; the healthy AZ keeps working. AstriX defaults to the cheaper, shared option, and the module's own comment is candid about it being a cost decision rather than an oversight: "Flipping this to false costs real money per AZ, so it stays true until somebody decides to spend it."

**Why Flow Logs default to disabled.** `enable_flow_logs` defaults to `false` in both the module (`variables.tf:144-158`) and the `dev` environment, and the reasoning given in both places is the same: cost. VPC Flow Logs generate a CloudWatch Logs ingestion and storage bill proportional to actual traffic volume, and for a development environment where the primary goal is iterating on application code rather than producing an audit trail, that ongoing cost buys forensic capability that mostly goes unused. The module doesn't remove the capability — it's a fully-built, four-resource feature (§3.6) gated behind one boolean — it just declines to pay for it by default in the one environment that currently exists.

---

## 6. Security Considerations

**No inbound route from the internet to private subnets is the actual isolation boundary, not a security group rule.** `aws_subnet.private` never appears anywhere near `aws_route_table.public` or `aws_internet_gateway.main` — its only route table association is to `aws_route_table.private`, whose only non-local route goes to a NAT Gateway, and NAT Gateways are outbound-only by design; nothing on the internet can *initiate* a connection to a private-subnet resource through one. This matters as a distinct, additional layer beyond security groups: even in a scenario where an ECS task's security group had an overly permissive ingress rule (`0.0.0.0/0` on some port, added during debugging and forgotten), there is still no *route* for internet traffic to use to reach that task in the first place. Security groups are important, but they're a second gate behind this one — this is what "defense in depth" concretely means at the network layer, and it's the exact isolation the flat/single-subnet design from §1(a) doesn't have: in that design, the security group really is the only thing standing between a misconfiguration and internet exposure.

**What Flow Logs would add, if enabled.** `aws_flow_log.main` captures `traffic_type = "ALL"` — accepted and rejected traffic alike — at the ENI level for everything in the VPC, and ships it to a dedicated CloudWatch Log Group. For security forensics specifically, this is the record that answers "did anything actually talk to this address, and when" after the fact: which internal resource opened a connection to an external IP, whether a security-group-denied connection attempt was made (and from where), and — reconstructed after an incident — a timeline of exactly what traffic crossed the VPC boundary. Without it, that reconstruction has no source; CloudWatch alarms and application logs can show what the *application* did, but not what the *network* saw. This is precisely the gap the module's own comment on `enable_flow_logs` names as the tradeoff: "Recommended: false for dev, true for prod."

**Static NAT Gateway EIPs matter for anyone allowlisting this environment's egress.** `aws_eip.nat`'s own comment states it plainly: "These IPs won't change even if a NAT Gateway is recreated - which matters for any third party that allowlists this environment's egress IPs." This is a real, common integration pattern: a partner API, a payment processor, or a legacy on-prem system that restricts inbound connections to a known list of source IPs needs *stable* addresses to allowlist — if AstriX's outbound IP changed every time the NAT Gateway was replaced (say, during a Terraform apply that happened to recreate it), any such allowlist would break silently the next time that resource was rebuilt. Because the EIP is a separate, independently-lifecycled resource attached to the NAT Gateway rather than an ephemeral address the NAT Gateway generates itself, `nat_gateway_public_ips` (§3.7) is a value that can be handed to a third party once and trusted to keep working — a small detail, but exactly the kind of detail that turns into an unplanned outage when it's missing.

---

## 7. Best Practice Check

Judged against 2026 industry-standard VPC design, a 2-AZ public/private VPC with a single shared NAT Gateway is a defensible, unremarkable choice for a project at AstriX's current stage — not overkill, and not underbuilt for what it's actually being asked to do. The two-tier split with a hard network-level boundary between internet-facing and internal resources is exactly the reference shape AWS itself has recommended for years and what most managed Terraform/CDK VPC constructs still produce by default; there's no meaningful additional defense-in-depth AstriX is leaving on the table by not also building the three-tier isolated-data-subnet shape from §1(c), largely because its actual data store (MongoDB Atlas) isn't a VPC-resident resource that a fully isolated subnet would meaningfully protect — the isolated-tier pattern earns its keep protecting a self-hosted database sitting inside the VPC, which isn't AstriX's architecture. Disabling Flow Logs by default is also a reasonable cost/security tradeoff **for an environment that is genuinely a development environment** — most teams don't pay for the forensic-logging tier of their infrastructure until there's production traffic and a production incident-response process that would actually consume those logs.

The caveat worth naming plainly, independent of any external audit and purely from reading the Terraform: right now `dev` is the *only* environment this repository defines. `infra/environments/` has no `staging/` or `prod/` sibling, and every default discussed in this file — single NAT, no Flow Logs, 2 AZs — is calibrated for a development workload, but because there's no second environment, `dev` is quietly doing double duty as whatever AstriX's production infrastructure currently is, if it's running anywhere at all. That's not a defect in the networking module itself — every variable it needs to become a proper production configuration (`single_nat_gateway = false`, `enable_flow_logs = true`) already exists and is a one-line flip, which is good design — it's a lifecycle-stage observation about the repository as a whole: the module is production-*capable*, but nothing in the codebase currently instantiates it that way. Worth keeping in mind the day real user traffic starts flowing through whatever environment is actually live.

---

## 8. Debug Drill

**Scenario:** ECS tasks running in one Availability Zone can reach the internet fine — they pull images, they call MongoDB Atlas, they complete OAuth callbacks — but tasks in the *other* AZ intermittently or consistently time out reaching the same external endpoints. Where do you look, and in what order?

**First: confirm the topology you're actually running, not the one you assume.** Check the live value of `single_nat_gateway` for the environment (`terraform state show module.networking.aws_nat_gateway.main` or simply reading the environment's `.tfvars`). If it's `true` (the AstriX default), there is exactly one NAT Gateway in the entire VPC, and *both* AZs' private route tables point at it — meaning an AZ-specific failure pattern shouldn't exist at all in this mode; if you're seeing one anyway, the problem probably isn't NAT routing, it's something scoped to that specific subnet or the tasks placed in it (a security group difference, a subnet-level NACL if one was added outside this module, or simply that the failing tasks happen to be newer revisions with a different bug). If it's `false` (per-AZ NAT), then an AZ-specific outbound failure is exactly the failure mode the topology is *supposed* to contain to one AZ — which makes the second AZ's NAT Gateway, its EIP, and its route table the first three things to check, in that order.

**Second: verify the route table association, not just the route table's contents.** It's possible for a route table to have a perfectly correct `0.0.0.0/0 -> NAT Gateway` route and still not apply to the subnet you think it does, if `aws_route_table_association` was ever pointed at the wrong index — this module's per-AZ association logic (`aws_route_table.private[local.private_route_table_count == 1 ? 0 : count.index]`) is a ternary specifically because getting this indexing wrong is an easy mistake to introduce in a hand-edited fork of this pattern. Pull the actual associations for the affected subnet (`aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<subnet-id>`) and confirm which route table it's really associated with, then check that table's routes independently — don't assume the mapping in the Terraform source matches the mapping actually applied, especially if the state was ever manually modified or the module was upgraded across the `count`-introducing change noted in §3.5's migration comment.

**Third: check the NAT Gateway's own health and its subnet placement.** A NAT Gateway is an AWS-managed resource, but it's still tied to a specific subnet in a specific AZ (`subnet_id = aws_subnet.public[count.index].id`), and if that public subnet's own route to the Internet Gateway were ever misconfigured (someone hand-edited the public route table, or a second, conflicting route table got associated with that public subnet outside of Terraform), the NAT Gateway itself would lose its own path out, and every private-subnet resource routing through it would fail identically to what's described. The AWS Console's VPC dashboard reports NAT Gateway status directly (`available`, `failed`, `pending`) and is faster to check than re-deriving it from Terraform.

**Fourth, and often skipped too early: security group egress, not just the network route.** A route existing doesn't guarantee traffic is allowed to use it — the ECS task's own security group needs an egress rule permitting the destination port and protocol (typically `443` for HTTPS to MongoDB Atlas or Google's APIs). If the affected AZ's tasks are running under a *different* task definition revision, a different service, or a different security group than the working AZ's tasks — which happens more often than expected when services are updated one AZ's worth of tasks at a time during a rolling deployment — an overly-narrow egress rule on just that revision would produce exactly this symptom and has nothing to do with the networking module at all. Comparing the security group actually attached to a failing task against one attached to a working task, side by side, is usually the fastest way to rule this cause in or out before spending more time in route tables that were actually fine all along.

A closely related variant of this scenario — a *newly added* private subnet's resources can't reach the internet at all, not intermittently — almost always traces back to one specific gap: a new private subnet CIDR was added to `var.private_subnet_cidrs` but the corresponding `aws_route_table_association.private` never picked it up, either because the module wasn't re-applied, or because (in per-AZ mode) the new subnet's AZ doesn't have a NAT Gateway of its own yet — the `precondition` in `aws_nat_gateway.main` (§3.3) exists specifically to catch the case where private subnets outnumber public ones, but it won't catch a case where the counts match but the new private subnet's AZ genuinely has no NAT Gateway serving it because `single_nat_gateway` was left `true` and the "shared" NAT simply doesn't route that AZ's traffic the way someone assumed it would. Checking `terraform plan` for what it actually intends to create — not what the change author intended — is the fastest way to catch this before it ships.
