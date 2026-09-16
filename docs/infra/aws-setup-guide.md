# AWS Account Setup Guide

> Part of the [AstriX engineering curriculum](../Architecture.md), sibling to [Infra — Master Architecture](./00-master-infra-architecture.md).

This guide covers a layer none of the numbered chapters (`01`–`15`) touch: the AWS **account and identity fabric itself** — the thing that has to exist *before* `terraform apply` can create a single VPC. [`04-identity-and-access-management.md`](./04-identity-and-access-management.md) says this directly: "Nothing in this module addresses human/console access to the AWS account itself." This is that missing piece.

The target end state, in one sentence: **a human can look at anything in the AWS Console but change nothing**; every change to real infrastructure flows through Terraform, applied either by CI (GitHub Actions OIDC, already built — see `04`) or by an engineer running `terraform apply` locally under a permission set that's audited and time-scoped. No IAM user, no access key, no `aws_access_key_id` pasted anywhere, ever.

---

## 0. What "production-grade" means here, and what it deliberately doesn't include yet

You're one engineer today. The instinct to reach for **AWS Control Tower** (AWS's automated multi-account "landing zone" product) is reasonable — it's what most companies eventually run — but it's the wrong first move here, for a cost reason, not a maturity reason:

- Control Tower itself carries no separate fee, but *enabling* it turns on AWS Config (a per-recorded-configuration-item charge, not free-tier) and a CloudTrail organization trail in **every account it manages**, starting the moment you enable it. For a single account with no traffic yet, that's real spend for zero benefit.
- Control Tower also wants at least three accounts to be meaningful (management, log archive, audit) and pushes you toward Service Catalog-provisioned "vended accounts" — machinery worth having at 5 engineers and 10 AWS accounts, not machinery worth having today.

So this guide builds the same *shape* Control Tower would give you — a management account, guardrails via Service Control Policies, centralized identity via SSO, an audit trail — by hand, using only pieces that are free to turn on and cheap-to-free to leave running:

| Piece | Cost to enable | Notes |
|---|---|---|
| AWS Organizations | **$0** | No charge for the organization or member accounts themselves |
| IAM Identity Center (successor to AWS SSO) | **$0** | No charge for users, groups, or permission sets |
| Service Control Policies (SCPs) | **$0** | Included with Organizations |
| CloudTrail (one org-wide trail, management events) | **$0** | First trail's management events are free; you pay only for the S3 storage of the log files (fractions of a cent/month at this scale) |
| AWS Budgets (cost + zero-spend alerts) | **$0** for the first 2 budgets | |
| IAM Access Analyzer | **$0** | |
| AWS Config | **Not free** — per-item recording charge from the first item | Deferred — see §7 |
| GuardDuty | **30-day trial, then per-GB/event charge** | Deferred — see §7 |
| Control Tower | **$0 direct, but auto-enables Config + org CloudTrail** | Deferred — see §8, "upgrade path" |

Everything in §1–§6 below is the $0 column. §7 names what's deliberately deferred and why, so it isn't mistaken for an oversight.

---

## 1. The bootstrap problem, stated precisely

Terraform can create almost everything in this guide — but it cannot create the thing it needs in order to run at all: a set of AWS credentials with permission to create IAM roles, an Organizations account, and an S3 bucket for its own state. That first credential has to come from a human, in the console, using the **root user**, exactly once, for exactly long enough to create the identity that Terraform (and every engineer afterward) will use instead. Every step in §2 that says "manual, in the console" is manual for this specific reason — not because it's the wrong instinct to want it declarative, but because nothing to author the declaration in yet exists.

Everything after §2 is Terraform.

---

## 2. Step 0 (manual, unavoidable): lock down the root user

Do this before anything else, in the console, signed in as root:

1. **Set a strong, unique root password** and store it in a password manager (1Password, Bitwarden) — not in a note, not in this repo, not in an env file.
2. **Enable MFA on the root user.** A hardware key (YubiKey) or virtual MFA app — never SMS. This is the single highest-leverage security action available on a fresh AWS account: root has no permission boundary at all, and an SCP (§5) cannot restrict it, because SCPs apply to everything *except* the management account's root user.
3. **Delete any root access key if one exists**, and never create one. Root has no legitimate use for an access key — every subsequent action in this guide is either a console click (root, a handful of times, in this section only) or an IAM Identity Center session.
4. **Set the account name / alias** to something recognizable (`astrix-management`, not the default 12-digit account ID) — Account Settings → Account Name.
5. **Add an alternate contact and a billing alert email** you actually read — Account Settings → Alternate Contacts. This email is where every budget alert and CloudTrail-tamper alert from later steps lands.

After this section, you should never sign in as root again except for the small list of actions AWS restricts to root specifically (closing the account, changing the account's support plan, restoring an IAM user's permissions if every admin identity is somehow locked out). Bookmark [AWS's own list of root-only tasks](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-tasks.html) so you recognize when — rarely — you're back here on purpose rather than out of habit.

---

## 3. Step 1 (manual, ~2 minutes): enable AWS Organizations

Console → AWS Organizations → **Create an organization**. This account becomes the **management account**. Two things worth understanding about what you just created, since they shape every SCP in §5:

- The management account is where billing, Organizations itself, and (later, if you adopt it) Control Tower live. AWS's own guidance — and every real multi-account setup — is to **run no application workloads in the management account**. Today, AstriX's actual application infra (the `dev` environment in `infra/environments/dev/`) lives in this same account, because there's only one account. That's a known, temporary state, not the target — see §8.
- Enabling Organizations turns on **consolidated billing** automatically, and unlocks Service Control Policies, which don't exist at all outside an organization.

Nothing to create here beyond clicking "Create" — Organizations has no per-resource cost and no configuration to get wrong at this step.

---

## 4. Step 2 (manual once, then Terraform): IAM Identity Center + permission sets

This is the piece that replaces IAM users and access keys for every human who ever needs AWS access, and it's the direct implementation of "no operation is allowed in the console except via a declared identity with an audited, time-boxed session."

### 4.1 Enable Identity Center (manual, one click)

Console → IAM Identity Center → **Enable**. Choose the **organization** instance type (not "account" instance) — it's what lets permission sets target the management account specifically, and what you'll need the moment a second account exists. This step has to be manual because Identity Center's own Terraform provider needs the instance to already exist before it can manage anything inside it.

Pick an identity source: for one engineer, **Identity Center's own built-in directory** is the pragmatic choice — no external IdP to run. If you already use Google Workspace or Okta for something else, federating that in now costs little extra and saves a future migration; either is fine, and it doesn't change anything else in this guide.

### 4.2 The permission sets (Terraform, from here on)

A **permission set** in Identity Center is the SSO equivalent of an IAM role — a named bundle of policies that gets provisioned as a real IAM role in whatever account a user is assigned to, the moment they're assigned. Three, not one, is the point of this section — collapsing them into a single "Admin" permission set is exactly the ClickOps failure mode this whole guide exists to avoid:

```hcl
# infra/modules/identity-center/main.tf (new module — doesn't exist yet)
#
# Three permission sets, deliberately not one:
#   - ReadOnly:   what a human gets by default. Console access with zero
#                 write capability anywhere in the account.
#   - Operator:   assumed deliberately, session-limited, for the handful of
#                 things Terraform can't or shouldn't do (rotating a
#                 leaked secret out-of-band, reading a CloudWatch Logs
#                 Insights query, an emergency ECS force-deployment).
#   - Terraform:  broad create/update/delete, used ONLY to run
#                 `terraform apply` — from a laptop before CI existed, or
#                 for the org/SSO layer itself, which can't safely be
#                 applied by a CI role that doesn't exist until this
#                 layer is applied. Never used to click around the console.

resource "aws_ssoadmin_permission_set" "read_only" {
  name             = "ReadOnly"
  instance_arn     = data.aws_ssoadmin_instances.this.arns[0]
  session_duration = "PT4H"
}

resource "aws_ssoadmin_managed_policy_attachment" "read_only" {
  instance_arn       = aws_ssoadmin_permission_set.read_only.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.read_only.arn
  managed_policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_ssoadmin_permission_set" "operator" {
  name             = "Operator"
  instance_arn     = data.aws_ssoadmin_instances.this.arns[0]
  # Short session on purpose - this is a "break glass for a few hours,"
  # not a standing-access grant. Re-authenticate through the SSO portal
  # (MFA-gated) if the incident runs longer.
  session_duration = "PT2H"
}

resource "aws_ssoadmin_permission_set_inline_policy" "operator" {
  instance_arn       = aws_ssoadmin_permission_set.operator.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.operator.arn

  # Read everything, plus a narrow allow-list of mutating actions that
  # are genuinely operational rather than infrastructural: force a
  # redeploy, tail/query logs, publish a one-off alarm-clearing metric.
  # Nothing here can create, modify, or delete an IAM principal, a
  # network resource, or anything Terraform is meant to own.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "ReadEverything", Effect = "Allow", Action = ["*:Get*", "*:List*", "*:Describe*"], Resource = "*" },
      {
        Sid    = "EmergencyOperations"
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "logs:StartQuery",
          "logs:GetQueryResults",
          "ssm:StartSession"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_ssoadmin_permission_set" "terraform" {
  name             = "Terraform"
  instance_arn     = data.aws_ssoadmin_instances.this.arns[0]
  session_duration = "PT1H"
}

resource "aws_ssoadmin_managed_policy_attachment" "terraform" {
  instance_arn       = aws_ssoadmin_permission_set.terraform.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.terraform.arn
  # PowerUserAccess, not AdministratorAccess: it excludes IAM and
  # Organizations management by design. Bootstrapping the org/SSO layer
  # itself (this module) is the one exception that genuinely needs IAM
  # write access - see the "chicken-and-egg" note below.
  managed_policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}
```

**The chicken-and-egg note, made explicit:** this very module — the one creating `Terraform`'s permission set — needs to create IAM roles and Identity Center resources, which `PowerUserAccess` deliberately excludes. So the *first* `terraform apply` of this module has to run under a temporary `AdministratorAccess` permission set, created and then deleted immediately after. Don't leave a standing `AdministratorAccess` permission set assigned to anyone as a matter of routine — it should exist for the minutes it takes to bootstrap this module and this module alone, then either be deleted or left unassigned to any user/group.

### 4.3 Assigning yourself

Console (still, because assigning the *first* user is the same bootstrap problem as §4.1) → Identity Center → Users → create yourself → Groups → create an `engineers` group, add yourself → AWS accounts → select the account → assign the `engineers` group to **`ReadOnly`**, and separately assign yourself (not the group — this should feel deliberate every time) to **`Terraform`** and **`Operator`**.

From this point forward: **you sign into AWS through the Identity Center portal URL, never through the root/IAM sign-in page.** The portal gives you a role picker — `ReadOnly` by default for anything console-shaped, `Terraform` only when you're about to run `terraform apply`, `Operator` only during an actual incident.

---

## 5. Step 3: Terraform bootstrap state for this layer

The existing Terraform in `infra/environments/dev/` manages *application* infrastructure (VPC, ECS, ALB — see [`00-master-infra-architecture.md`](./00-master-infra-architecture.md)) and its state already lives in an S3 backend (`infra/environments/dev/backend.tf:8-29`). The org/identity layer this guide describes is a **separate Terraform root**, deliberately: its blast radius (who can access every account you'll ever create) is categorically different from an ECS task definition's, and mixing the two states means one `terraform apply` for a routine app change could theoretically touch IAM/Organizations resources if someone fat-fingers a module reference.

```
infra/environments/
├── dev/              # existing — application infra, one AWS account today
└── org-bootstrap/    # new — Organizations, Identity Center, SCPs, org CloudTrail
```

Give `org-bootstrap` its own state file in the same S3 bucket/DynamoDB lock table pattern as `dev` (`infra/environments/dev/backend.tf`), just a different `key` (`org/bootstrap/terraform.tfstate`) — no new bucket needed, one bucket safely holds multiple environments' state as long as each has its own key.

---

## 6. Step 4: Service Control Policies — where "console is read-only" actually gets enforced

Everything so far *encourages* the right behavior (give people `ReadOnly` by default). SCPs are what makes the wrong behavior **impossible**, account-wide, even for someone who is assigned `AdministratorAccess` some day. This is the mechanism that answers your original ask directly: "no operation is allowed in console, just via declarative."

Attach these to the **root OU** (so they apply to every current and future account) or to a dedicated OU as you grow — for one account, attaching directly to the account is fine to start.

```hcl
# infra/environments/org-bootstrap/scps.tf (new)

# Deny creating IAM users and access keys anywhere in the org. This is the
# single policy that makes "no long-lived credentials" a structural fact
# instead of a convention someone can quietly violate under time pressure.
# It does not affect roles (Terraform, CI/OIDC, and service roles are
# unaffected) or the SSO-provisioned permission-set roles from Section 4.
data "aws_iam_policy_document" "deny_iam_users_and_keys" {
  statement {
    sid       = "DenyIAMUserCreation"
    effect    = "Deny"
    actions   = ["iam:CreateUser", "iam:CreateAccessKey"]
    resources = ["*"]
  }
}

resource "aws_organizations_policy" "deny_iam_users_and_keys" {
  name    = "deny-iam-users-and-access-keys"
  type    = "SERVICE_CONTROL_POLICY"
  content = data.aws_iam_policy_document.deny_iam_users_and_keys.json
}

# Deny disabling or tampering with the org CloudTrail (Section 7) or
# deleting its log bucket from inside any member account - the audit
# trail has to be tamper-resistant to whoever it's watching, which
# includes an account's own admin.
data "aws_iam_policy_document" "protect_cloudtrail" {
  statement {
    sid    = "ProtectOrgTrail"
    effect = "Deny"
    actions = [
      "cloudtrail:StopLogging",
      "cloudtrail:DeleteTrail",
      "cloudtrail:UpdateTrail",
      "s3:DeleteBucket",
      "s3:PutBucketPolicy",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Purpose"
      values   = ["org-audit-trail"]
    }
  }
}

resource "aws_organizations_policy" "protect_cloudtrail" {
  name    = "protect-org-cloudtrail"
  type    = "SERVICE_CONTROL_POLICY"
  content = data.aws_iam_policy_document.protect_cloudtrail.json
}

# Require MFA for any IAM-changing or account-leaving action. Belt-and-
# suspenders alongside the Identity Center session model in Section 4,
# for any principal that somehow isn't going through SSO.
data "aws_iam_policy_document" "require_mfa_for_sensitive_actions" {
  statement {
    sid       = "DenySensitiveActionsWithoutMFA"
    effect    = "Deny"
    actions   = ["organizations:LeaveOrganization", "organizations:*Policy*"]
    resources = ["*"]
    condition {
      test     = "BoolIfExists"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["false"]
    }
  }
}

resource "aws_organizations_policy" "require_mfa" {
  name    = "require-mfa-for-org-actions"
  type    = "SERVICE_CONTROL_POLICY"
  content = data.aws_iam_policy_document.require_mfa_for_sensitive_actions.json
}

resource "aws_organizations_policy_attachment" "attach_all" {
  for_each = toset([
    aws_organizations_policy.deny_iam_users_and_keys.id,
    aws_organizations_policy.protect_cloudtrail.id,
    aws_organizations_policy.require_mfa.id,
  ])
  policy_id = each.value
  target_id = data.aws_organizations_organization.this.roots[0].id
}
```

**What this deliberately does *not* do:** an SCP that flatly denied every `Create*`/`Update*`/`Delete*` API call in the console would also block `terraform apply` run under the `Terraform` permission set, since Terraform's calls and a human's console clicks are indistinguishable to IAM at the API level — both are just an authenticated principal calling `ecs:UpdateService`. "Console is read-only" is therefore enforced by **which permission set a human is handed by default** (§4: `ReadOnly`) plus **audit visibility into every mutating call regardless of source** (§7's CloudTrail), not by an SCP that can tell a console click apart from a Terraform-issued API call — no such distinction exists in AWS's request model. If you want an even harder guarantee later, the real mechanism is a *separate* SCP condition keyed on `aws:PrincipalTag` or `aws:userid`, denying mutating actions to everyone except the CI OIDC role and the `Terraform` permission set's role — worth adding once you have a second engineer and the honor-system gap above starts to matter.

---

## 7. Step 5: the audit trail — one org-wide CloudTrail, free

```hcl
# infra/environments/org-bootstrap/cloudtrail.tf (new)

resource "aws_s3_bucket" "org_trail_logs" {
  bucket = "astrix-org-cloudtrail-logs-${data.aws_caller_identity.current.account_id}"
  tags   = { Purpose = "org-audit-trail" }  # matches the SCP condition in Section 6
}

resource "aws_s3_bucket_lifecycle_configuration" "org_trail_logs" {
  bucket = aws_s3_bucket.org_trail_logs.id
  rule {
    id     = "expire-old-logs"
    status = "Enabled"
    # Glacier after 90 days keeps this bucket's cost near-zero indefinitely
    # even as log volume grows - CloudTrail's management-event logging
    # itself is free, this transition only affects the tiny S3 storage
    # cost of the log objects.
    transition {
      days          = 90
      storage_class = "GLACIER"
    }
    expiration {
      days = 2555  # ~7 years - a reasonable compliance-driven default; tighten if none applies
    }
  }
}

resource "aws_s3_bucket_public_access_block" "org_trail_logs" {
  bucket                  = aws_s3_bucket.org_trail_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudtrail" "org_trail" {
  name                          = "astrix-org-trail"
  s3_bucket_name                = aws_s3_bucket.org_trail_logs.id
  is_organization_trail         = true   # requires this to be run in the management account
  is_multi_region_trail         = true
  enable_log_file_validation    = true   # lets you cryptographically prove logs weren't altered after the fact
  include_global_service_events = true

  # Deliberately NOT enabling data events (S3 object-level, Lambda
  # invocations) here - those are the part of CloudTrail that actually
  # costs money per-event. Management events (every console/API/CLI call
  # that creates, modifies, or deletes a resource) are free and are what
  # "who did what" audit actually needs for an account this size.
  event_selector {
    read_write_type           = "All"
    include_management_events = true
  }

  tags = { Purpose = "org-audit-trail" }
}
```

This is the piece that makes "console is read-only, everything else is declarative and reviewable" an auditable *fact* rather than an assertion: every console click that somehow bypasses the `ReadOnly` default (a compromised session, a misconfigured permission set, a future engineer with `Operator` who does something outside its intended scope) shows up in this trail — who, when, from where, exactly what API call — permanently, in a bucket the SCP in §6 prevents even an account admin from quietly deleting.

---

## 8. What's deferred, and the honest upgrade path

**AWS Config** — not enabled here because it has no free tier at all; every recorded configuration item is billable from the first one. Turn it on (one `aws_config_configuration_recorder` resource, plus AWS-provided conformance packs for CIS/PCI baselines) once real workloads exist and the marginal cost is worth the drift-detection value. Until then, Terraform state plus `terraform plan` in CI (already wired in `infra.yml` — see [`00-master-infra-architecture.md` §4.3](./00-master-infra-architecture.md#43-a-pr-touching-infra)) is your drift detector.

**GuardDuty** — 30-day free trial per account, then billed by event volume and VPC Flow Log/DNS query volume analyzed. Worth enabling the day you have real internet-facing traffic to protect; low value against an account with no running workloads today. A calendar reminder to enable it alongside your first real production deploy is more useful than turning it on now and letting the trial expire unused.

**Control Tower** — the honest reason to adopt it later isn't "you were doing this wrong," it's "the manual OU/SCP/account-vending machinery in this guide gets tedious past 2-3 accounts, and Control Tower automates exactly that tedium." The migration path from what this guide builds to Control Tower is well-trodden (AWS supports "enrolling" an existing Organizations setup into Control Tower without tearing it down) — you're not painting yourself into a corner by starting here.

**Multi-account split** (management / log-archive / audit / workloads) — the natural next step once a second environment (staging, or a real `prod` distinct from today's `dev`) exists. `infra/environments/dev/` would become `infra/environments/prod/` in a separate account, with this guide's Identity Center permission sets extended to target it, and the CloudTrail bucket in §7 moved to a dedicated log-archive account nothing else runs workloads in. Not needed at one account, one engineer.

---

## 9. Day-2 operating model (the part that has to actually get followed)

- **Signing in:** always through the Identity Center portal, never the root/IAM-user login page. Default role: `ReadOnly`.
- **Making an infrastructure change:** edit Terraform in `infra/`, open a PR. `infra.yml` runs `terraform plan` under the GitHub Actions OIDC role and posts the diff as a PR comment (see [`00-master-infra-architecture.md` §4.3](./00-master-infra-architecture.md)) — review that diff the same way you'd review code. Merge, then apply via the existing `infra-apply`-gated `workflow_dispatch` job, which authenticates with zero standing credentials, exactly as documented in `04-identity-and-access-management.md`.
- **Applying Terraform from a laptop** (only for the org-bootstrap layer itself, or before CI exists for a new environment): switch the Identity Center portal's active role to `Terraform`, run `terraform apply`, switch back to `ReadOnly` when done. The 1-hour session duration on that permission set (§4.2) means it expires on its own even if you forget.
- **An actual incident:** switch to `Operator`, do the minimum needed to stabilize, then convert whatever you did into a Terraform change afterward so state doesn't silently drift from what you clicked/ran during the incident.
- **Never:** create an IAM user, generate an access key, paste a credential into a `.env` file or GitHub secret, or run `terraform apply` under `AdministratorAccess` as a matter of routine.

---

## 10. Order-of-operations checklist

1. [ ] Root: strong password, MFA, delete/never-create root access keys, set account alias + billing contact (§2)
2. [ ] Enable AWS Organizations (§3)
3. [ ] Enable IAM Identity Center, organization instance type (§4.1)
4. [ ] Bootstrap: temporarily assign yourself `AdministratorAccess`, `terraform init && terraform apply` the `org-bootstrap` root once to create the `ReadOnly`/`Operator`/`Terraform` permission sets (§4.2) and the SCPs/CloudTrail (§6–§7)
5. [ ] Delete the temporary `AdministratorAccess` assignment; confirm your user now only has `ReadOnly`, `Operator`, `Terraform`
6. [ ] Confirm the SCPs are attached (`aws organizations list-policies-for-target`) and test that `iam:CreateUser` is actually denied
7. [ ] Confirm the org CloudTrail is logging (a console click should show up in the S3 bucket within ~15 minutes)
8. [ ] Set up AWS Budgets: one zero-spend-style alert (e.g., >$5 forecasted) so any accidental billable resource pages you immediately
9. [ ] Bookmark the Identity Center portal URL; stop using the root/IAM sign-in page entirely

Everything above this line costs $0 to run indefinitely at your current scale. §8 is the reading list for when that stops being true.
