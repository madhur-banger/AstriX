# Secrets and Configuration Management

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md).

Every AWS resource discussed so far in this module — the VPC, the security groups, the IAM roles, the ECR repository — is infrastructure the application runs *on*. This file is about something the application runs *with*: the Mongo connection string, the JWT signing keys, the Google OAuth client secret. These values are different in kind from everything else in Terraform state. A subnet CIDR or a security group rule is safe to print in a PR diff, safe to paste into a Slack thread, safe to leave in a `terraform plan` log forever. A database credential is not. The moment a value's exposure is itself the incident — not a side effect of some other failure, but the entire failure — it needs its own handling path, distinct from ordinary configuration. That's what this chapter covers: how a value gets from "something a human knows" to "something a running container can read," without ever passing through a place where the wrong person could read it too.

---

## 1. The Landscape

Every backend needs a way to answer the question "where do the secrets actually live before the app reads them?" There are four real, commonly-used answers, and they trade off very differently on cost, operational overhead, and how seriously they treat "a secret leaked" as a distinct failure mode from "a config value was wrong."

### (a) Plain `.env` files / environment variables set directly in a process manager or CI config

The simplest possible approach: secret values live in a `.env` file read by a library like `dotenv` in development, and in production the same values are typed directly into whatever sets process environment variables — a systemd unit file, a Heroku config var, a GitHub Actions repository secret, a Docker Compose `environment:` block.

```bash
# .env — illustrative, not AstriX
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/db
JWT_ACCESS_TOKEN_SECRET=b23f...
```

**Tradeoffs:** zero infrastructure, zero new tooling, works identically everywhere `process.env` works. The real risks are just as plain: a `.env` file is a file, and files get accidentally `git add -A`'d — this is one of the single most common real-world secret-leak vectors, common enough that GitHub's own secret-scanning product exists largely because of it. There's no audit trail (no record of who read a value or when), no encryption-at-rest as a property of the storage mechanism itself (the file is only as protected as the filesystem permissions around it), and no rotation mechanism beyond "someone edits the file and redeploys by hand." It's a fine starting point for a side project or the first few weeks of a real one; it does not scale to a team, a compliance requirement, or an incident-response process that needs to answer "who could have seen this value?"

### (b) Cloud-native parameter/secret stores — AWS SSM Parameter Store and AWS Secrets Manager

AWS ships two different, genuinely distinct products for this problem, and the difference between them matters enough that conflating them is a real mistake:

- **SSM Parameter Store** (`SecureString` type) encrypts a value with a KMS key at rest and decrypts it on read, gated by IAM. It has no built-in rotation *scheduler* — rotating a value is something you script or do by hand. Standard parameters are free; advanced parameters (needed past 10,000 parameters per account, or for larger values) have a small per-parameter monthly cost, but for the common case, `SecureString` under the standard tier costs nothing beyond the KMS key itself.
- **AWS Secrets Manager** is a sibling service purpose-built for *secrets specifically*: same KMS-backed encryption at rest, but with first-class rotation scheduling — an AWS Lambda function you point it at (or one of AWS's provided ones for RDS, DocumentDB, etc.) that Secrets Manager invokes on a schedule to actually rotate the credential and update the stored value automatically. That capability isn't free: Secrets Manager charges **per secret per month** (roughly $0.40/secret/month as of 2026, plus API call costs), on top of whatever the rotation Lambda itself costs to run.

```hcl
# illustrative aws_secretsmanager_secret — not AstriX, shown for contrast
resource "aws_secretsmanager_secret" "db_password" {
  name = "prod/db/password"
}
resource "aws_secretsmanager_secret_rotation" "db_password" {
  secret_id           = aws_secretsmanager_secret.db_password.id
  rotation_lambda_arn = aws_lambda_function.rotator.arn
  rotation_rules { automatically_after_days = 30 }
}
```

**Tradeoffs:** Parameter Store is essentially free and simple, but rotation is a manual or self-scripted process. Secrets Manager buys you a real, automated rotation *pipeline* at a real recurring dollar cost per secret. For an account with dozens of secrets, that cost adds up fast enough that "which one do we pick" becomes a genuine, nameable tradeoff rather than a formality — not a question with an obviously correct answer independent of team size and secret count.

### (c) HashiCorp Vault

Vault is the multi-cloud, on-prem-capable standard for secrets management, and it solves a meaningfully bigger problem than either AWS service: instead of just storing static values, Vault can issue **dynamic secrets** — short-lived, per-request database credentials or cloud API keys generated on demand and automatically revoked after a lease expires, so a leaked credential is only ever valid for minutes rather than indefinitely. It also does encryption-as-a-service, PKI issuance, and fine-grained policy-based access to secret paths.

```bash
# illustrative Vault CLI usage — not AstriX
vault read database/creds/readonly
# => returns a freshly-generated, time-limited Postgres username/password
```

**Tradeoffs:** Vault is the most powerful option here by a wide margin, but that power comes with real operational cost — someone has to run it (unseal keys, storage backend, high availability, upgrades) or pay HashiCorp Cloud Platform to run a managed instance. For a team already deep in the AWS ecosystem and not multi-cloud, Vault is usually more infrastructure than the problem calls for; it earns its keep once dynamic, short-lived credentials or multi-cloud/on-prem portability become real requirements rather than nice-to-haves.

### (d) A dedicated secret-sync tool — External Secrets Operator (Kubernetes ecosystem)

Worth naming as a bridge pattern rather than a fifth genuinely independent approach: External Secrets Operator (ESO) is a Kubernetes controller that watches a `SecretStore`/`ExternalSecret` custom resource, fetches the referenced value from Parameter Store, Secrets Manager, Vault, or similar, and materializes it as a native Kubernetes `Secret` object that pods mount normally. It doesn't replace any of (a)–(c) — it's glue that lets a team keep AWS or Vault as the source of truth while still consuming secrets the idiomatic Kubernetes way. AstriX doesn't run on Kubernetes (it runs on ECS Fargate — see [file 06](./06-compute-and-container-orchestration-ecs-fargate.md)), so ESO isn't a live option here; it's included only because "how do secrets get from a central store into a running workload" has a different, common answer once the orchestrator is Kubernetes instead of ECS, and it's worth recognizing by name if you ever open a k8s-based codebase.

---

## 2. AstriX's Choice

AstriX uses **option (b), specifically SSM Parameter Store**, with `SecureString` encryption backed by an **optional customer-managed KMS key**, and secrets are injected into ECS Fargate tasks at container start — never baked into the Docker image, never committed to the repository, and never passed as plaintext `environment` values in the task definition. Rotation is manual, following a documented runbook rather than an automated Secrets Manager rotation schedule.

---

## 3. AstriX Implementation

### 3.1 The customer-managed KMS key and its key policy

```hcl
data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

resource "aws_kms_key" "parameter_store" {
  count = var.create_kms_key ? 1 : 0

  description             = "KMS key for ${var.project_name}-${var.environment} Parameter Store encryption"
  deletion_window_in_days = var.kms_deletion_window
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid    = "EnableIAMUserPermissions"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      }
      ],
      var.ecs_task_execution_role_arn != null ? [
        {
          Sid    = "AllowECSExecutionRoleDecrypt"
          Effect = "Allow"
          Principal = {
            AWS = var.ecs_task_execution_role_arn
          }
          Action = [
            "kms:Decrypt",
            "kms:DescribeKey"
          ]
          Resource = "*"
          Condition = {
            StringEquals = {
              "kms:ViaService" = "ssm.${data.aws_region.current.name}.amazonaws.com"
            }
          }
        }
    ] : [])
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-parameter-store-key"
  })
}

resource "aws_kms_alias" "parameter_store" {
  count = var.create_kms_key ? 1 : 0

  name          = "alias/${var.project_name}-${var.environment}-parameter-store"
  target_key_id = aws_kms_key.parameter_store[0].key_id
}
```
`infra/modules/parameter-store/main.tf:30-91`

Two things worth noticing here that make this a *real* key policy rather than boilerplate. First, the `EnableIAMUserPermissions` statement is not optional decoration — a KMS key policy that omits it becomes permanently unmanageable, because a customer-managed key's policy is the outermost gate: IAM policies in the account can only grant access to a key if the key's own policy also allows it. Skip this statement and even the account root loses the ability to fix the key later. Second, the `AllowECSExecutionRoleDecrypt` statement grants exactly two actions (`kms:Decrypt`, `kms:DescribeKey`) to exactly one principal (the ECS task execution role ARN, passed in as a variable — see §3.4), and only when the call arrives `kms:ViaService` SSM in this specific region. That condition is what makes the grant narrow: even if the execution role's credentials leaked outright, they could not use this key to decrypt anything that wasn't fetched through an SSM `GetParameters` call.

### 3.2 `SecureString` vs. plain `String` parameters

```hcl
resource "aws_ssm_parameter" "mongo_uri" {
  name        = "/${var.project_name}/${var.environment}/MONGO_URI"
  description = "MongoDB connection URI"
  type        = "SecureString"
  value       = var.mongo_uri
  key_id      = local.parameter_kms_key_id

  tags = merge(var.common_tags, {
    Name        = "MONGO_URI"
    Sensitive   = "true"
    Application = "backend"
  })

  lifecycle {
    ignore_changes = [value] # Prevent accidental overwrite
  }
}
```
`infra/modules/parameter-store/main.tf:108-124`

```hcl
resource "aws_ssm_parameter" "jwt_access_token_secret" {
  name        = "/${var.project_name}/${var.environment}/JWT_ACCESS_TOKEN_SECRET"
  description = "JWT access token secret key"
  type        = "SecureString"
  value       = var.jwt_access_token_secret
  key_id      = local.parameter_kms_key_id

  tags = merge(var.common_tags, {
    Name        = "JWT_ACCESS_TOKEN_SECRET"
    Sensitive   = "true"
    Application = "backend"
  })

  lifecycle {
    ignore_changes = [value]
  }
}
```
`infra/modules/parameter-store/main.tf:130-146`

Compare that against a genuinely non-sensitive value stored as plain `String` — the callback URL is a public-facing redirect target, not a credential, so there's nothing to encrypt and no `key_id` argument at all:

```hcl
resource "aws_ssm_parameter" "google_callback_url" {
  name        = "/${var.project_name}/${var.environment}/GOOGLE_CALLBACK_URL"
  description = "Google OAuth callback URL (backend)"
  type        = "String"
  value       = var.google_callback_url

  tags = merge(var.common_tags, {
    Name        = "GOOGLE_CALLBACK_URL"
    Application = "backend"
  })
}
```
`infra/modules/parameter-store/main.tf:224-234`

The module creates 14 parameters total under `/astrix/dev/*` this way — four as `SecureString` (`MONGO_URI`, `JWT_ACCESS_TOKEN_SECRET`, `JWT_REFRESH_TOKEN_SECRET`, `GOOGLE_CLIENT_SECRET`) and ten as plain `String` (expiry durations, the Google client ID, the computed frontend/callback/cookie URLs, `NODE_ENV`, `PORT`, and the frontend's `VITE_API_BASE_URL`) — confirmed directly in the module's own summary output:

```hcl
output "parameter_store_summary" {
  description = "Summary of Parameter Store configuration"
  value = {
    base_path           = "/${var.project_name}/${var.environment}"
    total_parameters    = 14
    secure_parameters   = 4 # mongo_uri, jwt secrets, google secret
    standard_parameters = 10
    kms_key_created     = var.create_kms_key
  }
}
```
`infra/modules/parameter-store/outputs.tf:122-131`

The `lifecycle { ignore_changes = [value] }` block on every secret-bearing resource is deliberate: once a parameter exists, Terraform stops trying to reconcile its `value` on subsequent `apply` runs, so a value rotated by hand via the AWS CLI or console (§5.3) doesn't get silently overwritten back to whatever is still sitting in `terraform.tfvars` the next time someone runs `terraform apply` for an unrelated change.

### 3.3 Wiring into the ECS task definition

```hcl
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
```
`infra/modules/ecs/main.tf:102-160`

Note the two blocks sit side by side in the same `container_definitions` entry, and they are structurally different mechanisms, not just a naming convention: `environment` entries carry a literal `value` known at plan time; `secrets` entries carry a `valueFrom` ARN that is resolved by the ECS agent at container start, described next.

### 3.4 The module invocation that ties the KMS key to the ECS role

```hcl
module "parameter_store" {
  source = "../../modules/parameter-store"

  project_name   = var.project_name
  environment    = var.environment
  create_kms_key = var.create_parameter_store_kms_key
  kms_key_arn    = var.kms_key_arn

  # Goes into the CMK's key policy so tasks can actually decrypt their secrets
  # at startup. A KMS key policy is authoritative: an IAM policy alone is not
  # enough to grant access to a customer-managed key.
  ecs_task_execution_role_arn = module.iam.ecs_task_execution_role_arn

  mongo_uri                    = var.mongo_uri
  jwt_access_token_secret      = var.jwt_access_token_secret
  jwt_access_token_expires_in  = var.jwt_access_token_expires_in
  jwt_refresh_token_secret     = var.jwt_refresh_token_secret
  jwt_refresh_token_expires_in = var.jwt_refresh_token_expires_in
  google_client_id             = var.google_client_id
  google_client_secret         = var.google_client_secret

  # AUTOMATED URLS
  google_callback_url          = local.google_callback_url
  frontend_origin              = local.frontend_url
  frontend_google_callback_url = local.frontend_google_callback_url
  vite_api_base_url            = local.api_base_url
  cookie_domain                = local.cookie_domain

  node_env = var.node_env
  port     = tostring(var.app_port)

  common_tags = local.common_tags
  depends_on  = [module.acm, aws_lb_listener.https]
}
```
`infra/environments/dev/main.tf:337-370`

Two dependency facts embedded in this block matter for understanding the module graph. First, `ecs_task_execution_role_arn` comes from `module.iam` specifically so the KMS key policy in §3.1 can name that exact role — this module needs IAM's output, not the reverse, so `module.iam` must exist first. Second, the `depends_on = [module.acm, aws_lb_listener.https]` forces Terraform to wait for the HTTPS listener and the ACM module (see [file 08](./08-tls-and-certificate-management.md)) to exist before writing parameters, because several of the values being written — `frontend_url`, `api_base_url`, `google_callback_url`, `cookie_domain` — are themselves computed from the ALB's and CloudFront's resulting DNS names:

```hcl
alb_base_url = var.enable_https ? "https://${module.alb.alb_dns_name}" : "http://${module.alb.alb_dns_name}"
api_base_url = "${local.alb_base_url}/api"
frontend_url = "https://${module.cloudfront_s3.distribution_domain_name}"

google_callback_url          = "${local.api_base_url}/auth/google/callback"
frontend_google_callback_url = "${local.frontend_url}/google/callback"

cookie_domain = module.alb.alb_dns_name
```
`infra/environments/dev/main.tf:85-95`

There is no way to compute these URLs before the load balancer and distribution exist, so Parameter Store is necessarily one of the later modules in the apply graph, not one of the first.

---

## 4. Request/Data Flow

Tracing the full path a secret takes from a human's keyboard to a running process's memory, tying each step back to the code above:

1. **A human edits `terraform.tfvars` locally.** This file (gitignored — see §6.1) holds the actual secret values: the real Mongo URI, the real JWT secrets, the real Google OAuth client secret. Nothing upstream of this file is where the secret "lives" in any authoritative sense — this is the source of truth for what gets written into AWS.

2. **`terraform apply` runs the `parameter-store` module.** Terraform reads each `var.mongo_uri`, `var.jwt_access_token_secret`, etc. from the resolved `tfvars`, and for each `aws_ssm_parameter` resource with `type = "SecureString"`, calls the SSM `PutParameter` API with `key_id` set to the customer-managed key's ARN (`local.parameter_kms_key_id`, `infra/modules/parameter-store/main.tf:93-102`). AWS SSM, using that KMS key, encrypts the value before it's written to Parameter Store's backing storage. The plain `String` parameters are written unencrypted, since they carry no confidential content.

3. **Fargate starts a new task** — a fresh deploy, an autoscaling event, or a failed-health-check replacement (see [file 06](./06-compute-and-container-orchestration-ecs-fargate.md)). Before the container's entrypoint ever runs, the ECS agent resolves every entry in that task definition's `secrets` array (§3.3). Critically, this resolution happens using the task's **execution role**, not its **task role** — the execution role is the identity ECS itself assumes to prepare a task to run (pull the image, write logs, fetch secrets); the task role is the identity the application code inside the container assumes for its own AWS calls. These are deliberately separate roles with separate trust boundaries (see [file 04](./04-identity-and-access-management.md) for the full split) — a design that means "can this container start" and "what can code inside this container do once running" are two independent permission surfaces.

4. **The execution role calls SSM `GetParameters`** (with `WithDecryption: true`, implicitly, for `SecureString` entries) against each `valueFrom` ARN. This call succeeds only because two separate things both said yes: the execution role's own IAM policy allows `ssm:GetParameters` on that parameter path (see [file 04](./04-identity-and-access-management.md)), and the KMS key policy's `AllowECSExecutionRoleDecrypt` statement (§3.1) names this exact role as allowed to `kms:Decrypt` — via SSM specifically, per the `kms:ViaService` condition. Miss either one and the task fails to launch.

5. **SSM decrypts the `SecureString` value using the KMS key**, and returns the plaintext value to the ECS agent as part of the `GetParameters` response. This is the one moment the ciphertext-to-plaintext conversion happens — it does not happen anywhere else in the pipeline, and it never touches disk.

6. **The ECS agent injects the decrypted value as a plain environment variable inside the container process**, exactly as if it had been written directly into the task definition's `environment` block. From this point on, there is no meaningful difference between how `MONGO_URI` (a `secrets` entry) and `NODE_ENV` (an `environment` entry) appear to the running process — both are just `process.env.X`.

7. **Application code reads `process.env.MONGO_URI`, `process.env.JWT_ACCESS_TOKEN_SECRET`, etc., with zero AWS-specific code anywhere in the backend.** The entire secrets-fetching mechanism — KMS, SSM, IAM, the execution-role/task-role split — lives entirely in the platform layer (Terraform + ECS), and the application layer's contract with it is nothing more exotic than reading an environment variable. This is a real, deliberate benefit: the same backend code runs unmodified in local development against a plain `.env` file, because from `process.env`'s point of view, "a human typed this into a `.env` file" and "ECS resolved this from an encrypted Parameter Store value ten milliseconds before the process started" are indistinguishable.

---

## 5. Design Decisions & Tradeoffs

### 5.1 Parameter Store over Secrets Manager

AstriX gave up Secrets Manager's built-in rotation *scheduling* — a rotation Lambda AWS invokes on a timer to actually change a credential's value automatically — to avoid Secrets Manager's per-secret-per-month cost. With four `SecureString` values in play (Mongo URI, two JWT secrets, Google client secret), that's a small but real recurring cost difference at this scale, and Parameter Store's `SecureString` gives the same encryption-at-rest and IAM-gated-read properties for effectively free (beyond the ~$1/month KMS key itself, called out directly in the module: `infra/modules/parameter-store/main.tf:27-28`). For a single-environment project without a compliance mandate for automated rotation, this is a defensible, nameable tradeoff — not a free lunch, since it means rotation has to be a human-run runbook (§5.3) instead of a scheduled pipeline, but a reasonable one at this project's size.

### 5.2 Why a customer-managed KMS key instead of the default `alias/aws/ssm`

The module's own comment states the rationale directly and it's worth repeating in full, because it's the crux of the whole KMS design:

> Falling back to the AWS-managed `alias/aws/ssm` key is free, but it is shared with every other SSM consumer in the account and its key policy cannot be edited — so "who may decrypt these secrets" collapses into "who has any SSM permission". A customer-managed key makes that an explicit, auditable decision (and shows up per-key in CloudTrail).
>
> `infra/modules/parameter-store/main.tf:21-25`

The `environments/dev` variable that toggles this makes the same point from the IAM side:

> Defaults to true: the AWS-managed alias/aws/ssm key has an uneditable key policy, so with it "who can decrypt these secrets" is decided entirely by IAM, and the ECS execution role's kms:Decrypt grant has to fall back to Resource = "*". A CMK makes that a single named key.
>
> `infra/environments/dev/variables.tf:206-217`

Concretely: with the AWS-managed key, the IAM side of the DecryptSecrets statement in `infra/modules/iam/main.tf:99-113` (cross-referenced, not re-derived here — see [file 04](./04-identity-and-access-management.md) for the full IAM policy) has no key ARN to scope to, so it falls back to `Resource = ["*"]` — meaning the IAM policy alone is the only thing standing between the execution role and *every* KMS key in the account it could otherwise touch. With a customer-managed key, that same statement scopes to `[var.kms_key_arn]`, a single named resource, and the key's own policy provides a second, independent gate on top of IAM. Two layers, one policy that's actually inspectable and auditable per-key in CloudTrail, versus one layer with a wildcard resource.

### 5.3 Manual rotation, not an automated pipeline

`infra/README.md`'s Secrets section documents the actual runbook AstriX follows, and it's worth teaching directly rather than paraphrased, because the *order* of steps is the entire point:

1. Update the value in the external system first — Atlas (for `MONGO_URI`), Google Cloud Console (for the OAuth client secret), or generate a new value locally (for a JWT secret).
2. Update `terraform.tfvars` with the new value.
3. Run `terraform apply` so the new value gets written into Parameter Store, encrypted under the same KMS key as before.
4. Confirm the new deploy actually picked up the new value — a running ECS task that started *before* step 3 is still holding the *old* value in its environment, since secrets are resolved once, at container start, not re-fetched live (see §4, step 6). Only a task that starts after the new `PutParameter` call will resolve the new value.
5. Only then revoke the old value at the source (disable the old Atlas user, invalidate the old Google client secret, etc.).

The reason step 5 comes dead last, and not earlier, is the same reason step 4 exists at all: ECS resolves `secrets[].valueFrom` once, at task start — there is no live "push" from Parameter Store into a running container. If the old credential is revoked before every task has actually been replaced by one that started after step 3, any task still running the old value starts throwing authentication failures against the external system mid-flight, which is a self-inflicted outage with no rollback path except reverting the external-system change again. Rotation-order mistakes like this are a genuinely common way rotation runbooks cause the exact outage they were trying to prevent — the fix is always "verify the new value is live everywhere it needs to be before you make the old value unusable anywhere."

---

## 6. Security Considerations

### 6.1 `terraform.tfvars` as the real source of truth, and why it must stay out of git

Every secret value that ends up encrypted in Parameter Store started as plaintext in `terraform.tfvars` on whoever's machine ran `terraform apply`. That file is what actually needs protecting — Parameter Store is just where the value ends up, not where it originates. The repo's root `.gitignore` confirms the file is excluded:

```gitignore
*.tfvars
```
`.gitignore:29`

along with explicit carve-outs for backup files so a stray `terraform.tfvars.backup.*` doesn't accidentally get committed either (`.gitignore:30-34`). This matters because a `tfvars` file holding real secret values is functionally a plaintext secrets dump — anyone who can read it can read every Mongo credential and JWT signing key the backend trusts, with no encryption, no IAM gate, no audit trail. Committing it, even to a private repo, means every future clone, every CI runner checkout, and every fork carries those values indefinitely in git history, recoverable even after the file is later deleted from `HEAD`.

### 6.2 `environment` (plaintext) vs. `secrets` (valueFrom) — the same container definition, two different guarantees

Section 3.3 above shows both blocks sitting in the same `container_definitions` entry, and the distinction is the security-relevant one. `environment` entries (`infra/modules/ecs/main.tf:103-112`, `PORT` and `NODE_ENV`) carry their value as a literal string baked directly into the registered task definition — visible to anyone who can call `DescribeTaskDefinition`, visible in the ECS console, visible in Terraform state as plaintext. `secrets` entries (`infra/modules/ecs/main.tf:115-160`) carry only an ARN; the actual value never appears in the task definition, the ECS console, or (for the `SecureString` parameters specifically) Terraform state in plaintext form. Putting `MONGO_URI` in the `environment` block instead of `secrets` — an easy mistake for someone unfamiliar with the distinction, since both blocks accept a `name`/value pair and both end up as `process.env.X` inside the container — would silently downgrade a KMS-encrypted, IAM-gated secret into a value anyone with read access to the task definition can see directly, with none of the protections described in this file actually applying.

### 6.3 The `kms:ViaService` condition

Briefly, since [file 04](./04-identity-and-access-management.md) owns IAM mechanics in depth: both the KMS key policy's `AllowECSExecutionRoleDecrypt` statement (§3.1) and the execution role's own IAM `DecryptSecrets` statement (`infra/modules/iam/main.tf:99-113`) condition the decrypt grant on `kms:ViaService = ssm.<region>.amazonaws.com`. This is what keeps the grant scoped to *only* calls SSM makes on the role's behalf — the execution role's credentials, even if exfiltrated, cannot be used to call `kms:Decrypt` directly against this key from outside an SSM API call. Without this condition, a leaked execution-role credential could decrypt anything else protected by the same key, by any means, not just secrets fetched through Parameter Store.

### 6.4 `sensitive = true` and what it actually prevents

Terraform's `sensitive` attribute on a variable suppresses that variable's value from appearing in `terraform plan`/`apply` console output and from being echoed back in error messages — a real, useful protection against a secret ending up in a CI log or a terminal scrollback that later gets pasted somewhere. Checking `infra/environments/dev/variables.tf` directly confirms this is actually set on every secret-bearing variable that flows into the `parameter-store` module:

```hcl
variable "mongo_uri" {
  description = "MongoDB connection URI"
  type        = string
  sensitive   = true
}

variable "jwt_access_token_secret" {
  description = "JWT access token secret key"
  type        = string
  sensitive   = true
}

variable "jwt_refresh_token_secret" {
  description = "JWT refresh token secret key"
  type        = string
  sensitive   = true
}

variable "google_client_secret" {
  description = "Google OAuth client secret"
  type        = string
  sensitive   = true
}
```
`infra/environments/dev/variables.tf:222-260`

Worth being precise about what this does and doesn't protect against, since `sensitive = true` is easy to over-trust: it prevents the value from being *printed* by Terraform's own CLI output. It does **not** encrypt the value inside the Terraform state file — a `sensitive` variable's actual value is still stored in plaintext in `terraform.tfstate`, which is why the state backend's own access controls and encryption (S3 bucket encryption, restricted IAM access to the state bucket — see [file 11](./11-infrastructure-as-code-with-terraform.md)) matter just as much as the `sensitive` flag itself. `sensitive = true` is a UI/output safeguard, not a storage-encryption mechanism.

---

## 7. Best Practice Check

**Manual rotation vs. automated rotation.** Current (2026) industry practice treats fully automated rotation — a scheduled Lambda that both generates a new credential *and* updates the store, with no human step in between — as the stricter standard for high-security environments: financial systems, anything under PCI-DSS or SOC 2 scrutiny with rotation-interval requirements, or any team large enough that "did someone actually run the runbook this quarter" is a real question rather than a rhetorical one. AstriX's runbook-based manual rotation (§5.3) is a real, honest gap against that stricter bar — there is no scheduled enforcement that rotation happens at all, only a documented process for *if and when* someone runs it. That said, for a single-environment project at this scale, a well-documented, correctly-ordered manual runbook is a common and broadly accepted middle ground, provided — and this is the load-bearing condition — the runbook is actually followed on some cadence rather than existing only for the rare "we think this leaked" moment. The gap is worth naming plainly rather than treated as equivalent to automation: manual rotation that only ever happens reactively (after a suspected leak) is meaningfully weaker than rotation that happens proactively on a schedule, automated or not.

**`terraform.tfvars` as a single local source of truth.** This is a real, structural operational dependency: whoever runs `terraform apply` for this stack must have the actual plaintext secret values sitting on their machine (or wherever the apply runs from) at the moment they run it — there is no external secret source Terraform pulls from at apply-time instead. That's a genuine gap relative to more mature setups, where Terraform reads secret values from Vault or Secrets Manager via a data source at apply-time (e.g. `data "aws_secretsmanager_secret_version"`) rather than taking them as local `tfvars` input, so no human machine ever needs to hold the plaintext value directly. Checking whether AstriX at least documents what's required: `infra/environments/dev/terraform.tfvars.example` does exist and is a real, filled-out template — every variable a real `terraform.tfvars` needs is present with either a safe placeholder or an explicit `CHANGE_ME` marker on the genuinely sensitive fields (`mongo_uri`, `jwt_access_token_secret`, `jwt_refresh_token_secret`, `google_client_id`, `google_client_secret`), plus a comment noting the file itself is "safe to commit" specifically because every value in it is a placeholder. That's the right shape for onboarding a new contributor — it tells them exactly which keys they need to obtain values for without ever holding a real value itself — but it doesn't change the underlying fact that the *live* secret values still have to land on a real human's disk before `terraform apply` can use them. That's a reasonable tradeoff for a small team where "who has the tfvars file" is a known, short list, and a real scaling concern the moment that list gets longer or less trusted.

---

## 8. Debug Drill

**Scenario:** a newly deployed ECS task fails to start, and the ECS console shows a stopped task with a reason mentioning a failure resolving a secret from Parameter Store — or, less obviously, the task *does* start, but the application immediately crashes with an error about an undefined or missing environment variable. Where do you look, in order, and why?

1. **Read the exact stopped-task reason first.** ECS surfaces a specific error class for secret-resolution failures — something like `ResourceInitializationError` referencing SSM or KMS — versus a generic task failure. If the reason explicitly names Parameter Store or KMS, the problem is almost certainly in the secrets-resolution path (steps 2–4 below), not in the application code itself. If the task starts and only the application crashes with `undefined`, the problem shifted from "ECS couldn't fetch a secret" to "ECS fetched everything it was told to, but the app expected something ECS wasn't told about" (step 5).

2. **Confirm the parameter actually exists at the exact path the `valueFrom` ARN names.** The ARN pattern is built by string interpolation — `arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/<NAME>` (`infra/modules/ecs/main.tf:118` and siblings) — which means a typo in any of `project_name`, `environment`, or the parameter name itself, on either the `parameter-store` module side or the `ecs` module side, produces an ARN that points at a parameter that doesn't exist. `aws ssm get-parameters-by-path --path /astrix/dev --recursive` (the same command the module's own `cli_commands` output documents, `infra/modules/parameter-store/outputs.tf:137-144`) is the fastest way to confirm the exact set of parameters that actually exist versus what the task definition expects.

3. **Check both halves of the decrypt grant independently.** A secret-resolution failure that specifically mentions KMS or `AccessDenied` rather than "parameter not found" means the parameter exists but couldn't be decrypted — which requires checking two separate policies, not one: the execution role's own IAM policy (does it grant `ssm:GetParameters` on this path, and `kms:Decrypt` on this key?) and the KMS key's own policy (does its `AllowECSExecutionRoleDecrypt` statement, §3.1, actually name this execution role's current ARN?). Because a customer-managed key's policy is authoritative independent of IAM, a correct IAM policy paired with a key policy that still names an old or wrong role ARN — say, after a Terraform refactor that recreated the execution role — fails exactly this way, and looking at only one of the two policies gives an incomplete picture.

4. **Check the `kms:ViaService` condition isn't being violated by how the call is made.** This is a less common but real failure mode: if anything in the pipeline calls KMS directly rather than through SSM's own internal call path — for instance, a debugging script that tries to `kms:Decrypt` the raw ciphertext itself instead of going through `ssm get-parameter --with-decryption` — the `ViaService` condition denies it, which can look identical to a broken policy from the caller's point of view even though the policy is correct and working exactly as designed for its intended caller.

5. **If the task starts fine but the app crashes on a specific missing variable, check whether the parameter and the `secrets` block reference are actually in sync.** A common way this breaks: a new required environment variable gets added to the application code (say, a new `SOME_NEW_API_KEY`), but only the code and maybe a local `.env.example` get updated — nobody adds a corresponding `aws_ssm_parameter` resource in the `parameter-store` module *and* a matching `secrets` entry in the `ecs` module's task definition. The app compiles and deploys fine (Terraform has no way to know the application layer expects this variable), and the failure only shows up at runtime, inside the container, as `process.env.SOME_NEW_API_KEY` being `undefined` — a purely application-side symptom for a purely infrastructure-side gap. The fix requires touching three places in sync: the Parameter Store resource, the ECS task definition's `secrets` array, and the variable wiring in the environment's `main.tf` module call — missing any one of the three reproduces this exact symptom.

The general principle across all five: a secrets-resolution failure is almost always a *mismatch* between two things that both need to agree — the exact parameter path SSM has vs. the exact ARN the task definition constructs, or the exact role ARN the key policy names vs. the exact role ARN currently deployed — rather than a single misconfigured value in isolation. Find the two sides of the comparison first, then compare them directly, rather than guessing at which side is wrong.
