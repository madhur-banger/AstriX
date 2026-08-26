# Infrastructure as Code with Terraform

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md).

Every other file in this module has assumed a fact this one is the first to actually defend: that `infra/environments/dev/*.tf` is the truth about what exists in AWS, and that running `terraform apply` is how that truth becomes reality. None of the networking, IAM, ECS, or CDN chapters stopped to ask *why Terraform* rather than a console click-through, a Python script calling `boto3`, or a different infrastructure-as-code tool entirely. This file asks that question directly. It is not about any one AWS service — it is about the tooling layer underneath all of them: how AstriX's `.tf` files are organized, how they turn into a plan and then into real infrastructure, why state lives in S3 and DynamoDB instead of a hosted service, and what tradeoffs got made — some of them quite deliberately, some of them just because the project is young — along the way.

---

## 1. The Landscape

"How do I provision cloud infrastructure" has a real menu of answers, and the honest starting point is the one every other tool on this list exists to replace.

### (a) ClickOps

ClickOps is the informal-but-accurate industry name for provisioning infrastructure by hand: logging into the AWS Console, clicking "Create VPC," filling in a form for a security group, clicking through the nine-screen wizard for an Application Load Balancer. It requires no tooling, no learning curve, and it is, for a single quick experiment, genuinely the fastest path from idea to running resource.

It is also the anti-pattern every infrastructure-as-code tool in this survey exists to solve. A console click-through leaves no artifact anyone can review before it happens — there is no pull request, no diff, no "here is exactly what will change" step a teammate can look at and object to. It leaves no history: if a security group rule changes, nothing records who changed it, when, or why, beyond whatever CloudTrail happened to log at the API level (and CloudTrail records API calls, not intent). And it is not reproducible: standing up a second identical environment means a human repeating every click, from memory or a wiki page, and hoping nothing drifts. ClickOps is not a strawman included to make the other options look good by comparison — it is the real, default way a huge number of AWS accounts still get built, especially early in a project's life, and it is worth naming plainly as the baseline every declarative tool is a response to.

### (b) Terraform

Terraform, from HashiCorp, is a **declarative**, provider-agnostic infrastructure-as-code tool written in its own configuration language, HCL (HashiCorp Configuration Language). The mental model is the one this whole file is going to keep coming back to: you write `.tf` files describing the infrastructure you *want to exist* — a VPC with these CIDR blocks, an ECS service with this many tasks — and Terraform's job is to figure out the difference between that desired state and whatever currently exists, expressed as a **state file**, and compute a **plan**: a list of creates, updates, and deletes that would close the gap. You never tell Terraform *how* to create a VPC step by step; you tell it *what* the VPC should look like, and it works out the "how."

```hcl
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}
```

That's the entire mental model in one block: this is what a VPC should look like; Terraform compares it to what's real, and acts on the difference. Terraform is provider-agnostic in the sense that the same language and workflow apply whether the provider is AWS, GCP, Azure, Cloudflare, or dozens of others — a real advantage for a team that genuinely operates across multiple clouds, since the tool, the state model, and the team's mental muscle memory carry over even though the resource types themselves don't. The tradeoff is that HCL is its own domain-specific language: no `for` loop or `if` statement works quite like it does in a general-purpose language (Terraform has `count`, `for_each`, and conditional expressions, but they are HCL's own constructs, not Python's or TypeScript's), and a team has to learn that language specifically, on top of whatever languages they already use daily.

### (c) AWS CDK

The AWS Cloud Development Kit takes the opposite bet: instead of a declarative DSL, you write **imperative code in a general-purpose language you already know** — TypeScript, Python, Java, C# — and the CDK compiles that code down into a raw AWS CloudFormation template, which is what actually gets submitted to AWS.

```typescript
const vpc = new ec2.Vpc(this, "MainVpc", {
  cidrBlock: "10.0.0.0/16",
});
```

The appeal is real: a team that already writes TypeScript can use actual loops, actual conditionals, actual functions and classes to build up infrastructure, instead of learning HCL's more limited expression language. Needing twelve near-identical S3 buckets is a genuine `for` loop, not an HCL `for_each` expression that behaves subtly differently from the loop constructs the same engineers use everywhere else in their code. The tradeoff is that CDK is AWS-only — there's no equivalent for provisioning a GCP or Azure resource with the same tool — and that imperative code makes it easier to accidentally introduce non-idempotent behavior (a script that behaves differently depending on what's already there) than a purely declarative model does, since nothing stops a CDK construct's logic from branching on external, non-declared state.

### (d) Pulumi

Pulumi's pitch splits the difference: like CDK, you write real general-purpose languages (TypeScript, Python, Go, C#) instead of a DSL; like Terraform, it's multi-cloud, targeting AWS, GCP, Azure, Kubernetes, and others through the same programming model, and it manages its own state file rather than compiling to a cloud-specific template. For a team that wants general-purpose-language expressiveness *and* multi-cloud portability in one tool, Pulumi is the closest thing to "both" on this list. The tradeoff is the same state-file management overhead Terraform carries (see below), plus a smaller ecosystem and community than Terraform's — fewer public modules to reuse, fewer Stack Overflow answers for an obscure provider quirk.

### Raw CloudFormation, briefly

Underneath CDK sits AWS's own native declarative format, CloudFormation — JSON or YAML templates describing AWS resources, submitted directly to AWS's own CloudFormation service. It's worth naming because CDK is not really a fourth independent tool so much as a code-generator for this one: every CDK app produces a CloudFormation template as its actual deployment artifact. CloudFormation's biggest structural difference from Terraform and Pulumi is where state lives: AWS itself tracks a CloudFormation stack's state, so there is no S3 bucket or DynamoDB table for a team to provision and secure themselves. The tradeoff is that this convenience is AWS-only and comes with CloudFormation's own template syntax, which most teams find more verbose and less pleasant to hand-write than HCL — hence CDK's popularity as a way to generate it instead of writing it directly.

### The honest summary

| Approach | Model | Strongest guarantee | Steepest cost |
|---|---|---|---|
| ClickOps | manual, imperative | fastest to start | no diff, no history, no reproducibility |
| Terraform | declarative, own DSL (HCL) | provider-agnostic, huge ecosystem | HCL's own learning curve; self-managed state |
| AWS CDK | imperative, real languages, compiles to CloudFormation | loops/conditionals in a language you know | AWS-only; easier to write non-idempotent logic |
| Pulumi | imperative, real languages, multi-cloud | general-purpose-language flexibility + multi-cloud | self-managed state; smaller ecosystem than Terraform |
| CloudFormation | declarative, AWS-native | AWS-managed state, no bucket to secure | AWS-only; verbose template syntax |

---

## 2. AstriX's Choice

AstriX uses **Terraform**, with remote state stored in an S3 bucket and locked via a DynamoDB table, organized as **one Terraform module per AWS service** (`infra/modules/acm`, `alb`, `cloudfront_s3`, `ecr`, `ecs`, `iam`, `networking`, `parameter-store`, `security`), wired together by a single environment root at `infra/environments/dev/`. There is currently exactly one environment directory — `dev` — no sibling `staging/` or `prod/` directories exist yet.

---

## 3. AstriX Implementation

### The remote-state backend

The entire backend configuration is one small file:

```hcl
# infra/environments/dev/backend.tf:1-29
# =============================================================================
# DEV ENVIRONMENT - BACKEND CONFIGURATION
# =============================================================================
# Remote state storage in S3 with DynamoDB locking.
# This configuration uses the backend you already created.
# =============================================================================

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

Four things this block is doing: it names the S3 bucket the state JSON lives in (`prod-terraform-state-586794439017`), it gives that state file a path *within* the bucket (`dev/infrastructure/terraform.tfstate` — a convention that leaves room for a second environment's state to live alongside it at, say, `staging/infrastructure/terraform.tfstate`, in the same bucket, without collision), it names the DynamoDB table (`terraform-locks`) used to serialize concurrent `apply` runs, and it turns on server-side encryption for the state object itself (`encrypt = true`). The commented-out `kms_key_id` line shows the backend supports encrypting state with a customer-managed KMS key instead of the default AWS-managed one, but that option isn't currently exercised.

### `required_providers`, the AWS provider, and default tags

```hcl
# infra/environments/dev/main.tf:32-58
terraform {
  required_version = ">= 1.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# -----------------------------------------------------------------------------
# AWS PROVIDER
# -----------------------------------------------------------------------------

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Owner       = var.owner
    }
  }
}
```

`required_version = ">= 1.0.0"` pins the minimum Terraform CLI version this configuration is written to run under — an open-ended floor, not a ceiling. `required_providers` pins the AWS provider (the plugin that translates HCL resource blocks into actual AWS API calls) to `~> 5.0`, meaning any `5.x` release is acceptable but a `6.0` major bump is not, until someone deliberately widens the constraint. The `provider "aws"` block's `default_tags` is worth calling out on its own: every resource this provider creates, across every module, automatically gets `Project`, `Environment`, `ManagedBy`, and `Owner` tags without any individual resource block having to declare them — one of the more underused AWS-provider features for keeping a multi-module Terraform project's resources consistently labeled for cost allocation and ownership tracking.

### Module-per-AWS-service layout

`infra/modules/` holds nine independent modules, each scoped to one AWS service area: `acm/`, `alb/`, `cloudfront_s3/`, `ecr/`, `ecs/`, `iam/`, `networking/`, `parameter-store/`, `security/`. Each is a self-contained directory with its own `main.tf`, `variables.tf`, and `outputs.tf`, callable from an environment root via a `module` block and a relative `source` path. A representative slice of the wiring order, from `infra/environments/dev/main.tf`:

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

```hcl
# infra/environments/dev/main.tf:214-242
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
```

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

`networking` produces a `vpc_id` and `vpc_cidr` that `security` consumes as inputs; `security`'s security-group IDs feed `alb` and `ecs` later in the file; `iam` needs a KMS key ARN that (by default) comes from a module — `parameter_store` — that is itself defined *later* in the file and that separately consumes one of `iam`'s own outputs (`ecs_task_execution_role_arn`). That's not a typo or a forward-reference error: Terraform doesn't care what order blocks appear in a `.tf` file at all (more on this in the next section), and the comment at `main.tf:227-230` calls out explicitly why this isn't a dependency cycle even though it looks like modules `iam` and `parameter_store` reference each other — the actual dependency graph is built per-*resource*, not per-*module*, and the two edges (`iam`'s KMS input, `parameter_store`'s role input) touch different underlying resources.

`variables.tf` groups its roughly 90 variables into comment-banner sections — `PROJECT IDENTIFICATION`, `AWS CONFIGURATION`, `NETWORKING CONFIGURATION`, `APPLICATION CONFIGURATION`, `SECURITY CONFIGURATION`, `IAM CONFIGURATION`, `ECR CONFIGURATION`, `APPLICATION SECRETS`, `ALB CONFIGURATION`, `ECS CONFIGURATION`, then a large `CLOUDFRONT + S3 CONFIGURATION` block with its own sub-sections — mirroring the module list one-to-one. `output.tf` follows the identical pattern in reverse: one banner section per module (`NETWORKING OUTPUTS`, `SECURITY OUTPUTS`, `IAM OUTPUTS`, `ECR OUTPUTS`, and so on) plus a handful of computed summary outputs (`complete_infrastructure_summary`, `deployment_status`, `useful_commands`) that gather values from every module into one human-readable blob for whoever just ran `terraform apply` and wants a quick orientation without reading raw ARNs.

### The imperative provisioners in `bootstrap.tf`

Not everything in this environment is purely declarative. `bootstrap.tf` contains three `null_resource` blocks whose entire job is to shell out to the AWS CLI and Docker at specific points in the apply — a real, if unconventional, pattern worth discussing honestly rather than glossing over. Here is the second of the three, `update_urls`, which pushes freshly-computed ALB/CloudFront URLs into Parameter Store once those resources exist:

```hcl
# infra/environments/dev/bootstrap.tf:105-211
resource "null_resource" "update_urls" {
  count = var.enable_url_auto_update ? 1 : 0

  # Re-run when CloudFront or ALB changes
  triggers = {
    cloudfront_domain = module.cloudfront_s3.distribution_domain_name
    alb_dns           = module.alb.alb_dns_name
    frontend_url      = local.computed_frontend_url
    api_url           = local.computed_api_url
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]

    command = <<-EOT
      set -e

      echo "=========================================="
      echo "Updating Parameter Store with real URLs"
      echo "=========================================="
      echo ""
      echo "ARCHITECTURE:"
      echo "  Frontend: CloudFront → S3"
      echo "  Backend:  ALB → ECS (Direct, not through CloudFront!)"
      echo ""

      PROFILE="${var.aws_profile}"
      REGION="${var.aws_region}"
      PROJECT="${var.project_name}"
      ENV="${var.environment}"

      FRONTEND_URL="${local.computed_frontend_url}"
      API_URL="${local.computed_api_url}"
      COOKIE_DOMAIN="${local.computed_cookie_domain}"
      GOOGLE_CALLBACK="${local.computed_google_callback_url}"
      FRONTEND_GOOGLE_CALLBACK="${local.computed_frontend_google_callback_url}"

      echo "Frontend URL (CloudFront): $FRONTEND_URL"
      echo "API URL (ALB Direct):      $API_URL"
      echo "Cookie Domain:             $COOKIE_DOMAIN"
      echo "Google Callback (ALB):     $GOOGLE_CALLBACK"
      echo "Frontend Google Callback:  $FRONTEND_GOOGLE_CALLBACK"
      echo ""

      # Update FRONTEND_ORIGIN (CloudFront - for CORS)
      echo "Updating FRONTEND_ORIGIN..."
      aws ssm put-parameter \
        --name "/$PROJECT/$ENV/FRONTEND_ORIGIN" \
        --value "$FRONTEND_URL" \
        --type String \
        --overwrite \
        --region "$REGION" \
        --profile "$PROFILE"

      # (four more analogous aws ssm put-parameter calls omitted here for
      # length — VITE_API_BASE_URL, GOOGLE_CALLBACK_URL,
      # FRONTEND_GOOGLE_CALLBACK_URL, COOKIE_DOMAIN follow the identical shape)

      echo ""
      echo "=========================================="
      echo "Parameter Store updated successfully!"
      echo "=========================================="
    EOT
  }

  depends_on = [
    module.cloudfront_s3,
    module.alb,
    module.parameter_store
  ]
}
```

(The full command block in the real file repeats the same `aws ssm put-parameter --overwrite` pattern five times, once per URL value; it's abbreviated above to keep the excerpt focused, with nothing invented or altered in what remains.)

This is genuinely unusual: Terraform's whole value proposition is *declaring* desired state and letting the provider figure out how to get there, and a `local-exec` provisioner is the escape hatch that says "actually, just run this shell script." It exists here to solve a real chicken-and-egg problem — the ALB's DNS name and the CloudFront distribution's domain name don't exist until *after* those resources are created, but the backend's Parameter Store values (used for CORS origins and OAuth callback URLs) need to reference them — and a `null_resource` with a `local-exec` provisioner, triggered by those now-known values and ordered with an explicit `depends_on`, is one straightforward way to bridge that gap without a second `terraform apply` pass. `infra/README.md` (§"`infra/scripts/*.sh`") notes that these `bootstrap.tf` provisioners' functional equivalents were later also extracted into standalone shell scripts (`update-urls.sh`, `initial-setup.sh`) precisely because the in-Terraform version only works reliably from "a specific laptop with Docker and a specific AWS profile" — a fair, honest tell that embedding imperative shell inside declarative Terraform has real operational sharp edges, even though the pattern is real and worth understanding rather than pretending it doesn't exist in this codebase.

---

## 4. Request/Data Flow

Trace what actually happens running `terraform init && terraform plan && terraform apply` from `infra/environments/dev/`:

**`terraform init`** reads `backend.tf` and `main.tf`'s `required_providers` block, downloads the pinned AWS provider plugin (`hashicorp/aws`, `~> 5.0`) into a local `.terraform/` cache, and configures the S3 backend — this is also the point where, if a prior `apply` from someone else is still running, `init` (and any subsequent state-touching command) will find the DynamoDB lock held and refuse to proceed until it's released.

**`terraform plan`** does the actual comparison work. It uses the AWS provider to make read-only API calls against every resource already tracked in state — describing the current VPC, the current ECS service, the current IAM roles — building up a picture of *actual* current state, independent of what's in state file's last-known snapshot (state can drift from reality if someone changed something by hand, which `plan` is specifically designed to catch). It then diffs that real, live state against the *desired* state expressed in the `.tf` files, and produces an execution plan: a list of resources to create, update in place, or destroy-and-recreate.

Critically, `plan` does not walk resources in the order they appear in the `.tf` files. Terraform builds a **directed acyclic graph (DAG)** from every resource and module's input references — if `module.security`'s `vpc_id` input reads `module.networking.vpc_id`, Terraform adds an edge saying "networking must be created (or already exist) before security can be created," regardless of which module block was written first, last, or in a completely different file. This is what makes it safe for `main.tf` to define `module.parameter_store` textually *before* `module.ecs`, even though `ecs` consumes `parameter_store`'s outputs (`ecs_task_execution_role_arn`, secrets) — the graph, not the file, decides execution order. Two resources with no reference relationship to each other at all can be created in parallel, which is part of why Terraform applies are often faster than an equivalent sequence of hand-run AWS CLI calls.

**`terraform apply`** executes that plan against real AWS, resource by resource (in DAG order, parallelizing where the graph allows it), and after each resource succeeds, writes the updated state back to the S3 object named in `backend.tf`'s `key`. Once the whole apply completes (or fails), the DynamoDB lock acquired at the start is released, so the next `plan` or `apply` — from anyone, on any machine, as long as they share the same backend config and credentials — can proceed against the now-current state.

### The explicit `acm` → `alb` dependency

Most of Terraform's dependency awareness is *implicit*: referencing `module.alb.alb_dns_name` as an input to another module or resource is, by itself, enough for Terraform to know that resource must come after `alb`. But `main.tf` also adds an *explicit* dependency for the `acm` module:

```hcl
# infra/environments/dev/main.tf:291-310
module "acm" {
  source = "../../modules/acm"

  project_name             = var.project_name
  environment              = var.environment
  alb_dns_name             = module.alb.alb_dns_name
  organization_name        = "AstriX"
  country_code             = "US"
  save_certificate_locally = true
  certificate_output_path  = "${path.root}/../../certificates"

  enable_custom_domain     = var.enable_alb_custom_domain
  custom_domain_name       = var.alb_custom_domain_name
  include_wildcard         = var.include_wildcard_cert
  certificate_arn          = var.alb_certificate_arn
  enable_expiration_alerts = false

  depends_on = [module.alb]
}
```

`acm` already references `module.alb.alb_dns_name` directly as an input on line 296 — by Terraform's own implicit-dependency rules, that reference alone is sufficient to order `alb` before `acm`, making `depends_on = [module.alb]` on line 309 look redundant at first glance. It isn't wasted, though: an explicit `depends_on` is the right tool exactly when a dependency exists that Terraform's reference-tracking *can't* see on its own, or when a maintainer wants the relationship to be unmissable to a human reading the file rather than only provable by tracing every input through the graph. Here it likely does both — it makes the ordering intent obvious without requiring a reader to notice that a single string interpolation on line 296 is doing the real work, and it guards against a future edit that might remove the direct `alb_dns_name` reference (say, if the ACM module were refactored to compute that value a different way) silently breaking the ordering that a self-signed-cert-generation step still needs. The same pattern repeats one block later: the HTTPS listener resource references `module.acm.certificate_arn` directly and *also* carries `depends_on = [module.acm]` (`main.tf:330`) — belt-and-suspenders ordering on a resource where getting the sequence wrong would mean attaching a TLS listener before its certificate exists.

---

## 5. Design Decisions & Tradeoffs

**S3 + DynamoDB vs. HCP Terraform's managed state.** HashiCorp's own hosted product (Terraform Cloud, now branded HCP Terraform) offers managed remote state, a web UI showing run history, policy-as-code gates (Sentinel or OPA, letting an org block an apply that violates a written policy before it ever runs), and team-based access control over who can plan or apply against which workspace — all without provisioning a single bucket or lock table yourself. AstriX's S3+DynamoDB backend gives up every one of those built-in layers in exchange for something free (S3 storage and a DynamoDB table cost pennies at this scale) and fully self-owned — no third-party account, no vendor-specific run history to migrate away from later, and no dependency on HCP Terraform's own availability to run a `plan`. For a single-environment, single-maintainer project, that tradeoff clearly favors the cheaper, simpler, self-hosted option; a larger team wanting review gates on who can apply to production would feel HCP Terraform's absence much more acutely.

**Module-per-AWS-service vs. one monolithic root module.** The alternative to nine small modules is a single `main.tf` containing all fifty-plus resources inline, with no module boundaries at all. A monolith avoids the plumbing this file discusses in §3 and §4 — no explicit `module "x" { source = ... }` blocks, no deciding which values need to be exposed as outputs for another block to consume, no `depends_on` decisions to make because everything already lives in one file's implicit ordering. What it gives up is exactly what module boundaries buy: a module like `networking` can be reasoned about, and its `variables.tf`/`outputs.tf` read, as a self-contained unit whose job is "produce a VPC and subnets" — a shape that mirrors AWS's own service boundaries and makes it plausible to eventually reuse the same `networking` module unchanged for a second environment. The cost, visible throughout §3's wiring examples, is real inter-module plumbing: `main.tf` has to explicitly thread `module.networking.vpc_id` into `security`, `module.security.alb_security_group_id` into `alb`, and so on — every module boundary is a place where a value has to be deliberately passed through rather than simply being "in scope" the way it would be inside one giant file.

**One `dev` directory vs. `dev`/`staging`/`prod` siblings vs. Terraform workspaces.** AstriX currently has exactly one environment directory. There are two real alternative patterns worth naming, both actively used across the industry, neither one a solved debate:

- **Directory-per-environment** would mean `infra/environments/dev/`, `infra/environments/staging/`, and `infra/environments/prod/` as sibling directories, each with its own `.tf` files (often near-duplicates of each other), its own `terraform.tfvars`, its own backend state key, and even — this is the part easy to overlook — its own independently pinnable provider version, since each directory's `required_providers` block is separate. The cost is duplication: a change to, say, the `networking` module's wiring in `main.tf` has to be copy-pasted (or refactored into a shared module, which AstriX already does at the `infra/modules/` level) into every environment directory that uses it.
- **Terraform workspaces** are the alternative built into the tool itself: the *same* `.tf` code is reused across environments, and `terraform workspace select staging` swaps which state file that code operates against (each workspace gets its own state, but shares the same configuration and, unless a `terraform.workspace` conditional is written in, the same provider version). The appeal is zero code duplication. The real risk it introduces is exactly what its convenience trades away: `terraform workspace select` is a stateful, easy-to-forget CLI action — running `terraform apply` in a terminal where an earlier `workspace select prod` is still in effect, when the engineer believes they're still in `dev`, applies against production with no textual difference in the command they typed to warn them.

AstriX's single `dev` directory isn't a case of either pattern being chosen over the other yet — it's a project at a size where a second environment doesn't exist at all, so the choice between them hasn't had to be made. That's worth naming as a plain lifecycle fact rather than either a gap or a decision: when a second environment does get added, whichever of these two patterns is picked will be a real, deliberate infrastructure decision with the tradeoffs above in play, not a default to fall back on if the code just says "workspaces are what Terraform ships with" or "duplicate the folder."

---

## 6. Security Considerations

**The state bucket's own posture.** `backend.tf:24` sets `encrypt = true`, so the state object itself is encrypted at rest in S3 — visible directly in the backend configuration quoted in §3. `infra/README.md`'s disaster-recovery section instructs confirming bucket versioning is actually on with `aws s3api get-bucket-versioning --bucket prod-terraform-state-586794439017` — a real, checkable operational step, not something the Terraform code itself proves, since bucket versioning here is a property of the bucket that was set up outside this repository's tracked `.tf` files. Public-access blocking on the bucket is likewise not something visible inside `backend.tf` (a `backend "s3" {}` block only configures where Terraform reads and writes its own state — it does not create or manage that bucket's own resource-level settings), so confirming it is blocked is an operational check against the live bucket, not something this file's code proves on its own.

**State files contain secret values in plaintext.** This is a well-known, easy-to-underestimate property of Terraform worth stating explicitly: every value that flows into a resource attribute — including a variable marked `sensitive = true`, like `variable "mongo_uri"` or `variable "jwt_access_token_secret"` in `variables.tf:222-226` and `variables.tf:228-232` — still lands in the state file's underlying JSON in plaintext. `sensitive = true` only redacts a value from *CLI output* (a `terraform plan` or `terraform output` won't print it to a terminal or a CI log); it does nothing to the state file itself, which stores the fully resolved value of every attribute of every resource it tracks, because Terraform needs the real values to compute future diffs correctly. This is exactly why the state bucket's own access controls and encryption matter as much as the KMS-encrypted values sitting in Parameter Store (covered in file 09) — a Parameter Store SecureString is protected by a customer-managed KMS key with a scoped decrypt policy; a Mongo URI or JWT secret that ever flows through a Terraform resource is protected, in the state file, only by whatever access controls and encryption sit on the S3 bucket holding that state.

**DynamoDB locking is concurrency safety, not a security control.** `backend.tf:21`'s `dynamodb_table = "terraform-locks"` exists to stop two simultaneous `apply` runs from racing to write the same state file and corrupting it — a real, important guarantee, but a correctness/concurrency mechanism, not an access-control or encryption boundary. It's worth naming clearly because the two get conflated often enough that it's a common point of confusion: a lock table says nothing about *who* is allowed to run `apply` in the first place, only that only one such run can hold the state file at a time.

**Committing `terraform.tfvars`.** `terraform.tfvars` is the file that actually carries the real secret values referenced above — `terraform.tfvars.example` (the checked-in placeholder template) marks every one of them `CHANGE_ME`, explicitly noting "All values in this section are REAL secrets in terraform.tfvars." `.gitignore` covers this: `*.tfvars` at line 29, alongside `.terraform/` and `.terraform.lock.hcl` entries for the provider cache and dependency lock file. File 09 covers the fuller secrets-and-configuration-management story (SSM Parameter Store, the customer-managed KMS key, the rotation runbook); the point here is narrower — the `.gitignore` coverage for the one local file that seeds those secrets into Terraform in the first place is real and in place.

---

## 7. Best Practice Check

**S3 + DynamoDB locking: still current, with a newer alternative worth naming.** As of 2026, S3-backend state with DynamoDB-table locking remains a completely standard, widely used pattern — it is not a deprecated approach. Terraform 1.10 (released in late 2024) did introduce a genuinely newer alternative: native S3-based locking using S3's own conditional-write support, removing the need for a separate DynamoDB table entirely. Whether AstriX could adopt that today comes down to two numbers actually pinned in this repo: `main.tf:33` sets `required_version = ">= 1.0.0"` — an open floor with no upper bound, so the *configuration itself* doesn't block a newer CLI — but `.github/workflows/infra.yml` pins the CLI CI actually runs with to `terraform_version: 1.7.0` (three separate places: the `validate`, `plan-on-pr`, and `terraform` jobs, at lines 55, 96, and 158). 1.7.0 predates native S3 locking. So: this is a real, current, low-priority modernization option — upgrading the CI-pinned version past 1.10 and switching `backend.tf` to native S3 locking would let the DynamoDB table be retired — not a deficiency in what's here today, since DynamoDB-table locking is still fully supported and still exactly as correct as it's always been.

**Directory-per-environment vs. workspaces: still a live, unsettled debate.** Neither pattern has "won" industry-wide by 2026 — both remain legitimate, actively used approaches, and which one a given team reaches for tends to depend more on team size and risk tolerance for the workspace-selection mistake described in §5 than on either pattern being objectively superior.

**A single `dev` environment with no `staging`/`prod` siblings.** For a project at AstriX's current size — one maintainer, one deployed environment actually serving traffic — this is a normal lifecycle stage, not a red flag. Every multi-environment setup starts as a single environment; the question worth revisiting is *when* a second one earns its cost, not whether the current single-environment state is itself a mistake.

---

## 8. Debug Drill

**Scenario: `terraform apply` fails partway through, and the state lock won't release.**

Work through it in this order:

1. **Is the lock actually still held, or did the previous process just exit uncleanly?** `terraform force-unlock <LOCK_ID>` is the documented escape hatch, but reaching for it before confirming the original process is actually dead risks two concurrent writers touching the same state — check first (via the DynamoDB table directly, or a teammate) whether an `apply` is genuinely still running somewhere before assuming the lock is stale.
2. **Did the process that held the lock die abnormally** — a killed CI job, a closed laptop lid mid-`apply`, a network drop to AWS? Terraform's lock is released as part of a clean command completion; anything that kills the process bypasses that cleanup and leaves the DynamoDB item behind exactly as if the operation were still in progress.
3. **Is everyone pointed at the same DynamoDB table and the same lock key?** A `backend.tf` edit, or a second environment directory added later with its own `dynamodb_table` value, is a way for locks to silently stop actually serializing the runs a team assumes they're serializing.

**Scenario: two team members' `terraform plan` outputs disagree on what will change, even though neither has applied anything.**

1. **Has everyone actually pulled the current remote state before planning?** `plan` reads from the backend configured in `backend.tf` by default, but a local `terraform.tfstate` file sitting in the working directory from an old, pre-remote-backend setup, or a stale `.terraform/` directory pointing at a different backend configuration, can cause `plan` to compare against the wrong baseline entirely. `terraform init -reconfigure` (or just deleting `.terraform/` and re-running `init`) rules this out.
2. **Has someone's local provider version drifted from what's pinned?** `required_providers { aws = { version = "~> 5.0" } }` in `main.tf` allows any `5.x` release; two engineers on different `5.x` patch or minor versions, downloaded at different times, can compute subtly different plans for resources whose schema or default values changed between those versions. Comparing `.terraform.lock.hcl` (checked into the repo, and meant to pin exact resolved versions) against what's actually installed locally is the fastest way to catch this.
3. **Are the two people running `plan` against genuinely the same variables?** A local, uncommitted `terraform.tfvars` edit — remember, this file is gitignored by design (§6) — is invisible to a teammate; two different local copies with even one differing value will produce two different, both individually "correct," plans.

---

Terraform's role in AstriX is deliberately narrow and specific: it is the thing that turns the `.tf` files surveyed across every other chapter in this module into the actual AWS resources those chapters describe, nothing more. The module-per-service layout, the S3+DynamoDB backend, and the single `dev` environment are all real, load-bearing decisions — none of them exotic, all of them explainable, and none of them the only reasonable way to have built this. [`12-cicd-with-github-actions.md`](./12-cicd-with-github-actions.md) picks up from here: the pipeline that actually invokes `terraform fmt`, `validate`, `tfsec`, and `plan` on every pull request touching `infra/**`, gating the manual `apply` behind a GitHub Environment.
