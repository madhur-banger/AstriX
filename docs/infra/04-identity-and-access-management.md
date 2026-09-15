# Identity and Access Management (IAM)

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md).

Every other file in this module answers "what AWS resource does this?" This one answers a different question: once that resource exists, *who is allowed to touch it, and how do they prove who they are?* That question sits underneath everything else — a perfectly-networked VPC and a perfectly-configured ECS service are both worthless the moment the wrong caller can assume a role that reaches into either of them. Identity and access management is the layer that decides which callers exist, what each caller can present as proof of identity, and what that proof entitles them to do.

AstriX's `infra/modules/iam/` module creates four IAM roles — an ECS task execution role, an ECS task role, a Lambda execution role, and a GitHub Actions deployment role — plus the OIDC trust relationship that lets GitHub issue that last role. This chapter covers the ECS role pair and the GitHub Actions/OIDC pair in depth, because those are the two places AstriX had a real *choice* to make about how a workload proves its identity to AWS. (The Lambda execution role follows the same shape as the ECS task role and isn't a separate design decision — it's covered by implication.)

---

## 1. The Landscape

"How does a piece of software prove to AWS it's allowed to call an API" has exactly the same shape whether the caller is a long-running server, a CI pipeline, or a human at a laptop: something has to hand AWS's STS (Security Token Service) a credential, and STS decides whether to honor it. The interesting differences are in *what* that credential is, *how long* it lives, and *where* it has to be stored in the meantime. Four real, named patterns dominate how this gets solved in practice.

### (a) Long-lived IAM user access keys

The oldest pattern, and still extremely common in smaller shops and legacy pipelines: create an `aws_iam_user`, generate an access key ID and secret access key for it, and paste that pair into wherever the workload runs — a GitHub Actions secret, a `.env` file, a Jenkins credential store. The workload's AWS SDK picks the pair up from environment variables (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) and signs every request with it.

```yaml
# illustrative GitHub Actions step — not AstriX's actual workflow
- name: Configure AWS credentials
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
  run: aws s3 sync ./dist s3://my-bucket
```

**Tradeoffs:** it's the simplest thing that works — no trust policy to reason about, no federation setup, any SDK anywhere understands it out of the box. The real cost is that the credential is *standing* and *portable*: it doesn't expire on its own (AWS access keys have no built-in TTL), it's usable from any machine on the internet that has the two strings, and if it leaks — committed to a repo, printed in a build log, pulled from a compromised CI runner's environment — the attacker has account access that lasts until a human notices and manually rotates or deletes the key. Key rotation is a manual, easy-to-neglect operational task rather than something that happens for free.

### (b) Instance/task roles with automatically-issued temporary credentials

AWS's answer to "stop putting long-lived keys on servers": attach an IAM role to the *compute resource itself* — an EC2 instance profile, an ECS task role — and let the platform's metadata service hand the process temporary, auto-rotating STS credentials with no human or pipeline ever typing a secret anywhere. The AWS SDK, when it finds no static credentials configured, automatically checks the instance/task metadata endpoint and uses whatever it finds there.

```bash
# what the ECS agent does on the container's behalf — not code you write
curl 169.254.170.2$AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
# -> { "AccessKeyId": "...", "SecretAccessKey": "...", "Token": "...", "Expiration": "..." }
```

**Tradeoffs:** no long-lived credential ever exists anywhere — not in a secret store, not on disk, not in an image. Credentials are scoped to a single role, auto-rotate roughly hourly, and vanish when the instance/task terminates. The cost is that this pattern only works for compute AWS itself is running (EC2, ECS, Lambda, and similar) — it doesn't help a laptop, an on-prem server, or a third-party CI provider that isn't "inside" AWS's own metadata plane.

### (c) OIDC federation for CI/CD

For exactly the case (b) doesn't cover — a pipeline running on infrastructure AWS doesn't own, like GitHub Actions' or GitLab CI's hosted runners — OIDC (OpenID Connect) federation extends the same "no standing credential" idea across that trust boundary. The CI platform's own identity provider signs a short-lived JSON Web Token asserting facts about the specific job run ("this is a run of `owner/repo` on branch `main`, triggered by a push, expiring in minutes"), and the pipeline exchanges that token with AWS STS for temporary credentials — no access key is ever generated, stored as a secret, or capable of outliving the job. This is the pattern AstriX uses for its GitHub Actions role, covered in depth below.

**Tradeoffs:** it eliminates the entire "leaked long-lived secret" risk class for CI/CD specifically, at the cost of a trust policy that has to be reasoned about carefully — the token's claims (issuer, audience, subject) are the *entire* security boundary, so a loosely-written condition can accidentally trust more callers than intended. It also requires the CI platform to support OIDC token issuance at all (GitHub Actions, GitLab CI, CircleCI, and Buildkite all do; some older or self-hosted CI systems don't).

### (d) Centralized identity broker / SSO for human access

Distinct from all three above, which are about *workload* access, is how *humans* — engineers, on-call responders, auditors — get into an AWS account. The current standard pattern is a centralized identity broker: AWS IAM Identity Center (formerly AWS SSO), or a third-party identity provider like Okta or Azure AD federated into AWS via SAML, issues a person a role session after they authenticate once (often with SSO + MFA) against a corporate identity source, rather than that person ever holding an IAM user or a static key at all. A person picks an account and a role from a portal; the broker mints temporary credentials for that session.

**Tradeoffs:** centralizes user lifecycle management — disable someone in the identity provider once, and their access to every federated AWS account disappears at once, which is the opposite of manually deleting IAM users account-by-account. It's the right tool for human, interactive access across many accounts and many people, but it solves a different problem than (a)–(c): it doesn't help a workload or a pipeline authenticate itself, and it's typically overkill for a single-developer or single-account setup. AstriX doesn't use this pattern at all — it's a single-environment project accessed directly, not multi-account with a human-access broker — but it's worth naming because it's the dominant answer to "how do people, as opposed to code, get into AWS" in any org past a certain size.

---

## 2. AstriX's Choice

AstriX splits its identity story in two, by workload type. For its own running application — the ECS Fargate service — it uses pattern (b): a **task execution role** and a separate **task role**, both assumed automatically by the ECS agent with no credential ever stored anywhere. For its CI/CD pipeline — GitHub Actions — it uses pattern (c): a dedicated **GitHub Actions OIDC provider and deployment role**, so no AWS access key ever exists as a GitHub secret. Pattern (a) — long-lived IAM user keys — is not used anywhere in this module, and pattern (d) doesn't apply because there is no multi-account, multi-human access story here.

---

## 3. AstriX Implementation

### 3.1 The ECS task execution role

This role is assumed by the ECS *agent* — the control-plane process that starts your container — not by your application code. Its job is entirely pre-flight: pull the image from ECR, write the container's logs to CloudWatch, and fetch whatever secrets the task definition asks for before your code's first line ever runs.

```hcl
# infra/modules/iam/main.tf:46-65
resource "aws_iam_role" "ecs_task_execution" {
  name = "${var.project_name}-${var.environment}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-ecs-execution-role"
  })
}
```

The trust policy's `Principal` is the AWS service `ecs-tasks.amazonaws.com` — this is a service role, not a federated or user-assumed one, so only the ECS control plane itself can ever assume it. On top of the AWS-managed `AmazonECSTaskExecutionRolePolicy` (attached separately at `infra/modules/iam/main.tf:68-71`, covering ECR pull and CloudWatch Logs), the module adds one inline policy scoping exactly what secrets this role can decrypt:

```hcl
# infra/modules/iam/main.tf:73-113
resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name = "${var.project_name}-${var.environment}-ecs-execution-secrets"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "GetSecrets"
        Effect = "Allow"
        Action = [
          "ssm:GetParameters",
          "ssm:GetParameter",
          "ssm:GetParametersByPath"
        ]
        Resource = [
          "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.environment}/*"
        ]
      },
      # Scoped to the Parameter Store CMK (threaded in from the parameter-store
      # module by environments/dev/main.tf). The "*" fallback only applies when
      # no CMK exists - the AWS-managed alias/aws/ssm key has no stable ARN to
      # name here - and even then the ViaService condition confines this to
      # decrypt calls made through SSM.
      {
        Sid    = "DecryptSecrets"
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = var.kms_key_arn != null ? [var.kms_key_arn] : ["*"]
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}
```

Two things are worth reading closely here. First, `GetSecrets` is scoped by resource ARN pattern to exactly this project's and environment's parameter path — `parameter/${var.project_name}/${var.environment}/*` — so this role cannot read another environment's or another project's parameters even if they live in the same AWS account. Second, `DecryptSecrets` prefers a real customer-managed KMS key ARN, threaded in as `var.kms_key_arn`, and only falls back to `"*"` when no such key exists — and even in that fallback case, the `kms:ViaService` condition means the decrypt permission is only usable when the calling service is SSM. That condition is doing real work: without it, a `"*"`-resource KMS decrypt permission would let this role decrypt *any* KMS-encrypted object the key policy allows, not just Parameter Store values it's fetching as part of task startup.

### 3.2 The ECS task role

Where the execution role is "can the platform run this container," the task role is "what can the *running application* do once it's up." It's assumed by the same trust principal — `ecs-tasks.amazonaws.com` — but it's a structurally separate role with its own, much broader, policy:

```hcl
# infra/modules/iam/main.tf:121-140
resource "aws_iam_role" "ecs_task" {
  name = "${var.project_name}-${var.environment}-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-ecs-task-role"
  })
}
```

Its inline policy is what the application actually gets to call at runtime:

```hcl
# infra/modules/iam/main.tf:144-234
resource "aws_iam_role_policy" "ecs_task_app_permissions" {
  name = "${var.project_name}-${var.environment}-ecs-task-app-policy"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # SNS: Publish events
      {
        Sid    = "SNSPublish"
        Effect = "Allow"
        Action = [
          "sns:Publish"
        ]
        Resource = [
          "arn:aws:sns:${var.aws_region}:${var.aws_account_id}:${var.project_name}-${var.environment}-*"
        ]
      },
      # SQS: Read from queues (if needed for consumer pattern)
      {
        Sid    = "SQSAccess"
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = [
          "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${var.project_name}-${var.environment}-*"
        ]
      },
      # S3: File uploads/downloads
      {
        Sid    = "S3Access"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          "arn:aws:s3:::${var.project_name}-${var.environment}-*",
          "arn:aws:s3:::${var.project_name}-${var.environment}-*/*"
        ]
      },
      # DynamoDB: Activity logs, notifications
      {
        Sid    = "DynamoDBAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = [
          "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${var.project_name}-${var.environment}-*",
          "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${var.project_name}-${var.environment}-*/index/*"
        ]
      },
      # CloudWatch: Custom metrics
      {
        Sid    = "CloudWatchMetrics"
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "cloudwatch:namespace" = "${var.project_name}/${var.environment}"
          }
        }
      },
      # X-Ray: Tracing (optional but recommended)
      {
        Sid    = "XRayTracing"
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords"
        ]
        Resource = "*"
      }
    ]
  })
}
```

Every resource-scoped statement here follows the same shape: `${var.project_name}-${var.environment}-*`, so the application role can only touch SNS topics, SQS queues, S3 buckets, and DynamoDB tables that belong to this exact project and environment. The two `Resource = "*"` statements (`CloudWatchMetrics`, `XRayTracing`) aren't a scoping shortcut — `PutMetricData` and X-Ray's trace-ingestion APIs are both actions AWS's IAM implementation genuinely does not support resource-level scoping for, so `"*"` is the only value IAM will accept for the `Resource` field at all. `CloudWatchMetrics` narrows what it can by the only lever available — a `cloudwatch:namespace` condition — so at least the metrics this role emits are confined to this project/environment's namespace, even though the API call itself can't be pinned to an ARN.

### 3.3 The GitHub Actions OIDC provider and deployment role

The OIDC provider resource is what establishes AWS's trust in GitHub's token issuer at all:

```hcl
# infra/modules/iam/main.tf:376-389
resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc ? 1 : 0

  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]

  # GitHub's OIDC thumbprint
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-github-oidc-provider"
  })
}
```

`url` names GitHub's token issuer; `client_id_list` restricts which audiences AWS will accept tokens for (`sts.amazonaws.com` — the value `aws-actions/configure-aws-credentials` puts in the token's `aud` claim); `thumbprint_list` is a certificate-chain fingerprint AWS uses to validate GitHub's TLS certificate when fetching its signing keys.

The role that trusts this provider is where the actual authorization boundary lives:

```hcl
# infra/modules/iam/main.tf:397-436
resource "aws_iam_role" "github_actions" {
  count = var.create_github_oidc ? 1 : 0

  name = "${var.project_name}-${var.environment}-github-actions-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github[0].arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            # Scoped to main only - every workflow that assumes this role
            # (deploy-backend, deploy-frontend, rollback, infra) triggers on
            # push to main or workflow_dispatch, and GitHub's OIDC "sub"
            # claim for a manually-dispatched run is still
            # "ref:refs/heads/<branch>" for the branch selected in the
            # dispatch UI - so this also covers workflow_dispatch runs off
            # main, just not off other branches. Add another entry to this
            # list if a workflow genuinely needs to deploy from elsewhere.
            "token.actions.githubusercontent.com:sub" = [
              "repo:${var.github_org}/${var.github_repo}:ref:refs/heads/main"
            ]
          }
        }
      }
    ]
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-github-actions-role"
  })
}
```

Note this role's `Principal` is `Federated`, not `Service` — the caller isn't an AWS service, it's an external identity asserting a signed token, and `Action` is `sts:AssumeRoleWithWebIdentity` rather than plain `sts:AssumeRole`. Two conditions gate the assumption: `aud` must equal `sts.amazonaws.com`, and `sub` must match `repo:<org>/<repo>:ref:refs/heads/main` — nothing else. Every attribute of the caller — which repository, which branch, whether it's actually GitHub and not an impersonator — funnels through this one condition block.

Finally, one of the more surgically-scoped statements in the deployment policy, to show the least-privilege pattern in full — `ECSDeployService`, the permission that actually rolls out a new task definition:

```hcl
# infra/modules/iam/main.tf:473-486
# ECS: Deploy to this environment's service, and wait for it to
# stabilise. Scoped to the service ARN under this project's cluster so a
# leaked CI token cannot redeploy anything else in the account.
{
  Sid    = "ECSDeployService"
  Effect = "Allow"
  Action = [
    "ecs:UpdateService",
    "ecs:DescribeServices"
  ]
  Resource = [
    "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:service/${var.project_name}-${var.environment}-cluster/*"
  ]
}
```

And the `PassRole` statement, which is arguably the single highest-stakes line in the whole policy — it's what lets the CI pipeline hand the two ECS roles above to a task definition it's registering:

```hcl
# infra/modules/iam/main.tf:551-560
# ECS: Pass role to task
{
  Sid    = "PassRole"
  Effect = "Allow"
  Action = "iam:PassRole"
  Resource = [
    aws_iam_role.ecs_task_execution.arn,
    aws_iam_role.ecs_task.arn
  ]
}
```

`iam:PassRole` is the permission that turns "I can register a task definition" into "I can decide which role the task that runs from it gets" — an unscoped `PassRole` on a CI role is one of the more common privilege-escalation vectors in AWS, because it lets the CI pipeline hand out *any* role in the account, including ones far more powerful than itself. Here the `Resource` list names exactly two ARNs: the ECS execution role and the ECS task role defined earlier in this same module. The CI role cannot pass any other role in the account to anything, full stop.

Wiring it together, `environments/dev/main.tf` supplies this module's inputs, including a comment worth reading because it preempts a question any Terraform reviewer would ask:

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

The apparent cycle would be "IAM needs a KMS ARN from parameter-store, and parameter-store presumably needs a role ARN from IAM" — but Terraform builds its dependency graph at the *resource* level, not the module level, and the two edges that exist here (`module.iam` reading `module.parameter_store.kms_key_arn` for one specific inline policy resource) never form a loop back onto themselves. This is a useful thing to internalize generally: two modules can each consume an output of the other without creating a cycle, as long as the specific resources involved don't loop.

Finally, this is where the role actually gets consumed — one `configure-aws-credentials` step, repeated in every deploy workflow:

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

`permissions.id-token: write` is the workflow-level switch that lets GitHub actually mint an OIDC token for this job in the first place — without it, `configure-aws-credentials` has nothing to present to STS. `deploy-frontend.yml`, `infra.yml`, and `rollback.yml` all repeat this exact `role-to-assume` line, pointed at the same role; only the surrounding job's `environment:` gate differs (`production` for the three deploy/rollback workflows, `infra-apply` for `infra.yml`'s apply job).

---

## 4. Request/Data Flow

**Flow A — an ECS task getting credentials at runtime.** When Fargate starts a task, it injects an environment variable, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, into the container, pointing at a path on a link-local metadata address (`169.254.170.2`) that only that task can reach. The AWS SDK inside the application — whatever language, however it's configured — checks for this variable before falling back to any other credential source, and if present, requests credentials from that URL. The ECS agent, which itself already holds temporary credentials for the *task role* (obtained by assuming `aws_iam_role.ecs_task` on the task's behalf when it launched), serves back a short-lived access key, secret key, and session token scoped to exactly that role — typically valid for a few hours and auto-refreshed by the SDK well before expiry. No key is baked into the image, no key sits in an environment variable a `docker inspect` or a compromised dependency could read off disk; the credential exists only in memory, only for this task's lifetime, and only carries the permissions `aws_iam_role_policy.ecs_task_app_permissions` grants.

**Flow B — a GitHub Actions run authenticating to AWS with no stored key.** When the `Configure AWS credentials` step runs, `aws-actions/configure-aws-credentials` first asks GitHub's Actions runtime for an OIDC token, scoped to audience `sts.amazonaws.com` — this is what `permissions.id-token: write` authorizes the job to do. GitHub's OIDC token issuer (`token.actions.githubusercontent.com`) signs a JWT whose claims describe *this specific job run*: which repository, which ref, which workflow, which actor, an expiry a few minutes out. The action then calls AWS STS's `AssumeRoleWithWebIdentity` API, presenting that JWT and naming the target role ARN (`arn:.../astrix-dev-github-actions-role`, read from the `role-to-assume` input). AWS STS validates the JWT's signature against the OIDC provider's registered thumbprint, confirms the `aud` claim matches `sts.amazonaws.com` and the `sub` claim matches the `StringLike` pattern in the role's trust policy (`repo:<org>/<repo>:ref:refs/heads/main`), and — only if every condition holds — issues temporary STS credentials scoped to that role, valid for the duration configure-aws-credentials requests (an hour by default). Those credentials are exported as environment variables for the rest of the job's steps and are worthless the moment the job ends; there was never a moment where a durable AWS secret existed in a GitHub secret store, a workflow file, or a runner's disk.

---

## 5. Design Decisions & Tradeoffs

**Why two separate ECS roles instead of one.** The execution role answers "can the platform stand this container up" — pull the image, write logs, fetch the secrets the task definition names. The task role answers "what can the code running inside the container, once it's up, actually do." Collapsing these into one role would mean the running application inherits the execution role's permissions too — including `kms:Decrypt` against the Parameter Store CMK for *any* parameter under this environment's path, not just the specific values the application is supposed to read. If the application process is ever compromised (a dependency vulnerability, an RCE, a malicious package), the blast radius of that compromise is bounded by whichever role the attacker's code can actually reach through the metadata endpoint — and on AstriX, that's the task role's narrower SNS/SQS/S3/DynamoDB/CloudWatch/X-Ray surface, not the execution role's secret-decryption surface. The two-role split isn't decorative; it's the mechanism that keeps "the platform needed a secret to boot this container" and "my compromised app can now decrypt anything" from being the same fact.

**Why the GitHub Actions trust policy is scoped to `ref:refs/heads/main` specifically, and what that costs.** The module's own comment on this condition spells out a subtlety worth internalizing: a `workflow_dispatch` (manually-triggered) run does *not* get some special "manual dispatch" subject claim — GitHub's OIDC `sub` claim for a dispatch run still reflects `ref:refs/heads/<branch>` for whichever branch was selected in the dispatch UI. That's why scoping to `ref:refs/heads/main` alone is sufficient to cover both an ordinary `push`-triggered deploy and a manually dispatched one, as long as `main` is the branch selected either way. The real cost of this scoping is exactly what it looks like: a workflow run triggered from any other branch — a feature branch, a release branch, a fork — cannot assume this role at all, and will fail at the `AssumeRoleWithWebIdentity` step with an authorization error. That's a deliberate constraint, not an oversight: it means there is no path, accidental or otherwise, for a non-`main` branch's CI run to reach production AWS credentials. The cost is that any workflow which *does* legitimately need to deploy from a different ref (a staging branch, say) has to be added to the trust policy's `sub` list explicitly — it doesn't happen automatically just because someone points a new workflow file at this role.

**Why `PassRole` names exactly two ARNs instead of `*`.** `iam:PassRole` is unusual among IAM actions in that an overly broad grant of it doesn't just expose data — it can hand out *other, more powerful roles*. A CI pipeline with `PassRole: "*"` could register a task definition that runs with, say, an administrator role, provided one existed in the account, entirely independent of what the CI role's own policy otherwise allows. By naming exactly `aws_iam_role.ecs_task_execution.arn` and `aws_iam_role.ecs_task.arn`, the module guarantees that even a fully leaked GitHub Actions OIDC session (however briefly it lived) could only ever launch a task running as one of the two roles this same module already defined and reviewed — never an arbitrary role someone else in the account might create later.

---

## 6. Security Considerations

**OIDC federation removes a whole vulnerability class, not just one instance of it.** A long-lived IAM user access key stored as a GitHub secret is a single flat string that, once leaked — through a misconfigured log, a compromised Action, a committed `.env`, a supply-chain-compromised third-party Action — grants standing account access until someone notices and manually revokes it. There is no natural expiry, and the leaked credential works identically whether it's used one second or one year after the leak. An OIDC-derived STS credential leaked in exactly the same way is only ever useful for the remainder of that one job's short window (minutes to an hour); by the time anyone downstream could act on a leak, the credential has very likely already expired on its own. AstriX's `create_github_oidc` path means there is no AWS access key stored as a GitHub secret for deployment at all — the only thing that could leak is a token already narrowly scoped and already expiring.

**`kms:ViaService` as a specific containment technique.** The execution role's `DecryptSecrets` statement is a good worked example of a broader pattern: when a permission has to be broad on the `Resource` axis (here, the fallback `"*"` used only when no dedicated CMK exists), a `Condition` can still narrow it on a different axis. `kms:ViaService` confines the decrypt grant to calls that AWS itself attributes to the SSM service — meaning even in the fallback case, this role's KMS permission can't be used to decrypt some unrelated KMS-encrypted object directly via the KMS API; it only fires as a side effect of an SSM `GetParameter` call. This is worth remembering as a general technique any time a `Resource: "*"` feels uncomfortably broad: check whether a service-scoping condition key exists for that action before accepting the wildcard as the ceiling of what you can do.

**The `Resource = "*"` statements in the GitHub Actions policy are a documented AWS limitation, not sloppy scoping.** `ECSTaskDefinitionNoResourceLevel` covers `ecs:DescribeTaskDefinition` and `ecs:DeregisterTaskDefinition`, and its own comment states the reason plainly: AWS's IAM implementation does not support resource-level permissions for either action at all — the Service Authorization Reference lists no resource type for them, so any attempt to scope them to a task-definition ARN would simply be rejected by IAM, not silently narrowed. `"*"` here isn't a shortcut taken instead of scoping; it's the only value IAM accepts. The same logic applies to `ECSListTasks`, whose only documented resource type is `container-instance` — a concept that doesn't exist on Fargate at all — so that statement uses an `ecs:cluster` `Condition` (`ArnEquals` against this project's cluster ARN) as the actual scoping mechanism instead of the `Resource` field. What mitigates the residual risk in the task-definition case specifically: both actions are read-only or deregister-only. `DescribeTaskDefinition` can't mutate anything, and `DeregisterTaskDefinition` removes a *revision* from being launchable in the future — neither one can start, stop, or modify a running task, and neither can be turned into a path to running attacker-controlled code the way, say, an unscoped `RunTask` or `PassRole` could.

**What this module doesn't cover.** Nothing in this module addresses human/console access to the AWS account itself — there's no IAM Identity Center or SSO configuration here, and (per the landscape survey above) that's a different problem than workload identity. It's worth naming as a boundary rather than an oversight: this file, and the module it documents, is entirely about how *software* proves itself to AWS, not how the humans operating the account do.

---

## 7. Best Practice Check

OIDC federation for CI/CD over stored, long-lived access keys is unambiguously current (2026) industry-standard practice, and has been recommended by AWS itself (and mirrored by GitHub's own documentation) for several years now — there's no credible argument for preferring static keys in a greenfield setup at this point. AstriX matches this standard exactly: no AWS access key exists as a GitHub secret anywhere in this repository's CI configuration, and every deploy-capable workflow authenticates via `AssumeRoleWithWebIdentity`.

Scoping the trust policy's `sub` condition to a single branch (`ref:refs/heads/main`) is a reasonable baseline and meaningfully better than no branch scoping at all, but reading the trust policy closely against how this repo actually uses GitHub Environments surfaces a real gap worth naming precisely. `deploy-backend.yml`, `deploy-frontend.yml`, and `rollback.yml` all set `environment: production` on their deploy jobs, and `infra.yml`'s apply job sets `environment: infra-apply` — both are real GitHub Environments configured as manual-approval gates, meaning a human has to click "approve" before either job's steps execute. GitHub's OIDC token format supports encoding that same environment name directly into the `sub` claim, as `repo:<org>/<repo>:environment:<name>` — and current (2026) best practice for exactly this setup is to condition the IAM trust policy on that environment-scoped subject instead of (or in addition to) the branch-scoped one, so that the IAM layer itself enforces "only a run against the approved environment can assume this role," not just the GitHub UI's approval gate. Re-reading the trust policy block in `infra/modules/iam/main.tf:411-428` directly: the only two conditions present are `token.actions.githubusercontent.com:aud` and a `StringLike` on `token.actions.githubusercontent.com:sub` matching `repo:${var.github_org}/${var.github_repo}:ref:refs/heads/main` — there is no `environment:` segment anywhere in that condition block. This is a genuine, independently-observable gap between what the workflow YAML enforces (an environment-gated approval) and what the IAM trust policy enforces (a branch match only): today, the GitHub Environment approval gate and the IAM branch condition are two independent layers that happen to usually agree, rather than one layer whose enforcement the other is derived from. Branch-only scoping is a reasonable, defensible middle ground — meaningfully better than no scoping — but it's a step below the environment-scoped condition that 2026 practice treats as the fuller version of the same idea.

---

## 8. Debug Drill

**Scenario:** a GitHub Actions deploy workflow that has run successfully for months suddenly fails at the "Configure AWS credentials" step with either an AWS `AccessDenied` error or, more specifically, `"is not authorized to perform: sts:AssumeRoleWithWebIdentity"`. Nothing about the workflow file changed recently. Where do you look, in order, and why?

1. **Read the exact error message and where it originates.** `AssumeRoleWithWebIdentity` failing means the problem is in the *trust* relationship (who can assume the role), not the role's own permission policy — a policy-permission problem would surface later, as a specific API call's `AccessDenied`, after the role was already successfully assumed. This distinction narrows the search immediately: don't go looking at `aws_iam_role_policy.github_actions_deploy` yet.

2. **Check whether the OIDC provider's thumbprint is still valid.** GitHub occasionally rotates the TLS certificate its OIDC endpoint presents, which changes the certificate chain's fingerprint. If the `aws_iam_openid_connect_provider` resource's `thumbprint_list` wasn't updated to match, AWS can no longer validate GitHub's signing certificate and will reject the token before even evaluating the trust policy's conditions. This is worth checking first because it's an *external* change — nothing in this repo's own files needs to have changed for it to bite.

3. **Check for a branch or ref mismatch.** If the repository's default branch was renamed (`main` → `master` or similar), if the workflow started being triggered from a differently-named branch, or if the workflow's trigger conditions changed to run from a tag or PR ref instead of a branch push, the OIDC token's `sub` claim will no longer match the trust policy's `StringLike` condition — and the failure looks identical to a thumbprint problem from the workflow's point of view (`AssumeRoleWithWebIdentity` denied) even though the root cause is entirely different. Compare the actual `sub` claim GitHub is now issuing (visible by decoding the OIDC token, or from the specific AWS error detail) against the exact string in the role's trust policy.

4. **Check whether the trust policy or the role's inline/attached policies were edited directly** — either through a manual console change that Terraform doesn't know about (and will silently drift from), or through a Terraform change that narrowed a condition without a corresponding workflow update. A `terraform plan` that shows an unexpected diff against the live role, or a recent merged PR touching `infra/modules/iam/main.tf`, is the fastest way to confirm or rule this out.

5. **Confirm the account ID and role name in the workflow's `role-to-assume` still match what's actually deployed.** `role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/astrix-dev-github-actions-role` depends on a GitHub secret holding the right account ID and on the role's name matching this exact string — an account migration, a Terraform rename, or a stale secret value all produce the same symptom.

The general principle underneath all five steps: an `AssumeRoleWithWebIdentity` failure is a trust-boundary problem, and trust boundaries have exactly three moving parts — the token issuer's validity (thumbprint), the token's claims (audience, subject), and the trust policy's conditions (what it expects those claims to say). Work through those three before ever looking at what the role is allowed to *do* once assumed.
