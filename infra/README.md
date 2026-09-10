# AstriX Infra

Terraform-managed AWS infrastructure for AstriX. See [`PLAN.md`](./PLAN.md) for the full hardening audit, findings, and rationale — this file is the "how do I actually work with this" reference; `PLAN.md` is the "what's wrong and why" reference.

## Architecture

```
Browser
  ├── https://<cloudfront-domain>   → CloudFront → S3 (React SPA, static)
  └── https://<alb-dns-name>/api/*  → ALB → ECS Fargate (backend API, dynamic)
```

The API is **not** proxied through CloudFront — it's hit directly on the ALB. This is deliberate (see `infra/scripts/update-urls.sh`'s header comment): CloudFront caching dynamic, cookie-authenticated API responses risks leaking one user's response to another.

```
                          VPC (10.0.0.0/16)
  ┌──────────────────────────────────────────────────────────────┐
  │  Public subnets (2 AZs)          Private subnets (2 AZs)      │
  │  ┌────────────────┐              ┌─────────────────────────┐ │
  │  │ ALB             │──────────────▶ ECS Fargate tasks       │ │
  │  │ NAT Gateway      │              │ (backend, port 3000)    │ │
  │  └────────────────┘              └───────────┬─────────────┘ │
  └────────────────────────────────────────────────┼──────────────┘
                                                     │
                                          MongoDB Atlas (external)
```

## Module dependency graph

```
networking ──▶ security ──▶ iam ──▶ ecr
     │                                │
     ▼                                ▼
    alb ◀────────────────────── acm (cert for ALB HTTPS listener)
     │
     ▼
parameter-store (SSM secrets, fed by computed ALB/CloudFront URLs)
     │
     ▼
    ecs (task definition + service, reads secrets from parameter-store)
     │
     ▼
cloudfront_s3 (frontend, proxies /api/* to the ALB)
```

Each module lives under `infra/modules/<name>/`. `infra/environments/dev/main.tf` is the only place that wires them together for a given environment — there is currently only one environment (`dev`); see `PLAN.md` §3.4 for why "prod" doesn't structurally exist yet and what that decision implies.

## Running Terraform locally

```bash
cd infra/environments/dev
terraform init
terraform plan    # ALWAYS read the plan before applying, even in dev
terraform apply
```

Requires:
- An AWS CLI profile matching `aws_profile` in `terraform.tfvars` (currently named `prod-terraform` — see `PLAN.md` §3.4 on why that name is misleading; it manages `dev`, not a separate prod account).
- `terraform.tfvars` populated with real secrets (Mongo URI, JWT secrets, Google OAuth credentials). This file is gitignored and must never be committed — copy from a teammate or regenerate values yourself; there's no `.tfvars.example` yet (worth adding one with placeholder values if this repo ever gets a second contributor).

CI (`.github/workflows/infra.yml`) runs `terraform fmt -check`, `terraform validate`, and `tfsec` on every PR touching `infra/**`, and posts a `terraform plan` as a PR comment. Applying is manual-only, via `workflow_dispatch` on that same workflow, gated behind the `infra-apply` GitHub Environment — **add required reviewers to that environment in repo settings** if you want an actual approval gate; without that configuration it's a no-op.

## `infra/scripts/*.sh`

These are one-off/manual operational scripts, not part of the Terraform apply path (see `PLAN.md` §3.2 for why `bootstrap.tf`'s old in-Terraform `local-exec` equivalents were removed — they broke the moment `terraform apply` ran anywhere but a specific laptop with Docker and a specific AWS profile).

| Script | When to run it |
|---|---|
| `initial-setup.sh` | Once, when standing up a brand-new environment from scratch: applies Terraform, updates Parameter Store with real computed URLs, forces an ECS redeploy. |
| `push-backend-image.sh [tag]` | Manually build and push a backend image to ECR outside of CI (e.g. testing a change before opening a PR). Normal deploys go through `.github/workflows/deploy-backend.yml`, not this. |
| `deploy-frontend.sh` | Manually build and sync the frontend to S3 + invalidate CloudFront, outside of CI. Normal deploys go through `.github/workflows/deploy-frontend.yml`. |
| `update-urls.sh` | Re-push the computed frontend/API/callback URLs to Parameter Store after ALB DNS or CloudFront domain changes, then force an ECS redeploy to pick them up. |
| `setup-https.sh` | One-time HTTPS bring-up helper (generates/wires the ALB cert path). Re-run only if redoing the HTTPS setup from scratch. |

All of them default to the `prod-terraform` AWS profile — pass `-p <profile>` if yours differs.

## Secrets

Application secrets live in SSM Parameter Store under `/astrix/dev/*`, written by the `parameter-store` module from `terraform.tfvars` values, and read by the ECS task execution role at container start (see `modules/ecs/main.tf`'s `secrets` block). `terraform.tfvars` itself is local-only and gitignored — it is the source of truth for what gets written to Parameter Store, not a secrets store in its own right. Rotation: update the value in Atlas/Google Console/etc. first, then update `terraform.tfvars`, then `terraform apply`, then confirm the new deploy picked it up, then revoke the old value — never revoke before the new one is live (see `PLAN.md` "How to execute this plan without regressions", item 4).

## Certificates

`infra/certificates/*.pem` are generated locally by the `acm` module's `local_file` resources (self-signed cert/key for the ALB's HTTPS listener when no real domain exists yet). **These must never be committed** — see `PLAN.md` §1.1 for the incident where one was. They're gitignored now; if you ever see `git status` showing them as trackable again, stop and fix `.gitignore` before committing anything.

## Alerting

CloudWatch alarms (ECS CPU/memory/task-count in `modules/ecs`, ALB 5xx/unhealthy-host in `modules/alb`) publish to a single SNS topic (`aws_sns_topic.alerts` in `environments/dev/main.tf`), subscribed via the `alert_email` tfvar. **AWS sends a confirmation email to that address after the first `terraform apply` that creates the subscription — you must click it, or the subscription stays pending and nothing actually gets delivered.** See `PLAN.md` §5 for the full observability stack decision (CloudWatch as the backbone, Grafana Cloud's free tier as an optional dashboard layer on top, X-Ray/self-hosted Prometheus deliberately deferred).

## Disaster recovery (sketch — see `PLAN.md` §7.3 for the fuller list)

- **Terraform state**: S3 bucket `prod-terraform-state-586794439017` + DynamoDB table `terraform-locks` (see `environments/dev/backend.tf`). Confirm bucket versioning is on: `aws s3api get-bucket-versioning --bucket prod-terraform-state-586794439017`.
- **MongoDB Atlas**: backup/restore is managed in the Atlas console, outside this repo — confirm it's actually enabled there.
- **Everything else in AWS** (ECS, ALB, S3, CloudFront) is fully defined in this Terraform and reproducible via `terraform apply` from a clean account, given the state above and valid secrets in `terraform.tfvars`.
