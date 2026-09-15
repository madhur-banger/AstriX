# AstriX — Production Readiness Plan

## Status (2026-09-10, independent re-audit)

Four independent reviews (backend, client, infra, `.github`), each formed cold from the current code, verified against actual `lint`/`test`/`build` runs, then cross-checked against this document's prior claims. Result: **the prior fix pass (commits `9c8248b`…`f44d959`) holds up almost everywhere it was checked** — roughly 45 previously-claimed fixes reconfirmed correct in the current tree, not just re-read from a commit message. Backend: 561/562 tests passing (1 intentionally skipped), lint/build clean. Client: 69/69 tests passing, lint/build clean.

**Verdict:** Not yet sale-ready. Three infra Criticals remain open by design (self-signed ALB cert, a leaked private key in git history, no real second environment). This re-audit surfaced 8 new High findings spread across all four areas that the prior pass didn't catch. None of this needs a rewrite — it's a bounded, ranked list.

**Repo state:** `main` is 8 commits ahead of unpushed `origin/main`. `terraform` was not available for this pass — the infra review is a static read, no `fmt`/`validate`/`plan` was run.

---

## Priority 0 — blocking (demo, sale conversation, or diligence)

| # | Area | Finding | Where |
|---|------|---------|-------|
| 1 | Infra | ALB serves a **self-signed cert** — breaks HTTPS for real browsers/`fetch` | `infra/scripts/setup-https.sh`, `terraform.tfvars:alb_certificate_arn` |
| 2 | Infra | ALB **private key leaked** into git history, never rotated | commit `5f51608` |
| 3 | Infra | Only one environment (`dev`) exists and **it is production** — every `environment == "prod"` safety rail is dead code | `infra/environments/` |
| 4 | Client | A user with zero workspaces lands on a dead `/workspace/undefined`, no onboarding path | `client/src/page/auth/Sign-in.tsx:91`, `routes/auth.route.tsx:17` |
| 5 | Backend | Password-reset/verification **tokens leak into logs** on email-send failure | `backend/src/providers/email.provider.ts:33-52,68,84` |
| 6 | CI/CD | Environment-protection reviewers are **unverifiable from the repo** — may be a no-op gate | GitHub repo settings (`production` / `infra-apply` environments) |

Fix 1–3 before any demo or diligence conversation. Fix 4–5 before onboarding real users. Confirm 6 in GitHub settings directly — it's the one item no file change can prove.

---

## 1. Backend (`backend/`)

**Verified clean:** authorization (workspace/role/permission checks on every mutating route), token design (hashed, TTL'd, single-use, rotation with reuse detection), NoSQL-injection posture, OAuth CSRF `state`, forced logout on password change, no raw Mongoose leakage through auth responses.

### High
- Reset/verification tokens land in logs on email-send failure — see P0 #5.
- `/api/docs` exposure and verbose-error responses both key off a plain `NODE_ENV !== "production"` string comparison, not a validated enum — a `staging` value bypasses both gates. `index.ts:123`, `errorHandles.middleware.ts:141-147`.

### Medium
- `deleteProjectService`'s project+tasks delete isn't wrapped in a transaction, unlike every sibling multi-document write — a mid-delete crash orphans tasks. `services/project.service.ts:181,183`.
- Swagger component schemas are filled in, but no route carries `@swagger` JSDoc — `/api/docs` renders types with zero documented paths.
- Every failure logs at `error` severity, including routine 4xx validation — alert-fatigue risk if wired to paging. `middlewares/errorHandles.middleware.ts:83`.
- `description` fields on Project/Task have no length cap, unlike sibling fields (bounded only by the global 1 MB body limit). `validation/project.validation.ts:5`, `task.validation.ts:7`.

### Low
- `ADD_MEMBER` permission defined, enforced nowhere (membership join is invite-code self-service by design).
- Invite codes are 32-bit with no dedicated rate limiter, only the shared API limiter. `utils/uuid.ts:3-5`.
- bcrypt cost factor is an unreviewed library default (10), now load-bearing for the login timing-equalization fix. `utils/bcrypt.ts:3`.
- `.env`'s `JWT_*_SECRET` and Mongo URI values look placeholder-shaped — rotate to real high-entropy values before any real deployment.

---

## 2. Client (`client/`)

**Verified clean:** every prior Priority-0 and High/Medium/Low frontend finding — task CRUD wiring, post-login redirect, cache-invalidation query keys, permission-hook reset on workspace switch, token storage (in-memory access token, httpOnly refresh cookie, no `persist` middleware), legal pages, landing-page trust surface — checked out fixed and test-covered on independent re-read. No discrepancies found.

### High
- Zero-workspace onboarding dead-end — see P0 #4.
- Sign-up drops the `returnUrl` query param, breaking the invite-then-register flow: invite links append `?returnUrl=`, `Sign-in.tsx` honors it, `Sign-up.tsx` never reads it and hardcodes `navigate("/sign-in")`. `page/auth/Sign-up.tsx:6,92` vs `page/invite/InviteUser.tsx:104-107`.

### Medium
- `react-router-dom` resolves to a version with known high-severity CVEs, including an open-redirect-via-backslash advisory — directly relevant given this app already sanitizes `returnUrl` for exactly this bug class.
- Main JS bundle is 1.09 MB / 295 KB gzip, past Vite's warning threshold — needs `manualChunks` to split vendor libs from app code.
- Confirm-dialog re-entrancy relies on `disabled` alone; not every caller guards against a double-submit. `components/reusable/confirm-dialog.tsx:52`.

### Low
- `UserType.currentWorkspace` is typed non-nullable while the Zustand store's copy is nullable for the same object — root cause of the zero-workspace bug above; every consumer defensively uses `?.` because it already knows this.
- Legal pages (Terms/Privacy) are honest, disclosed drafts, not fabricated — but still drafts (bracketed placeholders, an explicit "not reviewed by legal counsel" banner). Finish before a real customer or buyer's counsel sees them.
- `withPermission` returns bare `undefined` instead of `null` on access denial — harmless in React 18, just non-idiomatic.
- No test file for `Sign-up.tsx` or `store/store.ts`; no vitest coverage threshold configured (backend has one).

---

## 3. Infrastructure (`infra/`)

**Verified clean:** the secrets path end-to-end — `terraform.tfvars` (gitignored) → apply → SSM `SecureString` (customer-managed KMS key, correctly scoped) → ECS task definition `secrets[]`, never `environment[]`, never baked into an image. Roughly a dozen previously-claimed fixes (ECS IAM scoping, ECR lifecycle tags matching the real commit-SHA tagging scheme, `.tfvars-backup` handling, `update-urls.sh` protocol detection, the CMK, `environment` validation blocks across all nine modules, the `/api/*` CloudFront-behavior removal) were independently reconfirmed correct — this section has been pruned of everything already fixed rather than re-listing it.

### Critical — see P0 #1–3.

### High
- A stale CloudFront output would misconfigure Google OAuth's redirect URI — left over from the `/api/*` removal; the URL it points to doesn't 404, CloudFront's SPA-fallback function serves it as HTML with a `200`. `modules/cloudfront_s3/outputs.tf:73-76,119-132`, `environments/dev/output.tf:401-412`.
- `ecr_force_delete` is declared and set in `tfvars` but never passed to the module — the value does nothing; the module's own default happens to match today by coincidence. `environments/dev/main.tf:249-267`.
- Real AWS account ID + SSO role ARNs committed to git — permanent reconnaissance material for anyone who ever gets read access. `infra/scripts/backend-bucket-policy.json`, `terraform-kms-policy.json`.
- Single NAT Gateway — an AZ outage on its side kills egress for ECS tasks in both AZs even though the tasks stay up; a documented, deliberate cost tradeoff. `modules/networking/main.tf:158-164`.

### Medium
- `modules/iam/variables.tf:1-3` still headed `# ECR MODULE - VARIABLES` — copy-paste leftover, content is correct.
- CloudFront IAM wildcard has no justification comment unlike its siblings, and unlike them it could actually be scoped to this project's distribution. `modules/iam/main.tf:576-586`.
- `terraform.tfvars` holds real-shaped, weak secrets (an `admin:admin`-style Mongo credential, a real-shaped OAuth client secret) — correctly gitignored and never committed, but rotate both if live.
- No WAF attached to CloudFront — fine for a zero-traffic dev distribution, needs a deliberate decision before real customer traffic.

### Low
- S3/CloudFront CORS is live `["*"]`, not just a risky default. `terraform.tfvars:198`.
- `aws_profile = "prod-terraform"` actually provisions `dev` — misleading name, self-acknowledged in `infra/README.md`.

---

## 4. CI/CD (`.github/`)

**Verified clean:** OIDC everywhere (zero static AWS keys), Trivy/tfsec/gitleaks all actually block the job (none run with `continue-on-error`), rollback gating matches deploy's approval posture. Prior fixes (the tfplan-artifact secret leak, missing `environment:` keys on deploy workflows, the missing `terraform` Dependabot ecosystem) were independently reconfirmed correct.

### High
- Environment-protection reviewers unverifiable — see P0 #6.
- One shared AWS IAM role spans plan-on-PR, apply, deploy, and rollback — any same-repo PR touching `infra/**` gets a live AWS OIDC credential exchange with the same role apply/deploy/rollback use, before any review happens. `infra.yml:90,152`, `deploy-backend.yml:37`, `deploy-frontend.yml:33`, `rollback.yml:60,130`.
- `gitleaks/gitleaks-action@v2` requires a paid license on non-public repos; no `GITLEAKS_LICENSE` secret exists anywhere in the repo — the secret-scan gate may not actually be running and needs verification on a live PR, not just the YAML. `pr-check.yml:16-19`.

### Medium
- `pr-check.yml` is the only workflow with no `permissions:` block, so it inherits the repo/org default `GITHUB_TOKEN` scope instead of an explicit one.
- No third-party action anywhere is pinned to a commit SHA, only mutable tags — a supply-chain risk in jobs holding live AWS credentials (the same attack class that hit `tj-actions/changed-files` in March 2025).
- Dependabot has no `docker` ecosystem entry for `backend/Dockerfile`'s base image.
- The Terraform plan is posted verbatim into a public PR comment — safety depends entirely on every secret-bearing Terraform attribute correctly carrying `sensitive = true`. `infra.yml:107-125`.
- `pull-requests: write` is set workflow-wide in `infra.yml` instead of scoped to the one job (`plan-on-pr`) that needs it.

### Low
- One CODEOWNERS reviewer for the entire repo — a bus-factor flag on top of the unverified environment-reviewer gate above.
- Trivy's `ignore-unfixed: true` silently drops unfixable CRITICAL CVEs with no visible annotation on the PR checks page.

---

## Suggested execution order

1. Confirm GitHub Environment reviewer gates and the gitleaks license/behavior on a live PR run — settings and verification, not a code change.
2. Backend: stop logging raw reset/verify tokens; validate `NODE_ENV` against an explicit allowlist instead of excluding one string.
3. Client: add a zero-workspace onboarding screen; restore `returnUrl` through Sign-up.
4. Infra: a real ACM cert once a domain exists, rotate the leaked key (or rewrite history), stand up a second real environment.
5. CI/CD: separate a read-only plan identity from apply/deploy/rollback; SHA-pin third-party actions; add `docker` to Dependabot.
6. Everything else Medium/Low — batch into normal review cycles, no strict ordering required.

---

*Methodology: four independent passes, each formed from a cold read of the current code and actual `lint`/`test`/`build` runs, cross-checked against this document's own prior claims afterward — not the other way around. No code was changed as part of producing this document.*
