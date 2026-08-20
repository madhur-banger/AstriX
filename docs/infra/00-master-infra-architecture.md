# Infra — Master Architecture

> Part of the [AstriX engineering curriculum](../Architecture.md). This file is the system map for `infra/`: the full AWS topology, the real Terraform module dependency graph (verified against `environments/dev/main.tf`, not copied uncritically from the existing README diagram), and the deploy flow as it actually runs in GitHub Actions today. Each deep dive below goes chapter-deep — landscape of alternatives first, then AstriX's actual implementation — into one slice of it.

AstriX's infrastructure is entirely AWS, entirely Terraform, and entirely container-based: there is no Kubernetes anywhere in this repo, no EC2 instance running application code, and no serverless compute in the request path — the backend is one Docker image running as an ECS **Fargate** task, and the frontend is a static build served from S3 through CloudFront. There is currently exactly **one** Terraform environment, `dev` (`infra/environments/dev/`) — "prod" doesn't structurally exist as a separate `environments/prod/` directory yet, so every resource this file describes is, today, the same environment that actually serves traffic.

---

## 1. Landscape: how infrastructure gets built

Before drawing AstriX's boxes and arrows, it's worth naming the actual menu of options for turning "I need a VPC, a load balancer, and a container service" into running infrastructure:

| Approach | What it looks like | Tradeoff |
|---|---|---|
| **ClickOps** | An engineer creates resources by hand in the AWS Console | Fast for a one-off experiment; unreproducible, undocumented, and impossible to diff or review as a PR |
| **Imperative scripting** | A bash/Python script calls the AWS CLI or SDK step by step to create resources | Reproducible if the script is re-run carefully, but has no concept of "current state" — re-running it doesn't know what already exists or safely reconcile drift |
| **Declarative IaC** | A tool (Terraform, Pulumi, AWS CDK, CloudFormation) is handed a *desired* end state and computes + applies the diff against real, tracked state | Reviewable as a diff (`terraform plan`), safely re-runnable, but requires learning the tool's state model and accepting its abstractions |

AstriX declares its infrastructure — specifically in **Terraform**, with remote state in S3 and locking in DynamoDB. The full survey of Terraform vs. Pulumi vs. CDK vs. CloudFormation vs. ClickOps, and why Terraform specifically, is [`11-infrastructure-as-code-with-terraform.md`](./11-infrastructure-as-code-with-terraform.md). This file assumes that choice and maps what it actually produces once applied.

---

## 2. Full AWS topology

Two independent origins are reached directly by the browser. This is the same fact `docs/Architecture.md` §2 establishes at the whole-system level; here it's redrawn down to the actual subnet/AZ/service layout that produces it:

```
                                        Internet
                                            │
                    ┌───────────────────────┴────────────────────────┐
                    │ HTTPS, static assets                            │ HTTP/HTTPS, /api/*
                    ▼                                                  ▼
      ┌───────────────────────────┐                    ┌──────────────────────────────┐
      │ CloudFront distribution    │                    │ Application Load Balancer     │
      │ (OAC → private S3 origin,  │                    │ (public subnets, both AZs)    │
      │ SPA-routing Function)      │                    │ :80 → redirect → :443         │
      └──────────────┬─────────────┘                    └───────────────┬────────────────┘
                      │ origin fetch                                      │ target group, by IP
                      ▼                                                    ▼
      ┌───────────────────────────┐                    ┌──────────────────────────────┐
      │ S3 bucket (private,        │                    │ ECS Fargate service            │
      │ React SPA build output)    │                    │ (private subnets, both AZs,    │
      └───────────────────────────┘                    │ desired_count = 2)              │
                                                          └───────────────┬────────────────┘
                                                                            │
                              ┌─────────────────────────────┬──────────────┼──────────────────┐
                              ▼                              ▼                                 ▼
                  ┌───────────────────────┐    ┌──────────────────────┐         ┌──────────────────────┐
                  │ SSM Parameter Store    │    │ MongoDB Atlas         │         │ Google OAuth 2.0 /    │
                  │ (+ KMS CMK); secrets   │    │ (external — not in    │         │ Resend (external      │
                  │ injected at container  │    │ this VPC at all)      │         │ HTTPS APIs, called    │
                  │ start                  │    └──────────────────────┘         │ directly by the task)  │
                  └───────────────────────┘                                       └──────────────────────┘

  VPC 10.0.0.0/16, 2 Availability Zones
    Public  subnets  10.0.1.0/24, 10.0.2.0/24   → ALB, single shared NAT Gateway, route to Internet Gateway
    Private subnets  10.0.10.0/24, 10.0.20.0/24 → ECS Fargate tasks only, no public IP, egress via NAT

  CI/CD path (GitHub Actions, OIDC role astrix-dev-github-actions-role):
    backend/**  changed → docker build → push to ECR (astrix-dev-backend) → ecs update-service --force-new-deployment
    client/**   changed → vite build (API URL read from SSM) → s3 sync --delete → cloudfront create-invalidation

  Observability / cost guardrails:
    CloudWatch (ECS CPU/mem/task-count + ALB 5xx/unhealthy-host alarms, Container Insights, awslogs log group)
      → single SNS topic "alerts" → email subscriber
    AWS Budgets (monthly threshold, 80% forecasted + 100% actual) → same email subscriber
```

The backend never receives traffic through CloudFront — the ALB is a second, fully independent public origin. This is a deliberate architectural decision, not an oversight, and it's stated directly in the Terraform itself:

```hcl
# infra/modules/cloudfront_s3/main.tf:236-248
# -----------------------------------------------------------------------------
# CLOUDFRONT DISTRIBUTION
# -----------------------------------------------------------------------------
#
# Deliberately frontend-only: the API is NOT routed through this
# distribution. Caching a cookie-authenticated API response at the edge
# risks serving one user's response to another - see infra/README.md and
# scripts/update-urls.sh for the full rationale. Earlier revisions of this
# module wired an /api/* behavior to the ALB origin anyway (dead, unused
# code that contradicted the documented architecture); it's been removed
# rather than left as latent, contradictory surface. If a future need
# genuinely requires proxying the API through CloudFront, reintroduce it
# deliberately alongside updated docs, not as a default.
```

The reasoning is a caching correctness problem, not a performance one: CloudFront's whole value proposition is caching a response once and replaying it to many viewers from an edge location. The frontend's static JS/CSS/HTML bundle is exactly that kind of content — identical for every visitor. An authenticated API response is the opposite: `GET /api/user/current` returns a *different* body for every caller, keyed off a bearer token and cookie the CDN has no business inspecting or caching by. Route that through a CDN with even slightly permissive cache-key or TTL settings and the mistake is user A's session data served to user B. Bypassing CloudFront for `/api/*` entirely removes that failure mode instead of trying to configure around it. Note also, per the diagram above, that the two backend halves fail independently: a CloudFront/S3 outage doesn't take the API down, and an ECS/ALB problem doesn't take the static site down — `deploy-frontend.yml` and `deploy-backend.yml` are two separate pipelines with no shared failure domain (see §4).

---

## 3. Terraform module dependency graph

`infra/modules/` currently holds nine modules:

| Module | Creates (per its own header comment) |
|---|---|
| `networking` | VPC, public/private subnets across 2 AZs, Internet Gateway, NAT Gateway, route tables (`infra/modules/networking/main.tf:1-10`) |
| `security` | Security groups for ALB, ECS tasks, and optionally Lambda/database/VPC-endpoints (`infra/modules/security/main.tf:1-8`) |
| `iam` | ECS task execution role, ECS task role, Lambda execution role, GitHub Actions OIDC role (`infra/modules/iam/main.tf:1-8`) |
| `ecr` | Container registries for Docker images — backend, optionally Lambda (`infra/modules/ecr/main.tf:1-9`) |
| `alb` | The internet-facing Application Load Balancer, target group, health checks, HTTP listener (`infra/modules/alb/main.tf:1-8`) |
| `acm` | TLS certificate for the ALB's HTTPS listener — self-signed/local by default, ACM + DNS validation for a real custom domain (`infra/modules/acm/main.tf:1-8`) |
| `parameter-store` | SSM Parameter Store entries (SecureString + standard) plus the KMS CMK that encrypts them (`infra/modules/parameter-store/main.tf:1-15`) |
| `ecs` | ECS cluster, task definition, service, target-tracking autoscaling, CloudWatch log group (`infra/modules/ecs/main.tf:1-14`) |
| `cloudfront_s3` | The S3 bucket for the SPA build and the CloudFront distribution in front of it (`infra/modules/cloudfront_s3/main.tf:1-14`) |

`infra/environments/dev/main.tf` is the only place these are wired together — `infra/README.md` draws that wiring as one straight line (`networking → security → iam → ecr`, then `alb → acm → parameter-store → ecs → cloudfront_s3`). Reading the actual `module` blocks and `depends_on` attributes gives a graph that mostly matches that but diverges in one place worth calling out explicitly:

```
networking ──▶ security ──▶ alb ◀── (public_subnet_ids from networking)
    │                         │
    │ vpc_id, vpc_cidr        │ alb_security_group_id
    ▼                         ▼
 (security, above)          acm ── alb_dns_name ──▶ aws_lb_listener.https (root resource)
                              │                          │ certificate_arn, depends_on=[acm]
                              │ depends_on=[alb, acm]     │
                              ▼ (no attribute ref used)   │
                        cloudfront_s3 ◀────────────────────┘
                              │
                              │ distribution_domain_name, via local.frontend_url
                              ▼
   iam ───────────────────▶ parameter_store ◀── alb_dns_name (local.api_base_url)
    ▲  ecs_task_execution_      │  depends_on=[acm, aws_lb_listener.https]
    │  role_arn                │
    │  (resource-level:        ▼
    │  its KMS-decrypt IAM    ecs ◀── ecr.backend_repository_url
    └──policy needs             ▲  depends_on=[alb, parameter_store]
       parameter_store.         └── networking.private_subnet_ids,
       kms_key_arn — see            security.ecs_tasks_security_group_id,
       main.tf:222-231)             iam.{execution,task}_role_arn
```

Two things in that graph are easy to get wrong from the README's straight-line version:

**`cloudfront_s3` actually has to exist before `parameter_store`, not after it.** `parameter_store`'s `frontend_origin` and `frontend_google_callback_url` inputs are computed from a local value that reads `module.cloudfront_s3.distribution_domain_name`:

```hcl
# infra/environments/dev/main.tf:75-96
locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
    Owner       = var.owner
  }
  # Protocol based on HTTPS enablement
  protocol = var.enable_https ? "https" : "http"

  # URLs automatically computed
  alb_base_url = var.enable_https ? "https://${module.alb.alb_dns_name}" : "http://${module.alb.alb_dns_name}"
  api_base_url = "${local.alb_base_url}/api"
  frontend_url = "https://${module.cloudfront_s3.distribution_domain_name}"

  # Callbacks
  google_callback_url          = "${local.api_base_url}/auth/google/callback"
  frontend_google_callback_url = "${local.frontend_url}/google/callback"

  # Cookie domain (ALB domain for proper cookie handling)
  cookie_domain = module.alb.alb_dns_name
}
```

Terraform builds its dependency graph from these references, not from the order modules are declared in the file — and `module "cloudfront_s3"` is in fact declared *last* in `main.tf` (line 424), well after `module "parameter_store"` (line 337). That's fine; Terraform still applies `cloudfront_s3` first because `parameter_store` needs its output. It just means the file's own top-to-bottom reading order is the opposite of the real apply order at that point in the graph — worth knowing before assuming "declared later" means "applied later."

**The `iam` ↔ `parameter_store` relationship looks cyclic and isn't**, because the two edges land on different resources inside each module — this is explained directly in the source rather than left as something to puzzle out:

```hcl
# infra/environments/dev/main.tf:222-231
  # KMS key the ECS execution role must be able to decrypt with. Prefer an
  # explicitly-supplied key, otherwise the CMK the parameter-store module
  # creates - this is what keeps the role's kms:Decrypt statement scoped to a
  # single key instead of "*".
  #
  # No dependency cycle here despite parameter_store also consuming an iam
  # output: Terraform's graph is per-resource, and the two edges touch
  # different resources (aws_iam_role.ecs_task_execution -> aws_kms_key ->
  # aws_iam_role_policy.ecs_task_execution_secrets).
  kms_key_arn = var.kms_key_arn != null ? var.kms_key_arn : module.parameter_store.kms_key_arn
```

`ecr` is the one module with genuinely zero edges to or from anything else in this graph — nothing else consumes its outputs except `ecs` (`ecr_repository_url`), and it consumes nothing from `networking`/`security`/`iam` despite sitting textually between them and `alb` in both the README and this file. It could be applied first, last, or in parallel with `networking` and the result would be identical.

Per-module deep dives: [`02`](./02-networking-and-vpc-design.md) (networking), [`03`](./03-security-groups-and-network-segmentation.md) (security), [`04`](./04-identity-and-access-management.md) (iam), [`05`](./05-container-registry-and-image-lifecycle.md) (ecr), [`07`](./07-load-balancing-and-traffic-routing.md) (alb), [`08`](./08-tls-and-certificate-management.md) (acm), [`09`](./09-secrets-and-configuration-management.md) (parameter-store), [`06`](./06-compute-and-container-orchestration-ecs-fargate.md) (ecs), [`10`](./10-cdn-and-static-asset-delivery.md) (cloudfront_s3).

---

## 4. The real deploy flow

Four workflows in `.github/workflows/` cover four distinct triggers, plus a fifth (`pr-check.yml`) that gates every PR before any of them run in earnest. All four AWS-touching workflows authenticate the same way — no long-lived AWS access keys stored as GitHub secrets, only a short-lived role assumed via GitHub's OIDC identity token:

```yaml
# .github/workflows/deploy-backend.yml:17-38
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    name: Build and Deploy
    runs-on: ubuntu-latest
    # Gated behind the "production" GitHub Environment, the same mechanism
    # infra.yml's apply job uses ("infra-apply"). This is what makes a push to
    # main pause for approval instead of shipping straight to the environment
    # that de facto serves real users - add required reviewers to the
    # "production" environment in repo settings, or this is a no-op.
    environment: production
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/astrix-dev-github-actions-role
          aws-region: ${{ env.AWS_REGION }}
```

That role — `astrix-dev-github-actions-role` — is exactly the OIDC-federated role the `iam` module creates (see [`04-identity-and-access-management.md`](./04-identity-and-access-management.md) for the trust-policy detail). The `environment: production` line matters more than it looks: a GitHub Environment can require human reviewers before a job proceeds, which is the only thing standing between "push to `main`" and "resources serving real traffic change" — and it's a no-op unless someone has actually configured required reviewers on that environment in repo settings.

### 4.1 Push to `main` touching `backend/**`

`deploy-backend.yml` triggers on exactly that path filter:

```yaml
# .github/workflows/deploy-backend.yml:1-15
name: Deploy Backend

on:
  push:
    branches: [main]
    paths:
      - 'backend/**'
      - '.github/workflows/deploy-backend.yml'
  workflow_dispatch:

env:
  AWS_REGION: us-east-1
  ECR_REPOSITORY: astrix-dev-backend
  ECS_CLUSTER: astrix-dev-cluster
  ECS_SERVICE: astrix-dev-backend-service
```

After assuming the OIDC role, it builds the image from `backend/Dockerfile` (§6 below), tags it with both the commit SHA and `latest`, pushes both tags to ECR, and then does something worth naming explicitly because it's easy to skip when hand-rolling a pipeline: it **blocks the deploy on the registry's own vulnerability scan**, not just on the build succeeding:

```yaml
# .github/workflows/deploy-backend.yml:56-87
      - name: Wait for ECR image scan and check findings
        env:
          IMAGE_TAG: ${{ github.sha }}
        run: |
          echo "Waiting for ECR image scan to complete..."
          for i in $(seq 1 30); do
            STATUS=$(aws ecr describe-image-scan-findings \
              --repository-name "$ECR_REPOSITORY" \
              --image-id imageTag="$IMAGE_TAG" \
              --query 'imageScanStatus.status' --output text 2>/dev/null || echo "IN_PROGRESS")
            if [ "$STATUS" = "COMPLETE" ] || [ "$STATUS" = "FAILED" ]; then
              break
            fi
            sleep 10
          done

          if [ "$STATUS" != "COMPLETE" ]; then
            echo "::warning::ECR scan did not complete in time (status: $STATUS) - not blocking deploy, but check the scan manually."
            exit 0
          fi

          CRITICAL=$(aws ecr describe-image-scan-findings \
            --repository-name "$ECR_REPOSITORY" \
            --image-id imageTag="$IMAGE_TAG" \
            --query 'imageScanFindings.findingSeverityCounts.CRITICAL' --output text 2>/dev/null || echo "0")
          CRITICAL=${CRITICAL/None/0}

          echo "Critical vulnerabilities found: $CRITICAL"
          if [ "$CRITICAL" != "0" ]; then
            echo "::error::$CRITICAL CRITICAL vulnerabilities found in the image. Review: aws ecr describe-image-scan-findings --repository-name $ECR_REPOSITORY --image-id imageTag=$IMAGE_TAG"
            exit 1
          fi
```

Only after that gate passes does it force a new ECS deployment and wait for it to stabilize:

```yaml
# .github/workflows/deploy-backend.yml:89-102
      - name: Update ECS service
        run: |
          aws ecs update-service \
            --cluster $ECS_CLUSTER \
            --service $ECS_SERVICE \
            --force-new-deployment

      - name: Wait for service stability
        run: |
          echo "Waiting for ECS service to stabilize..."
          aws ecs wait services-stable \
            --cluster $ECS_CLUSTER \
            --services $ECS_SERVICE
          echo "✅ Deployment complete!"
```

"Stabilize" here leans on the ECS deployment circuit breaker configured in the `ecs` module — full mechanics of that, and what happens when it trips, are in [`13-deployment-strategies-and-rollback.md`](./13-deployment-strategies-and-rollback.md).

### 4.2 Push to `main` touching `client/**`

`deploy-frontend.yml` mirrors the trigger shape (`client/**` instead of `backend/**`) but the build step is the interesting part: the frontend has no runtime environment-variable mechanism (it's a static bundle, there's no server to read `process.env` at request time), so the API's base URL has to be baked in at *build* time, sourced from the same Parameter Store the backend reads from:

```yaml
# .github/workflows/deploy-frontend.yml:54-75
      - name: Get API URL from SSM
        id: ssm
        run: |
          API_URL=$(aws ssm get-parameter --name "/astrix/dev/VITE_API_BASE_URL" --query "Parameter.Value" --output text)
          echo "api_url=$API_URL" >> $GITHUB_OUTPUT

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: client/package-lock.json

      - name: Install dependencies
        working-directory: client
        run: npm ci

      - name: Build
        working-directory: client
        run: npm run build
        env:
          VITE_API_BASE_URL: ${{ steps.ssm.outputs.api_url }}
```

That means changing the API's URL (a new custom domain, say) requires a Parameter Store update *and* a frontend rebuild — the value isn't re-read after the bundle is built. The workflow then syncs the build output to S3 and invalidates every CloudFront-cached path so viewers don't keep getting a stale `index.html`/JS bundle referencing an old build:

```yaml
# .github/workflows/deploy-frontend.yml:77-87
      - name: Sync to S3
        working-directory: client
        run: |
          aws s3 sync dist/ s3://$S3_BUCKET/ --delete

      - name: Invalidate CloudFront
        run: |
          aws cloudfront create-invalidation \
            --distribution-id ${{ steps.cloudfront.outputs.distribution_id }} \
            --paths "/*"
          echo "✅ Frontend deployed and cache invalidated!"
```

### 4.3 A PR touching `infra/**`

`infra.yml` never applies on a PR — it only validates and shows the blast radius. `terraform fmt -check`, `terraform validate`, and `tfsec` run with no AWS credentials at all (they don't need any — this is pure static analysis against the HCL), and a separate job then assumes the OIDC role just to run `terraform plan` and post the output as a PR comment:

```yaml
# .github/workflows/infra.yml:71-79
  # -----------------------------------------------------------------------
  # PLAN ON PR - shows the actual blast radius of an infra change before
  # it's merged, instead of only finding out when someone manually runs
  # this workflow later. Never applies.
  # -----------------------------------------------------------------------
  plan-on-pr:
    name: Terraform Plan (PR)
    if: github.event_name == 'pull_request'
    needs: validate
    runs-on: ubuntu-latest
```

Applying is a separate, manually-dispatched job gated behind its own GitHub Environment (`infra-apply`, distinct from the `production` environment the deploy workflows use), and it makes a point of *not* uploading the binary plan file as a workflow artifact:

```yaml
# .github/workflows/infra.yml:137-179 (excerpt)
  terraform:
    name: Terraform ${{ inputs.action }}
    if: github.event_name == 'workflow_dispatch'
    needs: validate
    runs-on: ubuntu-latest
    environment: infra-apply
    ...
      # Plan and apply run in the same job on the same runner, so tfplan never
      # has to cross a job boundary. It is deliberately NOT uploaded as an
      # artifact: a binary plan file embeds every resolved value, including
      # SSM SecureString contents and other `sensitive = true` inputs, and a
      # workflow artifact is downloadable by anyone with read access to the
      # repo. The human-readable plan is already in this step's log output.
      - name: Terraform Plan
        id: plan
        run: |
          terraform plan -out=tfplan -no-color 2>&1 | tee plan_output.txt
          echo "Plan completed"

      - name: Terraform Apply
        if: inputs.action == 'apply'
        run: |
          terraform apply -auto-approve tfplan
          echo "✅ Infrastructure deployed!"
```

That comment is worth internalizing on its own: a `tfplan` binary file is not just a diff, it's a fully-resolved snapshot of every attribute Terraform is about to set — including secrets marked `sensitive = true` in the config, which suppresses them from *console/log* output but does nothing to keep them out of the plan file itself. Keeping plan and apply in one job, on one runner, with the file never leaving disk, avoids turning a routine `terraform.tfvars` secret into a downloadable GitHub Actions artifact.

### 4.4 Manual rollback

`rollback.yml` is `workflow_dispatch`-only, taking a target (`backend`, `frontend`, or `both`) and a commit SHA. The SHA is validated as looking like a real git SHA before anything else runs, closing off the obvious injection surface of a hand-typed workflow input reaching a shell command downstream:

```yaml
# .github/workflows/rollback.yml:26-36
  validate-input:
    name: Validate commit_sha
    runs-on: ubuntu-latest
    steps:
      - name: Check commit_sha looks like a git SHA
        run: |
          if ! [[ "${{ inputs.commit_sha }}" =~ ^[0-9a-f]{7,40}$ ]]; then
            echo "::error::commit_sha must be a 7-40 character hex git SHA, got: '${{ inputs.commit_sha }}'"
            exit 1
          fi
```

Backend rollback doesn't assume the target image is still in ECR — it checks first, and rebuilds from that historical commit if the tag has aged out of the registry's retention policy, then re-registers a new ECS task definition pointing at that image and forces a redeployment the same way `deploy-backend.yml` does. Frontend rollback is a straight re-run of the same build-and-sync steps as `deploy-frontend.yml`, just checked out at the older SHA instead of `main`'s head. Both rollback jobs sit behind the same `production` GitHub Environment gate as the forward-deploy workflows — a rollback rewrites live traffic exactly as much as a roll-forward does, so it gets the same approval treatment, not a "break glass" exception. Full strategy landscape (recreate/rolling/blue-green/canary) and how this rollback path relates to the ECS deployment circuit breaker: [`13-deployment-strategies-and-rollback.md`](./13-deployment-strategies-and-rollback.md). The CI/CD mechanics underneath all four workflows — OIDC trust setup, GitHub Environments, `pr-check.yml`'s Gitleaks/Trivy gates — are covered end to end in [`12-cicd-with-github-actions.md`](./12-cicd-with-github-actions.md), and the scanning tools specifically (`tfsec`, Trivy, ECR scanning, Gitleaks, Dependabot) in [`15-security-scanning-and-supply-chain.md`](./15-security-scanning-and-supply-chain.md).

---

## 5. Tech stack

| Concern | Choice | What it's for |
|---|---|---|
| Networking | VPC, 2 public + 2 private subnets across 2 AZs | Isolates ECS tasks in private subnets with no public IP; ALB and NAT live in public subnets |
| NAT Gateway | Single, shared across both AZs (`single_nat_gateway = true`) | Outbound internet (image pulls, Atlas, Google, Resend) for private-subnet tasks; a documented single-AZ availability tradeoff, cost vs. one-per-AZ |
| Load balancing | Application Load Balancer (ALB) | L7 routing, health checks, and TLS termination for the backend API |
| TLS/certificates | ACM module (self-signed local cert by default, real ACM+DNS validation for a custom domain) | HTTPS listener on the ALB |
| Compute | ECS Fargate | Runs the backend container with no EC2 instances to patch or manage |
| Container registry | ECR | Stores backend Docker images; gates deploys on its own vulnerability scan |
| Static hosting | S3 (private bucket) | Stores the built React SPA |
| CDN | CloudFront (Origin Access Control, SPA-routing Function) | Serves the SPA globally, cheaply, without exposing the S3 bucket publicly |
| Secrets/config | SSM Parameter Store | Mongo URI, JWT secrets, Google OAuth credentials, computed URLs — injected into the ECS task at container start |
| Encryption | KMS (customer-managed key) | Encrypts SecureString parameters; scoped narrowly to the ECS execution role's `kms:Decrypt` |
| Identity | IAM roles (ECS execution role, ECS task role, GitHub Actions OIDC role) | No long-lived AWS access keys anywhere in CI or in the running containers |
| Observability | CloudWatch (log groups, Container Insights, ECS/ALB alarms) | Structured `awslogs`-driver logs, CPU/memory/task-count and 5xx/unhealthy-host alerting |
| Alerting | SNS (single `alerts` topic) | Fan-out target for every CloudWatch alarm; one email subscriber |
| Cost guardrail | AWS Budgets | Forecasted-80%/actual-100% monthly threshold alerts |
| IaC | Terraform (`~> 1.7`, AWS provider `~> 5.0`) | Declares every resource above; S3+DynamoDB remote state, one `dev` environment |
| Containerization | Docker (multi-stage, `node:20-alpine`) | Packages the backend as the one artifact ECS actually runs |
| CI/CD | GitHub Actions, OIDC-federated | Builds, tests, scans, and deploys both halves independently; gates `apply`/production changes behind GitHub Environments |

---

## 6. Real code: the container and the module wiring

The backend ships as exactly one artifact, built by exactly one Dockerfile — a two-stage build that installs full dependencies to compile TypeScript, then reinstalls only production dependencies into a clean final image and drops root before the process starts:

```dockerfile
# backend/Dockerfile:1-30
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json ./

RUN npm ci
COPY . .

RUN npm run build

FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./

RUN npm  ci --omit=dev

COPY --from=builder --chown=node:node /app/dist ./dist

USER node

EXPOSE 8000

CMD ["node", "dist/index.js"]
```

Nothing from the `builder` stage survives into the final image except the compiled `dist/` output — no TypeScript source, no `devDependencies`, no build toolchain — and the final `COPY --from=builder --chown=node:node` line hands ownership of that output to the unprivileged `node` user before `USER node` drops root for the actual `CMD`. Full first-principles container treatment (layers, multi-stage vs. single-stage vs. distroless vs. buildpacks) is [`01-containerization-and-docker.md`](./01-containerization-and-docker.md).

And here's the actual module wiring for the first four modules in the dependency graph in §3 — this is the literal HCL that turns "nine separate module directories" into one environment:

```hcl
# infra/environments/dev/main.tf:158-267
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

# -----------------------------------------------------------------------------
# SECURITY MODULE
# -----------------------------------------------------------------------------
# Creates: Security Groups (ALB, ECS, Lambda, Database)

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

# -----------------------------------------------------------------------------
# IAM MODULE
# -----------------------------------------------------------------------------
# Creates: ECS Roles, Lambda Role, GitHub Actions Role (OIDC)

module "iam" {
  source = "../../modules/iam"

  project_name   = var.project_name
  environment    = var.environment
  aws_region     = var.aws_region
  aws_account_id = data.aws_caller_identity.current.account_id

  # KMS key the ECS execution role must be able to decrypt with. Prefer an
  # explicitly-supplied key, otherwise the CMK the parameter-store module
  # creates - this is what keeps the role's kms:Decrypt statement scoped to a
  # single key instead of "*".
  #
  # No dependency cycle here despite parameter_store also consuming an iam
  # output: Terraform's graph is per-resource, and the two edges touch
  # different resources (aws_iam_role.ecs_task_execution -> aws_kms_key ->
  # aws_iam_role_policy.ecs_task_execution_secrets).
  kms_key_arn = var.kms_key_arn != null ? var.kms_key_arn : module.parameter_store.kms_key_arn

  # Lambda VPC access
  lambda_vpc_access = var.lambda_vpc_access

  # GitHub Actions OIDC (for CI/CD)
  create_github_oidc = var.create_github_oidc
  github_org         = var.github_org
  github_repo        = var.github_repo

  common_tags = local.common_tags
}

# -----------------------------------------------------------------------------
# ECR MODULE
# -----------------------------------------------------------------------------
# Creates: Container registries for Docker images

module "ecr" {
  source = "../../modules/ecr"

  project_name = var.project_name
  environment  = var.environment

  # Repository Configuration
  create_lambda_repository = var.create_lambda_ecr

  # Lifecycle Policy
  image_retention_count         = var.image_retention_count
  dev_image_retention_count     = var.dev_image_retention_count
  untagged_image_retention_days = var.untagged_image_retention_days

  # Cross-account access (empty for single account)
  cross_account_ids = var.cross_account_ids

  common_tags = local.common_tags
}
```

Note that `security` explicitly consumes `module.networking.vpc_id`/`vpc_cidr` (a real, textual, top-to-bottom dependency — unlike the `iam`/`parameter_store` relationship in §3), while `ecr` at the bottom references nothing from any of the three modules above it despite sitting right after them in the file.

Remote state itself is equally real infrastructure, not a local convenience — every `terraform apply` from any machine or CI runner reads and writes the same S3-backed state, locked via DynamoDB so two concurrent applies can't corrupt it:

```hcl
# infra/environments/dev/backend.tf:8-29
terraform {
  backend "s3" {
    # S3 bucket for state storage (created in your setup)
    bucket = "prod-terraform-state-586794439017"

    # State file path within the bucket
    # Using environment/component structure for organization
    key = "dev/infrastructure/terraform.tfstate"

    # Region where the bucket exists
    region = "us-east-1"

    # DynamoDB table for state locking
    dynamodb_table = "terraform-locks"

    # Enable server-side encryption
    encrypt = true

    # KMS key for encryption (optional but recommended)
    # kms_key_id = "arn:aws:kms:us-east-1:586794439017:key/f72c4cc6-b22a-45d0-9c13-6ffb428cf30b"
  }
}
```

That bucket name — `prod-terraform-state-*` — is a naming artifact from before this project settled on `dev` as its only environment; it stores `dev`'s state exclusively today. Full remote-state, single-environment, and `terraform.tfvars`-secret-handling discussion: [`11-infrastructure-as-code-with-terraform.md`](./11-infrastructure-as-code-with-terraform.md).

---

## 7. Deep dives in this module

| # | File | Covers |
|---|---|---|
| 01 | [`01-containerization-and-docker.md`](./01-containerization-and-docker.md) | Container internals from first principles (namespaces, cgroups, union/overlay filesystems, image layers) before touching AstriX; multi-stage builds vs. single-stage vs. distroless vs. buildpacks — survey, then AstriX's real two-stage `backend/Dockerfile` (builder → production, non-root `node` user, `npm ci --omit=dev`) in full |
| 02 | [`02-networking-and-vpc-design.md`](./02-networking-and-vpc-design.md) | Flat vs. multi-tier (public/private subnet) VPC design; single-NAT vs. per-AZ NAT cost/availability tradeoff — survey, then AstriX's 2-AZ public/private VPC, IGW, NAT Gateway topology, route tables, optional VPC Flow Logs |
| 03 | [`03-security-groups-and-network-segmentation.md`](./03-security-groups-and-network-segmentation.md) | Security groups (stateful, reference-based) vs. NACLs (stateless, subnet-level) vs. host-based firewalls vs. cloud WAF — survey, then AstriX's ALB→ECS security-group chain, database/Lambda/VPC-endpoint SGs |
| 04 | [`04-identity-and-access-management.md`](./04-identity-and-access-management.md) | Long-lived IAM user access keys vs. instance/task roles vs. OIDC federation — survey, then AstriX's ECS execution/task role split, least-privilege KMS/ECR/ECS scoping, GitHub Actions OIDC provider + role trust policy |
| 05 | [`05-container-registry-and-image-lifecycle.md`](./05-container-registry-and-image-lifecycle.md) | Docker Hub vs. cloud-native registries (ECR/GCR/ACR) vs. self-hosted (Harbor) — survey, then AstriX's ECR repo, lifecycle/retention policy, cross-account access, and how ECR image scanning gates `deploy-backend.yml` |
| 06 | [`06-compute-and-container-orchestration-ecs-fargate.md`](./06-compute-and-container-orchestration-ecs-fargate.md) | Raw EC2 vs. ECS-on-EC2 vs. ECS Fargate vs. Kubernetes/EKS vs. Lambda — survey (naming Kubernetes honestly as the industry-standard alternative, without AstriX using it), then AstriX's Fargate cluster, task definition, service, deployment circuit breaker, target-tracking autoscaling |
| 07 | [`07-load-balancing-and-traffic-routing.md`](./07-load-balancing-and-traffic-routing.md) | ALB (L7) vs. NLB (L4) vs. API Gateway vs. self-managed Nginx/HAProxy — survey, then AstriX's ALB target group, health checks, HTTP→HTTPS redirect listener, why the HTTPS listener is created outside the ALB module to avoid a Terraform dependency cycle |
| 08 | [`08-tls-and-certificate-management.md`](./08-tls-and-certificate-management.md) | Manually-purchased certs vs. ACM vs. Let's Encrypt/cert-manager vs. mTLS — survey, then AstriX's ACM module (self-signed local cert generation as a domain-less placeholder, optional custom-domain path), the `.pem`-must-never-be-committed operational rule |
| 09 | [`09-secrets-and-configuration-management.md`](./09-secrets-and-configuration-management.md) | Plain `.env` files vs. cloud secret stores (SSM Parameter Store vs. Secrets Manager) vs. HashiCorp Vault — survey, then AstriX's Parameter Store + customer-managed KMS key, how ECS injects secrets at container start, the manual secret-rotation runbook |
| 10 | [`10-cdn-and-static-asset-delivery.md`](./10-cdn-and-static-asset-delivery.md) | Traditional server-rendered hosting vs. S3+CDN static hosting vs. platform-as-a-service (Vercel/Netlify) — survey, then AstriX's S3+CloudFront SPA hosting, cache invalidation on deploy, and the deliberate decision to hit the ALB directly for `/api/*` instead of proxying dynamic, cookie-authenticated responses through CloudFront |
| 11 | [`11-infrastructure-as-code-with-terraform.md`](./11-infrastructure-as-code-with-terraform.md) | ClickOps vs. Terraform vs. Pulumi vs. AWS CDK vs. CloudFormation — survey, then AstriX's S3+DynamoDB remote-state backend, module-per-service layout, single-environment (`dev`) structure and why "prod" doesn't structurally exist yet, `terraform.tfvars` secret handling |
| 12 | [`12-cicd-with-github-actions.md`](./12-cicd-with-github-actions.md) | Push-based CI/CD (GitHub Actions/GitLab CI/CircleCI) vs. pull-based GitOps (Argo CD/Flux) — survey, then AstriX's OIDC-authenticated workflows, GitHub Environments as manual-approval gates, the full `deploy-backend.yml`/`deploy-frontend.yml`/`infra.yml`/`pr-check.yml` pipelines |
| 13 | [`13-deployment-strategies-and-rollback.md`](./13-deployment-strategies-and-rollback.md) | Recreate vs. rolling vs. blue-green vs. canary deployment strategies — survey, then AstriX's ECS rolling deployment with deployment circuit breaker + auto-rollback, and the manual `rollback.yml` workflow (commit-SHA-pinned task-definition re-registration) |
| 14 | [`14-observability-monitoring-and-alerting.md`](./14-observability-monitoring-and-alerting.md) | Cloud-native monitoring (CloudWatch) vs. self-hosted (Prometheus+Grafana) vs. SaaS APM (Datadog/New Relic) vs. log aggregation (ELK/OpenSearch) — survey, then AstriX's CloudWatch log groups (awslogs driver), Container Insights, CloudWatch alarms (ECS CPU/memory/task-count, ALB 5xx/unhealthy-host), single SNS alert topic, AWS Budgets cost guardrail |
| 15 | [`15-security-scanning-and-supply-chain.md`](./15-security-scanning-and-supply-chain.md) | The shift-left tooling landscape: SAST vs. dependency scanning vs. secret scanning vs. IaC scanning vs. container image scanning — survey, then AstriX's actual stack: `tfsec` (Terraform), `gitleaks` (secrets), Trivy + native ECR scanning (container images), Dependabot (dependency/Terraform-provider/GitHub-Actions updates) |
