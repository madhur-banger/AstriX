# AstriX — DevOps Deep Dive: AWS, Terraform, GitHub Actions (A Learning-Ordered Guide)

This is a second, deeper pass through every file in `infra/**` and `.github/workflows/**` — not just what each module does, but what's actually wired together, what's provisioned but unused, and a couple of things the first pass got wrong or oversimplified. Corrections from the earlier version are called out explicitly rather than silently fixed, because the reasoning behind a correction is itself worth learning from.

---

## 1. The Real, Verified Architecture

```
                    Browser
                       │
         ┌─────────────┴─────────────┐
         ▼                            ▼
  CloudFront + S3                    ALB (public subnet, ports 80/443)
  (static frontend)                   │
                                       ▼
                              ECS Fargate task (private subnet)
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
           SSM Parameter Store   MongoDB Atlas      (S3/SQS/SNS/DynamoDB —
           (KMS-encrypted)        (external)         provisioned in IAM,
                                                       not yet used by any
                                                       actual AWS resource)
```

The API is reached **directly** through the ALB, not through CloudFront — this is explicit, stated three times over in the code itself (`bootstrap.tf`'s file header comment, its `computed_urls` output's `note` field, and the `update_urls` script's own echo statements): *"API calls go directly to ALB, NOT through CloudFront. This is correct for proper cookie/auth handling."* The reasoning: a CDN in front of a cookie-based refresh-token flow introduces cache-key and `Set-Cookie`-forwarding subtleties that are easy to get wrong, so this design sidesteps the whole class of bug by keeping the API off CloudFront entirely.

**Correction to the first pass**: that's the *intended and currently exercised* architecture — but it isn't the *only* thing actually built. Keep reading §6.

---

## 2. Terraform Module Graph, and What Each One Actually Contains

```
infra/modules/
├── networking/    VPC (10.0.0.0/16), 2 public + 2 private subnets across 2 AZs,
│                   IGW, single NAT Gateway (cost-optimized), optional VPC Flow Logs
├── security/      5 security groups (ALB, ECS, Lambda, database, VPC-endpoints —
│                   the last 3 are feature-flagged off by default, built for future use)
├── iam/           4 roles: ECS execution, ECS task, Lambda execution, GitHub Actions
│                   (+ the GitHub OIDC provider itself)
├── ecr/           Backend repo (+ optional Lambda repo), scan-on-push, lifecycle rules
├── alb/           ALB + target group + HTTP listener (HTTPS listener exists in the
│                   file but is COMMENTED OUT — see §5)
├── acm/           Self-signed cert for dev (imported into ACM), real DNS-validated
│                   ACM cert for a custom domain in prod — genuinely well-designed
├── parameter-store/  KMS-encrypted SSM parameters for every backend secret
├── ecs/           Cluster, task definition, service, autoscaling, CloudWatch alarms
│                   (alarms exist but have no notification target — see §8)
└── cloudfront_s3/  S3 + CloudFront with OAC, security headers, AND a fully-built
                     /api/* → ALB proxy behavior that the app doesn't actually use
                     (see §6 — this is the most interesting finding in this pass)
```

Dependency order, straight from `main.tf`'s own diagram:
```
networking → security → iam → ecr
                                 ↘
                          alb → acm → parameter_store → ecs
                                                            ↘
                                                     cloudfront_s3
```
Only `infra/environments/dev/` exists — no `staging/` or `prod/` (§13).

---

## 3. Networking, in Real Detail

```hcl
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr          # 10.0.0.0/16 — 65,536 addresses
  enable_dns_hostnames = true                   # required for ECS service discovery
  enable_dns_support   = true
}
```
Two AZs, two tiers each: public (`10.0.1.0/24`, `10.0.2.0/24` — ALB lives here) and private (`10.0.10.0/24`, `10.0.20.0/24` — ECS tasks live here, never directly internet-reachable). One thing worth understanding, not just memorizing: **only one NAT Gateway exists, in AZ-A's public subnet, shared by both private subnets.** This is a real, explicit, cost-motivated trade-off — a second NAT Gateway costs another ~$32/month, and the module's own comments say so directly:
```hcl
# COST NOTE: NAT Gateway costs ~$32/month + data transfer
# For dev environments, consider: using a single NAT (not multi-AZ) — what we do here
```
The consequence worth internalizing: **if AZ-A goes down entirely, private-subnet resources in AZ-B lose outbound internet access** (they can't reach ECR, MongoDB Atlas, or any external API) even though the ECS tasks *themselves* in AZ-B would still be running. This is an accepted single-AZ dependency for cost reasons in dev — exactly the kind of trade-off that needs revisiting (one NAT per AZ) before a `prod` environment exists.

**A genuinely good, under-used feature already built here**: VPC Flow Logs, gated behind `var.enable_flow_logs` (off by default), with its own CloudWatch Log Group and dedicated IAM role. This exists specifically for network-level debugging and security analysis — "why can't this ECS task reach MongoDB Atlas" is a question Flow Logs answers directly, and it's a one-variable flip to turn on, not something that needs building from scratch.

---

## 4. Security Groups — the Actual Enforced Boundary

```
Internet
   │  80, 443 from 0.0.0.0/0
   ▼
ALB Security Group  ──── outbound: all (0.0.0.0/0)
   │  app_port (3000) — ONLY from the ALB's own security group ID, not a CIDR
   ▼
ECS Tasks Security Group  ──── outbound: all (needed for ECR pulls, MongoDB Atlas, external APIs)
```
The important line, worth reading exactly as written, because the *mechanism* matters more than the port number:
```hcl
ingress {
  from_port       = var.app_port
  to_port         = var.app_port
  protocol        = "tcp"
  security_groups = [aws_security_group.alb.id]   # NOT a cidr_blocks list
}
```
Referencing another security group **by ID** rather than by CIDR range means this rule doesn't care what subnet the ALB happens to be in, or if its IP changes — it will always match traffic that genuinely originated from something wearing the ALB's security group, which is a strictly stronger guarantee than "traffic from this IP range." This is the correct AWS-native way to express "only my load balancer may reach my containers," and it's what actually makes the private subnet's lack of a public IP meaningful — without this rule, a public IP wouldn't even be the only thing standing between the internet and your containers.

Three more security groups exist — **Lambda, database, and VPC-endpoints** — all behind `count = var.create_*_sg ? 1 : 0` flags, all off by default. These aren't dead code to ignore; they're deliberately pre-built for features described in the Roadmap document (a Lambda-based async job processor, a future RDS/DocumentDB migration) so that adding those features later doesn't require writing new security-group Terraform from scratch — just flipping a variable.

---

## 5. Correction #1 — the HTTPS listener is commented out

The first pass's architecture diagram showed "ALB (public, 80→443 redirect)" as if this were active. Reading `infra/modules/alb/main.tf` directly:
```hcl
resource "aws_lb_listener" "http" {
  port     = "80"
  protocol = "HTTP"
  default_action { type = "forward", target_group_arn = aws_lb_target_group.backend.arn }
}

# resource "aws_lb_listener" "https" {          ← ENTIRELY COMMENTED OUT
#   port            = "443"
#   protocol        = "HTTPS"
#   certificate_arn = var.certificate_arn
#   ...
# }
# resource "aws_lb_listener" "http_redirect" {   ← ALSO COMMENTED OUT
#   ...redirect { port = "443", protocol = "HTTPS" }
# }
```
**This means the ALB currently only serves plain HTTP on port 80.** No 443 listener exists, and no HTTP→HTTPS redirect exists — despite the ACM module generating and importing a self-signed certificate specifically so an HTTPS listener could use it. The certificate is provisioned; the thing that would present it to a client is not.

**This meaningfully changes how to think about the leaked private key** (the Security Concerns document's S1 finding, `infra/certificates/alb-private-key.pem`): because there's currently no live TLS listener presenting that certificate, the immediate exploitability of the leaked key today is lower than "an attacker can MITM live encrypted traffic right now" — there is no encrypted traffic to that ALB right now to intercept. It does **not** make the leak acceptable: the moment someone uncomments those two resource blocks (a completely reasonable next step — the cert exists specifically to enable this), the compromised key would immediately become live-exploitable with zero warning, since nothing about re-enabling the listener would prompt anyone to first rotate a key that's already sitting in git history. Fix order: rotate/regenerate the cert **before** ever uncommenting the HTTPS listener, not after.

---

## 6. Correction #2 — CloudFront actually has a fully-built, currently-unused `/api/*` proxy to the ALB

This is the most interesting thing found in this pass, and it's genuinely subtle. `infra/modules/cloudfront_s3/main.tf` contains all of this, fully wired and deployed:
```hcl
# A second CloudFront origin, pointed at the ALB — created whenever alb_dns_name is provided
dynamic "origin" {
  for_each = var.alb_dns_name != null ? [1] : []
  content {
    domain_name = var.alb_dns_name
    origin_id   = "ALB-Backend"
    custom_origin_config { http_port = 80, https_port = 443, origin_protocol_policy = var.alb_protocol_policy, ... }
  }
}

# A cache behavior that routes /api/* to that ALB origin, with a dedicated no-cache policy
dynamic "ordered_cache_behavior" {
  for_each = var.alb_dns_name != null ? [1] : []
  content {
    path_pattern             = "/api/*"
    target_origin_id         = "ALB-Backend"
    cache_policy_id          = aws_cloudfront_cache_policy.api_cache_policy.id       # default_ttl = 0, forwards cookies/Authorization
    origin_request_policy_id = aws_cloudfront_origin_request_policy.api_origin_policy.id
  }
}
```
And in `infra/environments/dev/main.tf`, this **is** actually wired up:
```hcl
module "cloudfront_s3" {
  alb_dns_name = module.alb.alb_dns_name   # ← not null, so the /api/* behavior above IS created
}
```
So the deployed CloudFront distribution genuinely has a working `/api/*` path that would proxy to the ALB, with cookies, `Authorization`, and query strings all correctly forwarded — someone clearly built this to eventually unify the frontend and API behind one edge, matching the more conventional single-origin SPA architecture.

**But it's not what the app actually uses.** In the same `main.tf`, the URL the frontend is actually configured to call bypasses this entirely:
```hcl
locals {
  alb_base_url = var.enable_https ? "https://${module.alb.alb_dns_name}" : "http://${module.alb.alb_dns_name}"
  api_base_url = "${local.alb_base_url}/api"      # ← goes STRAIGHT to the ALB, not through CloudFront's /api/* path
}
```
And `bootstrap.tf` computes `VITE_API_BASE_URL` from this same direct-ALB `api_base_url`, not from the CloudFront domain. So: **the CloudFront `/api/*` proxy path is live and reachable, but nothing in the actual application configuration ever sends traffic through it.** It's real, deployed, costing nothing extra to keep (CloudFront behaviors don't have their own charge beyond usage), but it's dead capability — a second way into the backend that exists purely because it was built for a future unified-edge design that was never finished being adopted.

**Why this matters beyond trivia**: an unused-but-live ingress path is still an attack surface. Anyone who discovers the CloudFront distribution's domain can hit `https://<cloudfront-domain>/api/*` and it will genuinely reach your backend — with a *different* cache/header-forwarding configuration than the direct-ALB path, and without whatever WAF rules you might eventually attach only to the ALB directly. **Fix**: either finish adopting this path (route the app through it and retire the direct-ALB URL, capturing the benefit CloudFront + WAF would provide for API traffic too) or remove the `/api/*` behavior and the ALB origin from the CloudFront module entirely so there's exactly one documented way to reach the backend, matching what the architecture diagram claims.

---

## 7. IAM — Correction #3: the GitHub Actions role is broader than the first pass claimed

The earlier document said ECS permissions were "scoped to the `astrix-dev-*` cluster." Reading the actual policy in `infra/modules/iam/main.tf` line by line:
```hcl
{
  Sid    = "ECSDeploy"
  Action = ["ecs:UpdateService", "ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition",
            "ecs:DeregisterTaskDefinition", "ecs:DescribeClusters", "ecs:ListTasks", "ecs:DescribeTasks"]
  Resource = "*"          # ← NOT scoped to astrix-dev-*, this is every ECS resource in the account
},
{
  Sid    = "ECSWait"
  Action = ["ecs:DescribeServices"]
  Resource = ["arn:aws:ecs:...:service/astrix-dev-cluster/*"]   # ← this one IS correctly scoped
}
```
Only `DescribeServices` (used for the "wait for stability" step) is actually resource-scoped to this project's cluster — `UpdateService`, `RegisterTaskDefinition`, `DeregisterTaskDefinition`, and `DescribeClusters` all carry `Resource: "*"`. The same pattern repeats for CloudFront (`ListDistributions`/`CreateInvalidation`/`GetInvalidation` are all `Resource: "*"` — `CreateInvalidation` *can* be scoped to a specific distribution ARN in IAM, but isn't here).

**Practical impact**: this GitHub Actions role — reachable by anyone who can push a workflow run in this repository (or exploit a supply-chain vulnerability in an Action it uses) — can register, deregister, or force-redeploy **any ECS service in the entire AWS account**, not just this project's, and can invalidate the CloudFront cache of **any distribution in the account**. For a solo account with only this one project in it, the practical blast radius is the same either way — but the *policy itself* doesn't express that constraint, so the moment a second project shares this AWS account, this role becomes a lateral-movement path between them. Worth tightening to `Resource: "arn:aws:ecs:*:*:task-definition/astrix-dev-*"` / `cluster/astrix-dev-*` and the specific CloudFront distribution ARN, respectively, before that happens — not urgent today, genuinely important the day a second project shows up in the same account.

**A second, more sensitive disclosure found in this pass**: `infra/scripts/backend-bucket-policy.json` and `infra/scripts/terraform-kms-policy.json` (committed to the repo, not gitignored) contain **real AWS SSO permission-set role ARNs** — e.g. `arn:aws:iam::586794439017:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_TerraformProvisioner_340e75aafc4301ac`. This is a step beyond the already-flagged bare account ID: it reveals the *exact* IAM Identity Center role names and permission-set instance IDs used to administer this account. Not directly exploitable on its own (these are bucket/KMS resource policies restricting access *to* those roles, not credentials), but it's meaningful reconnaissance information for anyone probing this account, and it's the kind of detail that should live in a `.gitignore`d local config or a Terraform variable, not a committed JSON file.

---

## 8. ECS — What's Actually More Sophisticated Than the First Pass Gave Credit For

Two things the earlier pass got wrong by being too quick:

**"No healthcheck" was incomplete.** The Dockerfile itself has no `HEALTHCHECK` directive (still true, still worth fixing — Security Concerns document A12/S12) — but the **ECS task definition** has its own, independent container-level health check that has nothing to do with the Dockerfile:
```hcl
healthCheck = {
  command     = ["CMD-SHELL", "curl -f http://localhost:${var.container_port}${var.health_check_path} || exit 1"]
  interval = 30, timeout = 5, retries = 3, startPeriod = 60
}
```
This runs *inside* the running container, independently of (and in addition to) the ALB target group's own HTTP health check against `/health`. Two separate health-check mechanisms already exist; only the Docker-image-level one (which matters for anyone running the container outside ECS, e.g. locally) is genuinely missing.

**"No alerting exists" was too absolute.** Three CloudWatch alarms exist, gated behind `var.enable_alarms`: high CPU, high memory, and — genuinely the most useful one — **zero running tasks**:
```hcl
resource "aws_cloudwatch_metric_alarm" "no_running_tasks" {
  metric_name = "RunningTaskCount"
  comparison_operator = "LessThanThreshold"
  threshold = 1
  treat_missing_data = "breaching"   # if the metric itself goes missing, treat that as an outage too
}
```
The `treat_missing_data = "breaching"` choice here is a genuinely good detail — it means if CloudWatch stops receiving the metric at all (which can happen during a severe outage, ironically exactly when you need the alarm most), the alarm fires anyway rather than silently going quiet. **What's actually missing**: none of these three alarms have an `alarm_actions` block — there's no SNS topic, no PagerDuty/email/Slack integration wired to any of them. They'll flip to `ALARM` state and sit there, visible only to someone who happens to check the CloudWatch console. The infrastructure to notice a problem exists; the infrastructure to *tell a human about it* doesn't yet.

Also worth knowing: **deployment circuit breaker with automatic rollback is already enabled**:
```hcl
deployment_circuit_breaker { enable = true, rollback = true }
```
If a new deployment's tasks keep failing to reach a healthy state, ECS itself detects this and automatically rolls the service back to the last known-good task definition — without anyone needing to trigger `rollback.yml` manually. This is a real safety net already in place, on top of (not instead of) the manual rollback workflow.

---

## 9. ECR — a Lifecycle Policy That Doesn't Actually Match How Images Are Tagged

```hcl
rule { rulePriority = 1, description = "Keep last N tagged images"
       selection = { tagStatus = "tagged", tagPrefixList = ["v", "release"], ... } }
rule { rulePriority = 2, description = "Delete untagged images older than N days"
       selection = { tagStatus = "untagged", ... } }
rule { rulePriority = 3, description = "Keep only N dev/feature images"
       selection = { tagStatus = "tagged", tagPrefixList = ["dev", "feature", "pr"], ... } }
```
Cross-reference this against how images are actually tagged, per `deploy-backend.yml`:
```yaml
docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG -t $ECR_REGISTRY/$ECR_REPOSITORY:latest .
# IMAGE_TAG = ${{ github.sha }}   — a raw commit SHA, no "v", "release", "dev", "feature", or "pr" prefix
```
**None of the three lifecycle rules match a raw commit-SHA tag.** Rule 1 only expires images tagged `v*`/`release*`; rule 3 only expires `dev*`/`feature*`/`pr*`; rule 2 only touches *untagged* images. Every SHA-tagged image this pipeline has ever pushed is tagged and therefore invisible to all three rules — **ECR will accumulate a SHA-tagged image from every single deploy, forever, with nothing cleaning them up.** This is a genuine, verified cost-and-clutter bug: harmless at 20 deploys, a real line item at 2,000. Fix: add a fourth rule matching untagged-prefix (any tag not matching the others) or simplify to a single "keep last N images regardless of tag" rule using `tagStatus = "any"` — which the Lambda repository's lifecycle policy two resources below it in the same file already does correctly, making this an inconsistency within the same module, not just a design gap.

---

## 10. The Five CI/CD Workflows, Traced End to End

### 10.1 `pr-check.yml` — the only workflow with zero AWS access
Two parallel jobs (`check-backend`, `check-frontend`), neither requests `id-token: write`, neither can touch AWS. This is a build/type-check gate only — `npm ci && npm run build`, with a placeholder `VITE_API_BASE_URL` so the frontend build doesn't fail on a missing env var. **No test step exists** because no tests exist yet (Security Concerns document, Milestone 0 of the Roadmap).

### 10.2 `deploy-backend.yml` — Correction #4: it never registers a new task definition
```yaml
- run: |
    docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG -t $ECR_REGISTRY/$ECR_REPOSITORY:latest .
    docker push ...:$IMAGE_TAG
    docker push ...:latest
- run: aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE --force-new-deployment
```
`force-new-deployment` tells ECS "start new tasks from the *current* task definition" — it does **not** change which image tag that task definition points at. This workflow's correctness depends entirely on two facts holding true simultaneously: the ECS task definition's `image` field is pinned to `:latest` (confirmed: `variable "ecs_image_tag" { default = "latest" }` in `environments/dev/variables.tf`), and the ECR repository is `MUTABLE` so that re-pushing `:latest` is allowed to overwrite the previous image (confirmed: `image_tag_mutability = var.environment == "prod" ? "IMMUTABLE" : "MUTABLE"` — dev is mutable).

**This is a real, verified fragility, not a style nitpick**: the moment anyone follows the Roadmap document's advice to add a `prod` environment by copying `dev` and setting `environment = "prod"`, the ECR repository for that environment automatically becomes `IMMUTABLE` (per that same ternary) — and re-pushing an already-existing `:latest` tag to an immutable ECR repository **fails outright**. This exact workflow file, reused unmodified against a prod environment, would break on the very first deploy. The fix is the same shape `rollback.yml` *already* correctly implements two files away: fetch the current task definition, patch just the `image` field to the new SHA tag with `jq`, register a genuinely new revision, then update the service to point at that revision. Applying that pattern to `deploy-backend.yml` fixes both the immutable-ECR fragility and the secondary issue that normal deploys currently leave no task-definition-revision audit trail (only rollbacks create new revisions today).

### 10.3 `deploy-frontend.yml` — dynamic discovery instead of hardcoded IDs
Two genuinely nice details: it **looks up** the CloudFront distribution ID by matching the S3 bucket name in the distribution's origins (`aws cloudfront list-distributions --query "...Origins.Items[?contains(DomainName,'$S3_BUCKET')]..."`) rather than hardcoding a distribution ID that would go stale if the distribution were ever recreated; and it reads `VITE_API_BASE_URL` from SSM **at build time**, so the compiled frontend bundle always reflects whatever the infra layer currently says the API URL is, with zero risk of the two drifting apart from separately-maintained config.

### 10.4 `rollback.yml` — the one workflow that does task-definition versioning correctly
```bash
TASK_DEF=$(aws ecs describe-task-definition --task-definition astrix-dev-backend --query 'taskDefinition')
NEW_TASK_DEF=$(echo $TASK_DEF | jq --arg IMAGE "...:$COMMIT_SHA" \
  '.containerDefinitions[0].image = $IMAGE | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)')
aws ecs register-task-definition --cli-input-json "$NEW_TASK_DEF"
```
Fetch the live task definition as JSON, strip the fields ECS auto-generates (you can't re-submit a `revision` number or `taskDefinitionArn` — ECS assigns those), patch just the `image` field, register the result as a brand-new revision, then point the service at it. This is the correct AWS-native rollback pattern, and it's genuinely better craftsmanship than `deploy-backend.yml`'s own approach — worth using as the template when fixing §10.2.

### 10.5 `infra.yml` — plan-then-apply-the-exact-plan-file
```yaml
- run: terraform plan -out=tfplan
- uses: actions/upload-artifact@v4   # tfplan binary uploaded, reviewable before apply
- if: inputs.action == 'apply'
  run: terraform apply -auto-approve tfplan   # applies the EXACT plan, not a fresh one
```
Applying the saved `tfplan` file (not re-running `plan` implicitly inside `apply`) closes a real TOCTOU gap — without this, infrastructure could drift between the moment a human reviewed the plan output and the moment `apply` actually runs. **What's still missing**: there's no separation between "who can trigger plan" and "who can trigger apply" beyond the dropdown itself — anyone with workflow-dispatch access can select `apply` directly with no second approver, no GitHub Environment protection rule requiring a review. For a solo project this is inherent (you're the only reviewer either way), but it's the first governance gap to close the moment a second person gets push access to this repo.

---

## 11. The Bootstrap Layer — Solving Terraform's Chicken-and-Egg Problem, at a Real Cost

`bootstrap.tf` exists because of a genuine ordering problem: the backend needs to know its own public URLs (for CORS, OAuth callbacks, cookie domain) *before* it can be configured — but those URLs (the ALB's DNS name, CloudFront's domain) don't exist until *after* Terraform creates the ALB and CloudFront distribution. Three `null_resource`s solve this with `local-exec` provisioners, in dependency order:
```
module.ecr created
   → null_resource.initial_docker_push (builds + pushes the very first image, one-time)
module.alb + module.cloudfront_s3 created
   → null_resource.update_urls (writes real URLs into Parameter Store via `aws ssm put-parameter`)
   → null_resource.force_ecs_redeploy (forces ECS to restart tasks so they pick up the new env vars)
```
This is a legitimately clever solution to a real problem — but every one of these three resources runs **on whatever machine executes `terraform apply`**, requiring Docker and the AWS CLI installed locally (or, when run via `infra.yml`, on the GitHub Actions runner — which does have Docker, so this actually works fine in CI too, worth noting as a partial mitigation of the "requires a human's machine" concern). The `initial_docker_push` resource additionally builds from `../../../backend` relative to the Terraform working directory — a path that is correct today but would silently break if the repository were ever reorganized, with no compiler or linter that would catch it; it would simply fail at `terraform apply` time with a "no such directory" error from inside a `local-exec` block, which is a notably worse debugging experience than a normal Terraform plan error.

---

## 12. Trace One Full Deploy, Start to Finish

The best way to actually understand how all of the above connects is to trace a single `git push` to `main` touching `backend/src/controllers/task.controller.ts`:

```
git push origin main
        │
        ▼
GitHub detects the change matches deploy-backend.yml's path filter (backend/**)
        │
        ▼
GitHub issues a short-lived OIDC token to the workflow run
        │
        ▼
aws-actions/configure-aws-credentials exchanges it for temporary AWS credentials,
  scoped to astrix-dev-github-actions-role (no long-lived secret involved, §14)
        │
        ▼
docker build (Dockerfile — currently single-stage, root user, see Security Concerns S12)
        │
        ▼
docker push :$GITHUB_SHA  AND  :latest   → both land in ECR (MUTABLE repo, dev)
        │
        ▼
aws ecs update-service --force-new-deployment
        │
        ▼
ECS starts new tasks from the EXISTING task definition (still says image: ...:latest)
  → pulls the freshly-overwritten :latest layer → this is why it works (§10.2)
        │
        ▼
New tasks register with the ALB target group; ALB health-checks GET /health
  AND the ECS-level container healthCheck (curl localhost:PORT/health) both watch it
        │
        ▼
deployment_circuit_breaker watches for repeated failures → auto-rollback if the
  new tasks never go healthy (§8) — a safety net independent of anything above
        │
        ▼
aws ecs wait services-stable   ← the workflow blocks here until the above settles
        │
        ▼
Old tasks drain (deregistration_delay = 30s) and terminate
        │
        ▼
Traffic is now served by the new code — end to end, roughly 3-6 minutes
```
Do this trace once for real (push a trivial backend change, watch the Actions tab, then `aws ecs describe-services` while it's mid-deploy) and the relationship between every module in §2 becomes concrete rather than diagrammatic.

---

## 13. GitHub OIDC, Precisely

```hcl
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]   # GitHub's own OIDC cert thumbprint
}
resource "aws_iam_role" "github_actions" {
  assume_role_policy = jsonencode({ Statement = [{
    Principal = { Federated = aws_iam_openid_connect_provider.github[0].arn }
    Action    = "sts:AssumeRoleWithWebIdentity"
    Condition = {
      StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
      StringLike   = { "token.actions.githubusercontent.com:sub" = "repo:${var.github_org}/${var.github_repo}:*" }
    }
  }]})
}
```
Every workflow run gets GitHub to mint it a short-lived, cryptographically-signed JSON Web Token asserting "this run belongs to `repo:madhur-banger/AstriX:*`." AWS's OIDC provider trusts tokens signed by GitHub's well-known key (verified via the thumbprint) and, if the `sub` claim matches the condition above, hands out temporary AWS credentials scoped to exactly this one role — valid only for the run's duration, never stored anywhere, nothing to leak from a compromised dependency the way a long-lived `AWS_ACCESS_KEY_ID` GitHub Secret could be. The `StringLike` wildcard (`repo:org/repo:*`) matches any ref/environment within this repository — worth knowing that a tighter condition (`repo:org/repo:ref:refs/heads/main`) is possible if you ever want to restrict which branches can assume this role, currently any branch or PR in this repo can.

---

## 14. Exercises — Extend and Break This Infra Yourself

1. **Turn on VPC Flow Logs** (`enable_flow_logs = true`) and generate one real request. Find the flow log entry in CloudWatch Logs Insights and identify which security group rule allowed it through — this is the fastest way to build real intuition for how the security groups in §4 actually enforce anything.
2. **Fix the ECR lifecycle policy gap from §9.** Add a fourth rule (or replace all three with one) that actually matches raw commit-SHA tags, and verify against `aws ecr describe-images` that old SHA-tagged images actually start expiring.
3. **Fix `deploy-backend.yml`'s task-definition fragility from §10.2**, using `rollback.yml`'s `jq`-patch pattern as your template. Then simulate the immutable-ECR failure it currently has no protection against: temporarily set `image_tag_mutability = "IMMUTABLE"` in a scratch environment and confirm your fixed workflow still deploys cleanly where the original would have failed on the re-push of `:latest`.
4. **Wire an SNS topic to the three CloudWatch alarms in §8** and subscribe your own email. Then intentionally break something (stop the ECS service manually via the console) and confirm you actually get paged — this is the difference between "an alarm exists" and "alerting exists."
5. **Decide the fate of the unused CloudFront `/api/*` path from §6.** Either route real traffic through it and measure whether latency/caching behavior actually changes for API calls, or remove it and confirm nothing else in the stack was silently depending on it.

---

## 15. What's Still Missing for a Real Multi-Environment, Team-Ready Setup

- **Only `dev` exists.** Copying it into `staging`/`prod` needs, at minimum: a second NAT Gateway per AZ (§3), the HTTPS listener actually uncommented with a *rotated, non-leaked* certificate (§5), `image_tag_mutability` switching to `IMMUTABLE` (which requires §10.2's fix to already be in place, or the very first prod deploy breaks), and IAM scoped per-environment rather than the account-wide `Resource: "*"` gaps in §7.
- **CI/CD is single-environment by hardcoding**, not by design: `ECR_REPOSITORY`, `ECS_CLUSTER`, `ECS_SERVICE`, `S3_BUCKET` are literal strings in every workflow's `env:` block. A branch-keyed matrix (`develop`→dev, `main`→prod) or a duplicated-per-environment set of workflow files are the two realistic options.
- **No blue/green or canary deployment strategy** — the deployment circuit breaker (§8) provides automatic rollback on failure, which is real safety, but a standard rolling replacement still means 100% of new traffic sees the new code as soon as health checks pass, with no gradual traffic-shifting or canary window. CodeDeploy blue/green is the natural next step before this fronts real users.
- **No test gate anywhere in CI** — `pr-check.yml` verifies the code builds, never that it works. This is the Roadmap document's Milestone 0, and it belongs as a required status check in `pr-check.yml` the moment a test suite exists.
- **No approval gate between plan and apply** in `infra.yml` (§10.5) — fine solo, a governance gap the moment a second person has push access.

None of this requires redoing anything already built — every item above is an addition or a targeted fix to code that's already structurally sound. That's the real headline of this deeper pass: the infra is more sophisticated than a first skim suggests (VPC Flow Logs, deployment circuit breakers, a fully-built CloudFront API proxy, DNS-validated prod ACM certs) — the gaps are specifically in *finishing* features that were clearly started (the HTTPS listener, the CloudFront API path, the alarm notification targets) rather than in the foundational design being wrong.