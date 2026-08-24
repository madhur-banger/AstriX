# Container Registry & Image Lifecycle Management

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md).

A container registry looks, at first glance, like a boring piece of plumbing — a place `docker push` sends bytes and `docker pull` fetches them back. Treat it that way and you inherit three real production problems for free: an unbounded storage bill (every image layer you ever pushed sits there accruing GB-month charges forever unless something prunes it), an unmanaged trust boundary (whoever can push or pull is whoever you decided to hand credentials to, and those credentials outlive the reason you issued them), and a blind spot in your supply chain (the image running in production is only as trustworthy as whatever scanned it, if anything did, before it shipped). AstriX's registry setup — a single Terraform module plus one CI step — is a compact, real answer to all three problems at once, and it's worth understanding as its own subsystem before assuming "just use ECR" is a self-explanatory decision.

---

## 1. The Landscape

Every team that ships containers eventually has to pick where images live between build and deploy. The industry has converged on a handful of real, distinct answers, and each one trades off differently on three axes: how tightly it integrates with your cloud's identity system, how much operational burden it puts on you, and what it costs to pull images across a network boundary you don't control.

**(a) Docker Hub — the original public/default registry.** When `docker pull nginx` works with no registry hostname at all, that's Docker Hub resolving implicitly; it's the default `docker.io` namespace baked into the Docker CLI itself, and for years it was simply *the* place public and private images lived. It's still where the base images almost every `Dockerfile` in the world start `FROM` (`node:20-alpine`, `postgres:16`, etc.) live today. Its tradeoff shows up the moment you depend on it at any real CI volume: the free tier enforces anonymous and authenticated pull rate limits (historically 100 pulls/6hr anonymous, 200/6hr authenticated-free, tightened and loosened at various points over the years), and a fleet of CI runners sharing a NAT gateway's egress IP can burn through that ceiling collectively even if no single job looks abusive. This has bitten enough real pipelines — a sudden wave of `429 Too Many Requests` failures with no code change to explain it — that "mirror your base images into your own registry, don't `FROM` Docker Hub directly in CI" is now a well-known operational lesson, not a hypothetical.

```dockerfile
# the implicit-registry line every Dockerfile author has typed without
# thinking about which registry actually serves this pull:
FROM node:20-alpine
```

**Tradeoffs:** zero setup, universally understood, the de facto home of public open-source images — but a public dependency your build depends on, with real, documented rate limits, and no IAM integration with your own cloud account at all (auth is Docker Hub's own username/password or a Docker Hub access token, unrelated to AWS/GCP/Azure identity).

**(b) Cloud-native registries integrated with the cloud's own IAM — Amazon ECR, Google Artifact Registry (formerly GCR), Azure Container Registry.** Each major cloud ships a registry product that authenticates through the same IAM system that authorizes everything else in that account — an EC2 instance role, an ECS task role, or (as AstriX uses) a GitHub Actions OIDC-derived role can be granted `ecr:GetDownloadUrlForLayer`/`ecr:BatchGetImage` the exact same way it would be granted access to an S3 bucket or a DynamoDB table, with no separate registry password to provision, rotate, or leak. Google Artifact Registry and Azure Container Registry offer the identical shape of integration inside their own clouds (workload identity / managed identity in place of an IAM role). This is what AstriX uses, covered in full below.

**Tradeoffs:** the tightest possible auth story *inside* one cloud — no registry-specific secret exists to leak — at the direct cost of portability: an image sitting in ECR is trivial to pull from anything already running in AWS with the right role, and a real cross-cloud or on-prem pull has to either authenticate against AWS explicitly or go through a registry mirror, plus cross-region/cross-cloud egress is billed data transfer, not just a slower pull.

**(c) Self-hosted registries — Harbor, the CNCF project.** Some organizations need a registry that isn't any public cloud's product at all: air-gapped environments with no internet egress, on-prem Kubernetes clusters, or a compliance posture that requires the registry itself (not just its contents) to be under direct organizational control. Harbor is the best-known real answer — a CNCF-graduated project that runs as its own deployment (typically on Kubernetes) and layers role-based access control, image replication between Harbor instances, and its own built-in vulnerability scanning (via Trivy or Clair, pluggable) on top of the same OCI registry API every other option here speaks.

**Tradeoffs:** full control over data residency, network isolation, and access policy, independent of any cloud vendor — at the cost of becoming infrastructure you now operate: patching Harbor itself, backing up its database, scaling its storage backend, and staffing whoever answers the page when it goes down. It is the right tool exactly when "we cannot depend on a cloud vendor's registry" is a real constraint, and meaningful overhead when it isn't.

**(d) GitHub Container Registry (`ghcr.io`).** When your CI is already GitHub Actions, `ghcr.io` collapses source and registry into one platform — a workflow authenticates with the same `GITHUB_TOKEN` it already has (no separate credential to provision at all, cloud IAM or otherwise), and package visibility/permissions inherit from the repository's own permission model. It's a genuinely convenient default for projects that don't have a specific reason to prefer a cloud-native registry, especially open-source projects publishing images alongside their source.

**Tradeoffs:** minimal setup friction if your CI is already GitHub-native, but it doesn't carry the same IAM-native pull story once the *consuming* side is a cloud workload — an ECS task or a Kubernetes pod pulling from `ghcr.io` still needs an explicit `imagePullSecret`/`GITHUB_TOKEN`-derived credential rather than an ambient cloud role, so it reintroduces exactly the credential-provisioning problem option (b) avoids for workloads that live inside the cloud they deploy to.

---

## 2. AstriX's Choice

AstriX uses **Amazon ECR**, authenticated purely through IAM — there is no separate ECR username/password anywhere in the codebase — with a per-repository **lifecycle policy** that automatically prunes old images by count and age, and **native vulnerability scanning** (`scan_on_push`) that Amazon Inspector's predecessor-tech basic scanner runs on every pushed image. The registry, the compute (ECS Fargate), and the CI identity (GitHub Actions OIDC) all sit inside the same AWS account and the same IAM system, which is precisely the option (b) tradeoff described above: maximum internal integration, at the cost of the images being AWS-native and not trivially portable to another cloud without re-authenticating against AWS from wherever they'd be pulled.

---

## 3. AstriX Implementation

### 3.1 The backend ECR repository

```hcl
# infra/modules/ecr/main.tf:20-44
resource "aws_ecr_repository" "backend" {
  name = "${var.project_name}-${var.environment}-backend"

  # Enable image scanning for security vulnerabilities
  image_scanning_configuration {
    scan_on_push = true
  }

  # MUTABLE allows overwriting tags (easier for dev)
  # IMMUTABLE prevents tag overwrites (safer for prod)
  image_tag_mutability = var.environment == "prod" ? "IMMUTABLE" : "MUTABLE"

  # Encryption at rest using AWS managed key (free)
  encryption_configuration {
    encryption_type = "AES256"
  }

  # Allow deletion even if repository contains images
  # Safe for dev, should be false in prod
  force_delete = var.force_delete

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-backend"
  })
}
```

Two things worth pulling out before moving to the lifecycle policy. First, `image_scanning_configuration { scan_on_push = true }` is ECR's **basic** scan type — the original Clair-derived static CVE scan that fires automatically on every push. This module does not create an `aws_ecr_registry_scanning_configuration` resource anywhere (confirmed by reading every `.tf` file under `infra/`), which is the resource that would opt the registry into ECR's newer **enhanced scanning** (the one actually backed by Amazon Inspector, with continuous re-scanning as new CVEs are published against already-pushed images, not just a scan at push time). AstriX runs the basic scan only — worth knowing precisely, since "ECR scans images" undersells the difference between "scanned once, at push" and "continuously monitored against the CVE feed."

Second, `image_tag_mutability` is environment-conditional: `MUTABLE` in dev (a tag like `:latest` can be silently overwritten by a later push — convenient, but it also means a tag is not a reliable pointer to a specific set of bytes), `IMMUTABLE` in a hypothetical `prod` (a tag, once pushed, can never be reassigned to different image content — the tag becomes as trustworthy as a content hash for auditing "what did we actually deploy").

### 3.2 The lifecycle policy — automatic pruning by count and age

```hcl
# infra/modules/ecr/main.tf:47-111
resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last ${var.image_retention_count} tagged images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v", "release"]
          countType     = "imageCountMoreThan"
          countNumber   = var.image_retention_count
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Delete untagged images older than ${var.untagged_image_retention_days} days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.untagged_image_retention_days
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 3
        description  = "Keep only ${var.dev_image_retention_count} dev/feature images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["dev", "feature", "pr"]
          countType     = "imageCountMoreThan"
          countNumber   = var.dev_image_retention_count
        }
        action = {
          type = "expire"
        }
      },
      {
        # Catch-all for how images are ACTUALLY tagged today: deploy-backend.yml
        # and rollback.yml push the raw commit SHA and "latest", neither of
        # which matches the "v"/"release" prefixes rule 1 expects. Without this,
        # rules 1-3 never fire for real deploys and tagged images accumulate
        # unbounded. Lowest priority so the more specific rules above still get
        # first pick of what to keep/expire.
        rulePriority = 4
        description  = "Keep last ${var.image_retention_count} images of any other tag (e.g. commit-SHA, latest)"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.image_retention_count
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
```

This is a genuinely instructive piece of Terraform to read closely, because it has a comment (`rulePriority = 4`, `infra/modules/ecr/main.tf:91-97`) explaining its own history: rules 1 and 3 were written expecting images to be tagged with a `v`/`release` or `dev`/`feature`/`pr` prefix convention, but the real CI pipeline (`deploy-backend.yml`, §3.4 below, and `rollback.yml`) tags images with the raw commit SHA and `latest` — neither of which matches any `tagPrefixList` in rules 1–3. ECR lifecycle rules only ever act on images matching their `selection` — an image that matches none of rules 1–3 is invisible to all of them and would accumulate forever. Rule 4's `tagStatus = "any"` catch-all, at the lowest priority so the more specific rules still get first pick, is what actually bounds real-world growth. It's a small, honest example of a lifecycle policy evolving to match how the pipeline actually tags images rather than how it was originally assumed it would.

The three numeric knobs driving all four rules — `image_retention_count`, `dev_image_retention_count`, `untagged_image_retention_days` — are plain Terraform variables with dev-appropriate defaults:

```hcl
# infra/modules/ecr/variables.tf:55-89
variable "image_retention_count" {
  description = <<-EOT
    Number of tagged images to retain.
    Older images beyond this count will be deleted.

    Higher = more rollback options but higher storage cost
    Lower = less storage cost but fewer rollback options

    Recommended: 10-20 for prod, 5 for dev
  EOT
  type        = number
  default     = 2
}

variable "dev_image_retention_count" {
  description = <<-EOT
    Number of dev/feature/PR images to retain.
    These images are typically short-lived.

    Recommended: 3-5 to keep costs low
  EOT
  type        = number
  default     = 1
}

variable "untagged_image_retention_days" {
  description = <<-EOT
    Days to keep untagged images before deletion.
    Untagged images occur when you push the same tag again.

    Recommended: 1-3 days
  EOT
  type        = number
  default     = 1
}
```

An `image_retention_count` default of `2` is aggressive for a "keep enough images to roll back into" policy — it means at almost any given moment ECR is holding onto only the two most recent images matching rule 4's catch-all, which directly bounds how far back a SHA-pinned rollback (see file 13 on deployment strategies) can reach before the image it would need has already expired.

### 3.3 Optional Lambda repository and cross-account policy

The module also conditionally creates a second repository for container-packaged Lambda functions, gated behind a boolean flag AstriX's `dev` environment leaves off by default (`create_lambda_ecr = false`, `infra/environments/dev/variables.tf:171-175`):

```hcl
# infra/modules/ecr/main.tf:125-166
resource "aws_ecr_repository" "lambda" {
  count = var.create_lambda_repository ? 1 : 0

  name = "${var.project_name}-${var.environment}-lambda"

  image_scanning_configuration {
    scan_on_push = true
  }

  image_tag_mutability = var.environment == "prod" ? "IMMUTABLE" : "MUTABLE"

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-lambda"
  })
}

resource "aws_ecr_lifecycle_policy" "lambda" {
  count = var.create_lambda_repository ? 1 : 0

  repository = aws_ecr_repository.lambda[0].name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last ${var.image_retention_count} Lambda images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.image_retention_count
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
```

And cross-account pull access — off by default, on only if the `cross_account_ids` list is populated:

```hcl
# infra/modules/ecr/main.tf:175-197
resource "aws_ecr_repository_policy" "backend_cross_account" {
  count = length(var.cross_account_ids) > 0 ? 1 : 0

  repository = aws_ecr_repository.backend.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CrossAccountPull"
        Effect = "Allow"
        Principal = {
          AWS = [for id in var.cross_account_ids : "arn:aws:iam::${id}:root"]
        }
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability"
        ]
      }
    ]
  })
}
```

And the module is wired into the `dev` environment as one call passing through the same variables:

```hcl
# infra/environments/dev/main.tf:249-267
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

### 3.4 The CI scan gate — `deploy-backend.yml`

This is the step that turns "ECR scans images" from a passive feature into an actual deploy-blocking control. Reproduced in full:

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

Line by line: a `for` loop polls `aws ecr describe-image-scan-findings` up to 30 times, 10 seconds apart (a 5-minute ceiling), until the scan's `imageScanStatus.status` is either `COMPLETE` or `FAILED` — if the CLI call itself errors (e.g. the scan record doesn't exist yet, right after push), the `|| echo "IN_PROGRESS"` fallback keeps the loop going rather than crashing the step. If the loop exits *without* reaching `COMPLETE`, the step emits a GitHub Actions `::warning::` annotation and `exit 0` — a **non-blocking** timeout: the deploy proceeds anyway. Only if the scan genuinely completed does the step query `imageScanFindings.findingSeverityCounts.CRITICAL`, normalize AWS's `None` (meaning zero) to the literal string `"0"`, and `exit 1` with a `::error::` annotation — failing the whole job — if that count is nonzero.

For contrast, note that ECR's own native scan is not the only scanner in this repository's pipeline. `pr-check.yml` runs a second, independent scan at an earlier pipeline stage, on pull requests, using a different tool entirely:

```yaml
# .github/workflows/pr-check.yml:46-55
      - name: Build Docker image (not pushed)
        run: docker build -t astrix-backend:pr-${{ github.event.pull_request.number }} .

      - name: Scan image for vulnerabilities
        uses: aquasecurity/trivy-action@0.24.0
        with:
          image-ref: astrix-backend:pr-${{ github.event.pull_request.number }}
          severity: CRITICAL,HIGH
          exit-code: '1'
          ignore-unfixed: true
```

Trivy here scans a locally built image that's never pushed anywhere — it runs entirely inside the PR-check job's own runner, before an image has ever touched ECR — and it gates on `CRITICAL,HIGH` together, not CRITICAL alone. Two real scanners, two real severity thresholds, at two real pipeline stages: PR-time Trivy on an ephemeral local build gates merge, and push-time ECR native scanning on the actual artifact that will be deployed gates release. A full comparison of scanning tools belongs to the dedicated security-scanning file later in this module; the point to take from it here is narrower — ECR's own scan-on-push is one layer among (at least) two, not the pipeline's only vulnerability check.

### 3.5 The manual/operational path — `push-backend-image.sh`

Everything above describes the automated CI path. AstriX also ships an operator-run script for pushing an image by hand — useful for a first bootstrap deploy, a local debugging build, or any situation where triggering the full GitHub Actions pipeline isn't the right tool:

```bash
# infra/scripts/push-backend-image.sh:105–145 (ECR auth + repository check)
ECR_REPOSITORY_NAME="${PROJECT_NAME}-${ENVIRONMENT}-backend"
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
ECR_REPOSITORY_URI="${ECR_REGISTRY}/${ECR_REPOSITORY_NAME}"

log_info "ECR Repository: $ECR_REPOSITORY_URI"

# Check if ECR repository exists
if ! aws ecr describe-repositories \
    --repository-names $ECR_REPOSITORY_NAME \
    --region $AWS_REGION \
    --profile $AWS_PROFILE > /dev/null 2>&1; then
    log_error "ECR repository '$ECR_REPOSITORY_NAME' not found"
    log_info "Run terraform apply in infra/environments/dev first"
    exit 1
fi
log_success "ECR repository exists"

log_info "Authenticating Docker with ECR..."

aws ecr get-login-password \
    --region $AWS_REGION \
    --profile $AWS_PROFILE | \
    docker login \
    --username AWS \
    --password-stdin $ECR_REGISTRY
```

Notice this script authenticates the exact same way CI does — `aws ecr get-login-password` piped into `docker login`, using whatever IAM identity the invoking `aws --profile` resolves to (`prod-terraform` by default, `infra/scripts/push-backend-image.sh:28`) — never a hardcoded ECR credential. It also tags and pushes both a caller-specified tag and `latest` unconditionally (`infra/scripts/push-backend-image.sh:156-196`), the same dual-tag convention CI uses, discussed in §5. Critically, this script contains **no scan-wait step at all** — an operator pushing by hand bypasses the CI scan gate entirely, since nothing but `deploy-backend.yml` itself calls `describe-image-scan-findings`. That's not a defect in the script (it's explicitly a manual/break-glass tool, not a deploy path), but it is worth naming plainly: the scan gate is a property of one specific workflow, not a property of the registry or an org-wide policy enforced regardless of how an image got there.

---

## 4. Request/Data Flow

Tracing one real push-to-running-task cycle end to end, tied to the code above:

1. A commit lands on `main` touching `backend/**`, triggering `deploy-backend.yml` (`.github/workflows/deploy-backend.yml:3-9`).
2. `aws-actions/configure-aws-credentials` exchanges the workflow's GitHub OIDC token for temporary AWS credentials scoped to `astrix-dev-github-actions-role` (`.github/workflows/deploy-backend.yml:34-38`) — this is the IAM trust relationship covered in depth in file 04; nothing about OIDC itself is re-explained here, only that it's the credential source for everything that follows.
3. `aws-actions/amazon-ecr-login@v2` uses those temporary credentials to fetch an ECR authorization token and configure Docker's credential store — functionally the same `aws ecr get-login-password | docker login` flow the manual script runs by hand, just performed by a maintained GitHub Action (`.github/workflows/deploy-backend.yml:40-42`).
4. `docker build` produces the image, tagged twice in one command — with `$IMAGE_TAG` (the commit SHA, `github.sha`) and with `latest` — and both tags are pushed (`.github/workflows/deploy-backend.yml:44-54`).
5. The instant a manifest lands in ECR, ECR's own scan-on-push (§3.1) kicks off asynchronously, entirely server-side — nothing in the workflow triggers it explicitly; it's a property of the repository configuration, not the push command.
6. The "Wait for ECR image scan and check findings" step (§3.4) polls until that asynchronous scan reaches `COMPLETE`, then queries the `CRITICAL` finding count for the exact SHA tag just pushed and fails the job if it's nonzero.
7. Only if that step exits `0` does the workflow call `aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE --force-new-deployment` (`.github/workflows/deploy-backend.yml:89-94`) — this does not change *which* image ECS is configured to pull; it simply forces ECS to start new tasks from the task definition's current image reference.
8. That task definition, per Terraform, resolves its image as `"${var.ecr_repository_url}:${var.image_tag}"` (`infra/modules/ecs/main.tf:90`), where `image_tag` defaults to `"latest"` (`infra/environments/dev/variables.tf:333-337`, `infra/modules/ecs/variables.tf:89-93`) — so the new Fargate tasks pull whatever `latest` currently points at in ECR, which is the same manifest just pushed and scanned in step 4–6, since both the SHA tag and `latest` were pushed together.
9. `aws ecs wait services-stable` blocks the job until the new tasks pass their health checks and the old tasks drain (`.github/workflows/deploy-backend.yml:96-101`) — deployment strategy and the circuit breaker that can auto-rollback a failing deployment are covered in file 13, not here.

---

## 5. Design Decisions & Tradeoffs

**Why tag with both the commit SHA and `latest`, not just one.** These two tags serve genuinely different consumers. The SHA tag (`github.sha`) is immutable in practice (nothing else will ever be pushed under that exact 40-character tag) and specific — it's what `rollback.yml` needs to re-register a task-definition revision pinned to a known-good commit, because "roll back to `latest`" is meaningless once `latest` has moved on. `latest`, meanwhile, is what the day-to-day deploy path actually runs against: the ECS task definition's `image_tag` variable defaults to `"latest"` (`infra/environments/dev/variables.tf:333-337`), and — this is the detail worth sitting with — the task definition resource itself carries `lifecycle { ignore_changes = [container_definitions] }` (`infra/modules/ecs/main.tf:202-204`), with a comment explaining exactly why: CI's `force-new-deployment` against `:latest`, and `rollback.yml`'s direct registration of a SHA-pinned revision, are what actually own the running image after the first `terraform apply` — not Terraform. That's a real, load-bearing design choice: Terraform declares the *shape* of the task (CPU, memory, secrets, health check) once, then deliberately steps back and lets CI own which image tag is actually running, so that a routine `terraform apply` for an unrelated infra change (say, bumping ALB idle timeout) can never silently re-point the running container back to `:latest`, undoing a rollback that pinned it to a specific SHA.

**Why a lifecycle policy instead of manual cleanup or unlimited retention.** ECR storage is billed per GB-month, and container images are not small — even a slim multi-stage Node image easily runs into the hundreds of MB once you count layers. Every single push, tagged or not, is a permanent object until something deletes it. Manual cleanup ("someone remembers to run `aws ecr batch-delete-image` occasionally") doesn't survive contact with a team that has better things to think about, and it's exactly the kind of task that never happens until a bill spikes. A lifecycle policy makes pruning a property of the repository itself — declarative, versioned in Terraform, and enforced by AWS on a schedule with zero ongoing human attention — which is the correct default for any resource whose accumulation is otherwise unbounded. The tradeoff, visible directly in the `image_retention_count = 2` default (§3.2), is that aggressive pruning trades rollback depth for storage cost: keeping only 2 images of any given catch-all tag class means a rollback more than a couple of deploys back may find its target image already expired.

**Why the deploy gate blocks on CRITICAL findings specifically, not HIGH or MEDIUM.** This is a real, deliberate severity threshold, not an oversight — the query literally asks only for `imageScanFindings.findingSeverityCounts.CRITICAL` (`.github/workflows/deploy-backend.yml:77-80`). My honest read: CRITICAL-only is a reasonable *floor*, not a reasonable *ceiling*, for a service handling real user data. CRITICAL vulnerabilities are (by definition, in the CVSS-derived severity bands ECR uses) the ones with the most severe, most trivially exploitable impact, so gating on them catches the most urgent class of finding with a low false-positive cost — CRITICAL findings are rare enough in a well-maintained base image that this rarely blocks a legitimate deploy. But HIGH-severity CVEs are routinely exploitable in practice too, and the base-image ecosystem accumulates them constantly; letting every HIGH finding through silently on every single deploy means the team never actually looks at them unless someone manually runs `describe-image-scan-findings` out of band. Contrast this with `pr-check.yml`'s Trivy step, which gates on `CRITICAL,HIGH` together (§3.4) — the repository already has one scanner enforcing the stricter bar; the deploy-time ECR gate choosing a looser bar than the PR-time gate is an inconsistency worth noticing, even if CRITICAL-only at deploy time is defensible on its own.

**Is the non-blocking timeout fallback the right failure mode for a security gate?** I'd call this a real gap, named plainly. The `::warning::` + `exit 0` branch (`.github/workflows/deploy-backend.yml:72-75`) means that if ECR's scan simply takes longer than 5 minutes — which can happen under registry load, or for a larger image with more layers to analyze — the deploy proceeds with **zero scan result checked at all**, not a delayed-but-eventually-checked result. A security gate that fails open under its own infrastructure's latency isn't functioning as a gate in that scenario; it's functioning as a scan that runs *after* the fact, if anyone remembers to look. A stricter (and arguably more correct) design would fail the job on timeout too, or retry with backoff past 5 minutes before giving up, or at minimum page/notify a human rather than silently annotate and proceed. As implemented, it's a reasonable choice for keeping deploys from hanging indefinitely on registry flakiness, but it quietly trades "we verified this image before shipping it" for "we usually verify this image before shipping it," and that distinction matters exactly in the moments — registry under load, larger-than-usual image — when a scan is most likely to be worth waiting for.

---

## 6. Security Considerations

**Access to the registry is IAM-controlled, not a separate credential.** Every actor that touches ECR in this system — the GitHub Actions deploy workflow, the ECS task's pull at container start, an operator running `push-backend-image.sh` locally — authenticates through an AWS IAM identity (a role assumed via OIDC, or a local `aws` CLI profile) and a short-lived token minted by `aws ecr get-login-password`, never a static registry username/password. This is the direct payoff of choosing an IAM-native registry (§1(b)): there is no ECR-specific secret sitting in a GitHub Actions secret store or a `.env` file that could leak independently of the AWS credentials protecting everything else. It also means ECR access inherits whatever IAM least-privilege discipline is (or isn't) applied to those roles — the subject of file 04, not re-litigated here.

**The native scan-on-push is real, but it's the basic scan type, not enhanced/Inspector-backed scanning.** Confirmed directly in `infra/modules/ecr/main.tf:24-26` and `:130-132` (`image_scanning_configuration { scan_on_push = true }`), and confirmed by absence — no `aws_ecr_registry_scanning_configuration` resource exists anywhere under `infra/` to opt into ECR's enhanced scan type. Practically, this means every image gets one static CVE scan at push time, using the CVE database as it existed at that moment — it does not continuously re-scan already-pushed, still-running images as new CVEs are disclosed against packages already baked into them. An image that passed its scan clean on day one can become vulnerable on day thirty with nothing in this pipeline re-checking it, unless a new image is pushed and scanned again.

**The CI gate on CRITICAL findings is a real, working supply-chain control** — it is not merely a report generated for a human to read later; a nonzero CRITICAL count genuinely fails the GitHub Actions job (`exit 1`, `.github/workflows/deploy-backend.yml:84-87`) and prevents `aws ecs update-service` from ever running. That's the meaningful difference between "we scan images" and "we scan images and the result can actually stop a bad one from reaching production" — AstriX has the latter, for the CRITICAL band specifically, with the caveats on severity threshold and timeout behavior discussed in §5.

**Cross-account access defaults to empty, which is the correct least-privilege default.** `cross_account_ids = []` (`infra/modules/ecr/variables.tf:96-108`) means the `aws_ecr_repository_policy.backend_cross_account` resource has `count = length(var.cross_account_ids) > 0 ? 1 : 0` (`infra/modules/ecr/main.tf:176`) evaluate to zero — the resource simply doesn't exist in the current `dev` deployment. No other AWS account can pull from this repository at all unless someone explicitly populates that list. Worth naming because it's easy for a module to ship a *feature* like cross-account pull support and, through a careless default, ship it *enabled*; here the feature exists but its blast radius is opt-in only.

---

## 7. Best Practice Check

Scan-on-push plus a CI gate on some severity threshold was genuinely close to industry-standard practice a few years ago, and it's still a real, meaningful control today — but "current 2026 industry-standard" has moved past where this configuration sits, on two fronts worth naming honestly and independently (not as a citation of any specific audit — this is my own read of the gap between what's here and what a leading team would run today).

First, **severity coverage**. Gating only on CRITICAL, with HIGH findings visible only if someone manually queries for them, is a materially looser bar than what mature container-security postures use going into 2026 — CRITICAL-plus-HIGH gating (exactly what this repository's own `pr-check.yml` Trivy step already does, §3.4) is closer to the modern baseline, and the deploy-time ECR gate not matching the PR-time gate's own severity bar is a real, fixable inconsistency.

Second, and more significant: **this repository does not generate a Software Bill of Materials (SBOM) or sign/attest its images.** SBOM generation (tools like Syft, or `docker buildx build --sbom=true`) produces a structured manifest of every package and version baked into an image — the artifact you'd actually need to answer "are we affected by this newly disclosed CVE" across your whole fleet in minutes rather than by re-scanning every image you've ever built. Image signing and provenance attestation — Sigstore/`cosign` being the dominant real, named tooling here, often paired with SLSA provenance metadata — lets a deploy pipeline (or a Kubernetes admission controller, or an ECS equivalent) cryptographically verify that the exact image about to run was built by *your* CI, from *your* source, and hasn't been tampered with or substituted in the registry in between. Neither exists anywhere in this codebase: no `cosign sign` step, no SBOM generation step, no signature-verification step gating the ECS deploy. This is a real, independently-observed gap against where the industry has moved, not a defect unique to this project — a large fraction of teams running container workloads in 2026 still don't have this either — but it's exactly the kind of thing worth naming plainly rather than assuming "we scan images" already covers it. Scan-on-push plus a CRITICAL-only CI gate with a non-blocking timeout fallback is a reasonable middle ground for a project at AstriX's current size and team scale — it's real, working, and better than nothing, which is where a lot of side/early-stage projects sit — but it should be read as a starting point to build on (tighten the severity bar, add SBOM/signing) rather than a finished security posture for the registry layer.

---

## 8. Debug Drill

**Scenario:** a deploy to `main` triggers `deploy-backend.yml`, and the job hangs (or eventually fails) at the "Wait for ECR image scan and check findings" step — or, in a related but distinct scenario, the job completes successfully end to end, but the running ECS tasks are visibly still serving old behavior even though a new image was clearly pushed.

**If the scan step is hanging or timing out:** first, check the scan status directly and independently of the workflow's own polling — `aws ecr describe-image-scan-findings --repository-name astrix-dev-backend --image-id imageTag=<sha>` run from a local terminal with the right credentials tells you immediately whether the scan is still `IN_PROGRESS`, sitting at `FAILED`, or actually `COMPLETE` (in which case the *workflow's* polling loop, not the scan itself, is the thing that's stuck or was too short — worth checking the loop's own logic, §3.4, for an off-by-one or an unexpected `aws` CLI error masking a real status behind the `|| echo "IN_PROGRESS"` fallback). A scan sitting at `FAILED` most often means ECR couldn't parse the image (an unusual base image, or a manifest format issue) rather than a security finding — that's a different problem than "found vulnerabilities" and needs different remediation (rebuilding from a supported base image), not a policy exception. If the CLI call itself errors with an access-denied style message rather than returning a status, check the calling role's IAM policy for `ecr:DescribeImageScanFindings` on this specific repository — a role that can push and pull images doesn't automatically have permission to read scan results back; that's a separate action.

**If the workflow succeeds but the running tasks look like they're serving an old image:** the first and most common cause is a mismatch between what CI pushed and what ECS is actually configured to pull — recall from §4 that ECS pulls `"${ecr_repository_url}:${image_tag}"`, where `image_tag` is a Terraform variable defaulting to `"latest"` (`infra/modules/ecs/main.tf:90`, `infra/environments/dev/variables.tf:333-337`) — if some prior action (an operator, a different workflow, a manual `terraform apply` with an overridden `-var` value) ever set that variable to a specific pinned SHA rather than `latest`, `force-new-deployment` would keep restarting tasks that pull the *same old pinned tag* forever, no matter how many new commits get pushed and tagged `latest`. Checking the actual task definition's container image reference in the AWS console or via `aws ecs describe-task-definition` and comparing it against the tag the deploy workflow just pushed is the fastest way to confirm or rule this out. Second, check whether `aws ecs wait services-stable` actually completed and new tasks genuinely replaced old ones, versus the deployment circuit breaker (file 13) having detected unhealthy new tasks and rolled back automatically — a rollback here would look exactly like "the new image never really took effect," because it didn't, by design. Third — and specific to the registry layer this file covers — verify the image ECS is pulling by digest, not just tag: `aws ecr describe-images --repository-name astrix-dev-backend --image-ids imageTag=latest` returns the actual digest `latest` currently resolves to, and comparing that digest against the one CI's build step just pushed rules out any possibility of a stale cached pull or a race between two overlapping deploys both retagging `latest` in quick succession. Finally, rule out the boring but real possibility that the repository policy or IAM role granted to the ECS task's execution role lacks `ecr:GetDownloadUrlForLayer`/`ecr:BatchGetImage` for the *newly pushed* image specifically — this is rare once the base repository access already works, but worth a quick permission check before assuming the problem is in application code.
