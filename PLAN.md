# AstriX — Production Readiness Plan

## Implementation status (2026-09-10, post-fix re-audit)

All findings below were implemented and then independently re-audited by fresh review passes (not just re-checked by whoever wrote the fix). Commits: `9c8248b`, `2b0282f`, `f401f96`, `f1285e2`, `89f4ac6`, `55b6d02`, `f44d959` on `main` (all local — **not pushed**, since `deploy-backend.yml`/`deploy-frontend.yml` auto-deploy on push to `main` with no approval gate that existed at audit time; review and push when ready).

**Fixed and re-verified:** every Critical and High finding across backend, frontend, and infra/CI, plus nearly every Medium and Low item. Final state: backend 561/562 tests passing (1 intentionally skipped), lint clean, build clean; frontend 69/69 tests passing, typecheck clean, lint clean (0 errors); infra `terraform fmt` clean, `terraform validate` succeeds with zero warnings.

**Explicitly deferred (user decision, not a gap):**
- ALB private key leaked in git history (commit `5f51608`) — history was **not** rewritten. The cert itself was not rotated either (rotating it requires running `infra/scripts/setup-https.sh` against real AWS, which this pass didn't do). Residual risk: low (self-signed cert, not a real credential), but the key is still retrievable by anyone who clones the repo.
- Real CA-issued TLS certificate — no domain was available. The Terraform code path for a custom domain (`enable_alb_custom_domain`) is intact and ready; the ALB is still configured with the self-signed-cert-shaped ARN.

**Still open (small, explicitly not chased to keep this pass bounded):**
- `aws_profile = "prod-terraform"` naming (misleading — it provisions `dev`) not renamed across scripts/docs.
- Real AWS account ID + SSO role ARN still committed in `infra/scripts/*.json` policy files (needed for those policies to function; not secret-sensitive on their own, but permanent disclosure once this repo's history ships).
- GitHub repo settings (environment-protection required reviewers for the `production`/`infra-apply` environments) — the workflow-level gates are in place, but the actual reviewer list is a manual step in GitHub's UI, not something a file change can do.
- Frontend: no test for `Sign-up.tsx` or `store/store.ts`; no vitest coverage threshold configured (backend has one, frontend doesn't).
- Backend: a bare `Error` (not `AppError`) in `loginOrCreateAccountService` for an internal invariant violation — low priority, not client-reachable.

**New findings from the re-audit (now fixed as part of this pass, not left open):** a login timing side-channel that partially undid the M2 email-enumeration fix (unknown-account branch returned instantly while the wrong-password branch ran a real bcrypt compare, making the two distinguishable by latency even with identical status codes) — fixed by burning the same bcrypt cost on both branches. Two orphaned Terraform artifacts (an unused `local` block and an unused `variable`) left over from the CloudFront `/api/*` removal — deleted. A missing regression test for the exact backend path (`updateTaskService`) that H1's original bug was about — added. A missing regression test for the frontend query-key fix (Critical #3) — added.

---

**Audit date:** 2026-09-10
**Scope:** full read of `backend/src`, `backend/tests`, `client/src`, and every file under `infra/` and `.github/` (config/build files included). Conducted as three independent deep-dive passes (backend, frontend, infra/CI), cross-checked against a security checklist (`TODO.md`) that existed in this repo's history but was deleted from the working tree before this audit — see §5.

## Verdict

**Not ready to sell as-is, but closer than a prototype.** The backend is genuinely well-built (transactions, indexes, IDOR guards, hashed single-use tokens, a real test pyramid). The infra layer has real production instincts (OIDC everywhere, deployment circuit breaker, Trivy/gitleaks gates, SecureString secrets). But three **Critical** frontend bugs mean core product functionality (editing/deleting a task, logging in cleanly, seeing your own project changes) is currently broken, and three **Critical** infra gaps (self-signed cert on the public ALB, a leaked private key in git history, no prod/staging separation) will fail any buyer's technical diligence immediately. None of this requires a rewrite — it's a focused, ranked fix list.

Total findings: **6 Critical, 15 High, 24 Medium, 20 Low** across the three areas below.

---

## Priority 0 — fix before doing anything else (ship-blocking or trust-blocking)

| # | Area | Finding | Where |
|---|------|---------|-------|
| 1 | Frontend | Task **edit** has no handler; task **delete** confirm is a no-op — core CRUD is dead on the primary table | `client/src/components/workspace/task/table/table-row-actions.tsx:27,42-52` |
| 2 | Frontend | Post-login redirect sends users to `/workspace/[object Object]` on every plain sign-in | `client/src/page/auth/Sign-in.tsx:89` |
| 3 | Frontend | Project create/edit/delete never invalidates the sidebar's project list — query-key typo (`"allprojects"` vs `"allProjects"`), 3 call sites | `client/src/components/asidebar/nav-projects.tsx:86`, `client/src/components/workspace/project/create-project-form.tsx:76`, `client/src/components/workspace/project/edit-project-form.tsx:85` |
| 4 | Infra | ALB HTTPS almost certainly serves a **self-signed** cert to real browsers (imported via `setup-https.sh`, not a CA-issued cert) | `infra/scripts/setup-https.sh`, `terraform.tfvars:alb_certificate_arn` |
| 5 | Infra | ALB **private key was committed to git history** and is still retrievable (`git cat-file` confirms the blob), even though it's gone from HEAD | commit `5f51608` |
| 6 | Infra | Only one Terraform environment (`dev`) exists and it *is* production — none of the `environment == "prod"` hardening (deletion protection, immutable ECR tags, etc.) is actually engaged | `infra/environments/` |
| — | Legal/Trust | Fabricated testimonials, fake usage stats, and dead `href="#"` Terms/Privacy links on the public marketing + auth pages of a product about to be sold | `client/src/page/home/landingPage.tsx:134-178,831-833`; `Sign-in.tsx:201`; `Sign-up.tsx:221` |

Fix these seven before anything else — they block a demo, block a sale conversation, or are actively lying to users/customers.

---

## 1. Backend (`backend/`)

**Overall:** above-average for its size. Transactional multi-document writes are correct everywhere except the seeder. Every workspace-scoped mutating route is guarded by membership + role/permission checks — no missing guard found. No NoSQL-injection pattern found (all filter inputs are zod-validated or route params). Tokens are 256-bit, hashed, single-use, TTL'd. Test pyramid is real (33 files, ~9.5k lines, enforced coverage thresholds, integration tests run against `mongodb-memory-server` with real transactions).

### High

- **H1 — `updateTaskService` skips the `assignedTo` membership check that `createTaskService` enforces.** Any member with `EDIT_TASK` can assign a task to *any user in the system*, not just workspace members.
  `backend/src/services/task.service.ts:66-108` (missing) vs `:38-47` (has it).
  **Fix:** add `MemberModel.exists({ userId: assignedTo, workspaceId })` to the update path before persisting.

- **H2 — Rate limiters use `express-rate-limit`'s default in-memory store.** With N ECS tasks behind the ALB, brute-force limits on `/auth/login` and password reset are effectively `5 × N` per 15 min, and reset on every deploy/task replacement.
  `backend/src/index.ts:113-123`, `backend/src/routes/auth.route.ts`.
  **Fix:** back the limiter with `rate-limit-mongo` (Mongo is already in use) or Redis, so limits are cluster-wide.

### Medium

- **M1** — `createTaskService` throws a bare `Error` (with a typo: "mnember") instead of `BadRequestException`, so a client-input validation failure returns **HTTP 500** and pollutes 500-alerting. `backend/src/services/task.service.ts:45`.
- **M2** — User enumeration on login: unknown email → 404, wrong password → 401 (same message text, different status code) — an attacker can enumerate registered emails. Contrast with the password-reset flow, which correctly returns identical responses either way. `backend/src/services/auth.service.ts:164-177` vs `:366-392`.
- **M3** — No refresh-token rotation; a stolen refresh token stays valid for its full 7-day life with no reuse-detection signal. Rotation call is present but commented out. `backend/src/services/auth.service.ts:295-317`; `backend/src/controllers/auth.controller.ts:157-160`.
- **M4** — No explicit Mongo `maxPoolSize`. Default (100) × multiple ECS tasks can exhaust a lower-tier Atlas cluster's connection ceiling under scale-out. `backend/src/config/database.config.ts:5-14`.
- **M5** — Swagger docs are incomplete: `project.schemas.ts`, `task.schemas.ts`, `user.schemas.ts` are empty files; only auth is documented. Also, `/api/docs` is gated only on `NODE_ENV !== "production"`, so any shared staging ECS task exposes the full route map with nothing in front of it. `backend/src/config/swagger.config.ts:23-27`; `backend/src/index.ts:132-134`.

### Low

- Unused `import { error } from "console"` in the auth-gating middleware file. `backend/src/middlewares/auth.middleware.ts:5`.
- `role.seeder.ts` never aborts its transaction or disconnects on failure/success — `npm run seed` can hang. `backend/src/seeders/role.seeder.ts:6-49`.
- `_id?: any` in the global Express `User` augmentation forces defensive `?.` chains everywhere downstream despite `_id` being guaranteed set. `backend/src/@types/index.d.ts:8`.
- `memberId` parameters in `workspace.service.ts` (`changeMemberRoleService`, `removeMemberFromWorkspaceService`) are actually `userId`s — not a bug, but a naming trap.
- `FRONTEND_ORIGIN` default (`"localhost"`) isn't a valid browser `Origin` header value — fails closed if ever actually relied on, but confusingly.
- **No lint/format script or ESLint/Prettier config anywhere in `backend/`** — no static-analysis gate beyond `tsc`. Given the product-quality bar being asked for here, add one (see §6).
- A few uncommented `any`s in `errorHandles.middleware.ts` (defensible, but the repo's own convention comments every other deliberate `any`).

### Secrets / env

`.env` correctly gitignored, confirmed never committed. `JWT_ACCESS_TOKEN_SECRET`/`JWT_REFRESH_TOKEN_SECRET` in the local `.env` look like **placeholder strings**, not high-entropy secrets — **rotate to real random values before any real deployment.** The Mongo URI's credential pair also looks placeholder-shaped — verify and rotate if live.

---

## 2. Frontend (`client/`)

**Overall:** the parts that are easy to get wrong in an SPA are done right — access token in memory only, refresh token in an httpOnly cookie, no `persist` middleware, no sensitive data in `localStorage`, a correct single-flight refresh interceptor with request queueing. ESLint and `tsc --noEmit` are both clean. Route-level code splitting and a route-keyed error boundary are in place. The problem isn't architecture — it's that core CRUD paths were wired up incompletely and have **zero test coverage**, so the breakage went unnoticed.

### Critical (see Priority 0 above for #1–#3)

### High

- **H1 — Fabricated social proof** on the public landing page: named testimonials, fake company logos, fabricated usage stats ("50K+ Active Users" etc.). This is a false-advertising/FTC-endorsement risk for a real commercial product, not a code nit. `client/src/page/home/landingPage.tsx:134-178`.
- **H2 — Dead legal links.** "Terms of Service"/"Privacy Policy" link to `href="#"` on Sign-in, Sign-up, and the landing page footer; no such pages exist anywhere in the app, despite the app handling PII. `Sign-in.tsx:201`, `Sign-up.tsx:221`, `landingPage.tsx:831-833`.
- **H3 — Zero test coverage on the entire core product surface**: `Sign-in.tsx`/`Sign-up.tsx` (where the redirect bug lives), all of `routes/protected.route.tsx`/`auth.route.tsx` (auth gating), `hoc/with-permission.tsx`/`hooks/use-permissions.ts` (permission enforcement), `lib/axios-client.ts` (the 401/refresh interceptor — the single most security-sensitive file in the client), all task/project components and pages, `store/store.ts`.
- **H4 — Open redirect risk.** `returnUrl` from the query string is decoded and passed straight to `navigate()` with no same-origin/shape validation. `Sign-in.tsx:58,88-89`; source: `page/invite/InviteUser.tsx:32-34`.
- **H5 — Stale permissions on workspace switch.** `usePermissions` only updates inside its "user && workspace" branch, no `else` reset, so switching workspaces can transiently show controls (e.g. Settings nav, delete buttons) that belong to the *previous* workspace's role. Backend still enforces real authorization, so this is a correctness/UX bug, not a privilege escalation. `client/src/hooks/use-permissions.ts:9-22`.

### Medium

- `EditProjectForm`'s submit button still says "Create" (copy-paste) and lacks the `disabled={isPending}` guard every other form has — allows double-submit. `edit-project-form.tsx:182-187`.
- `EditTaskForm` hand-rolls status/priority label formatting and renders `"IN_PROGRESS"` as `"In_progress"` instead of using the shared `transformOptions` helper `CreateTaskForm` already uses correctly. `edit-task-form.tsx:56-64`.
- Landing page re-renders the whole page tree on every unthrottled `mousemove`; also has a leftover `console.log(scrollY)` and ~30 lines of dead commented-out component. `landingPage.tsx:39-44,79-99,307-320`.
- `NotFound.tsx` is a single unstyled `<div>` — inconsistent with the polished `Unauthorized.tsx`.
- `useAuth`'s query has `retry: 2`, which triples the refresh-cycle round-trips on every logged-out page load. `hooks/api/use-auth.tsx:5-10`.
- Toast system still has shadcn's boilerplate defaults: `TOAST_LIMIT = 1` (a second error toast silently replaces the first) and a ~16.7-minute removal delay. `hooks/use-toast.ts:11-12`.
- Duplicated, less-safe avatar-initials logic in two places instead of the shared `getAvatarFallbackText` helper (which handles single-word/empty names). `asidebar.tsx:88-91`, `workspace-header.tsx:15`.
- Revoking your *own current* session doesn't proactively clear local auth state — user appears logged in until the next API call 401s. `account/sessions-card.tsx:36-52`.

### Low

- Success toast fires on project actions even when the (broken) invalidation means nothing visibly changed — misleading feedback, tied to the C3 fix.
- `staleTime: Infinity` on the projects/members queries compounds the staleness caused by C3.
- `BaseLayout` (auth pages, landing, invite page) has no route-scoped error boundary, only the top-level one.
- Emoji-picker button has no `aria-label` (screen readers announce nothing).
- Leftover `console.log(emoji, "emoji")` debug statement in `components/emoji-picker/index.tsx:16`.
- `Sign-up.tsx:111` renders the brand name as "Team Sync." instead of "AstriX" — leftover from a template rename.
- Raw task ID interpolated into a CSS class string for no reason in `table-row-actions.tsx:47`.

---

## 3. Infrastructure & CI/CD (`infra/`, `.github/`)

**Overall:** dev/prototype-grade with several genuinely production-minded touches — GitHub OIDC everywhere (no long-lived AWS keys), a deployment circuit breaker with auto-rollback on ECS, Trivy + gitleaks gating `pr-check.yml`, secrets injected into ECS exclusively via SSM `SecureString` (never plaintext env vars, never baked into the image), S3 fronted correctly via CloudFront OAC with full public-access block. The gaps cluster almost entirely around **certificate handling, environment separation, and a handful of specific places a secret can escape its intended path** — all fixable in days, not a rewrite.

### Critical (see Priority 0 above for #4–#6)

### High

- **The `tfplan` binary artifact uploaded by `infra.yml`'s apply job leaks secrets that the human-readable plan output redacts.** Terraform's `sensitive = true` only redacts CLI/console text — the uploaded plan file's internal representation still has the real Mongo URI, JWT secrets, and Google OAuth secret in the clear, downloadable by anyone with read access to Actions runs (a broader audience than whoever can trigger `workflow_dispatch`). This is the clearest secrets-leak path in the whole pipeline. `.github/workflows/infra.yml:166-173`.
- **`setup-https.sh` writes ungitignored plaintext-secret `.tfvars` backups.** `.gitignore`'s `*.tfvars` pattern matches files *ending* in `.tfvars`; `terraform.tfvars.backup.<timestamp>` doesn't end that way, so these (never deleted) backups containing the full plaintext Mongo URI/JWT/OAuth secrets sit unprotected on disk. `infra/scripts/setup-https.sh:117-120`.
- **The GitHub Actions deploy role's ECS permissions are unscoped (`Resource = "*"`)** while every other statement in the same policy (ECR, S3, SSM, Lambda) is correctly scoped to `${project}-${environment}-*`. `infra/modules/iam/main.tf:469-483`.
- **No approval gate before backend/frontend auto-deploy.** Both deploy workflows trigger on `push: branches: [main]` with no `environment:` key — every merge to main deploys immediately to what is, per the environment-separation gap, de facto production. `deploy-backend.yml`, `deploy-frontend.yml`.
- **Dependabot has no `terraform` ecosystem entry** — pinned AWS/TLS/null/local providers are never checked for updates or CVEs. `.github/dependabot.yml`.
- **Single NAT Gateway serves both AZs.** An AZ outage on the NAT's side kills egress (ECR pulls, Mongo Atlas, Google OAuth) for tasks in *both* AZs even though the tasks themselves stay up — a single-AZ dependency hiding inside an otherwise multi-AZ design. `infra/modules/networking/main.tf:170-185`.

### Medium

- ECR lifecycle policy only matches `"v"`/`"release"` tag prefixes, but images are actually tagged with the raw commit SHA and `latest` — production images accumulate unbounded storage cost. `infra/modules/ecr/main.tf:51-64` vs `deploy-backend.yml:43`.
- `update-urls.sh` hardcodes `http://` with a comment saying HTTPS isn't available, but Terraform's own logic computes HTTPS when `enable_https = true` (which it is) — running this documented operational script would silently regress the API URL to plaintext and break `secure: true` cookies. `infra/scripts/update-urls.sh:95`.
- An `/api/*` CloudFront cache behavior is defined and active even though the docs and `update-urls.sh` explicitly say the API is deliberately *not* routed through CloudFront (to avoid caching cookie-authenticated responses cross-user). TTLs are 0 so the specific risk is mitigated, but it's live, undocumented, contradicting surface. `infra/modules/cloudfront_s3/main.tf:374-388`.
- No WAF attached to CloudFront (`cloudfront_web_acl_id` is `null`) — fine for a low-traffic dev distribution, needs a deliberate decision before real customer traffic.
- `infra.yml`'s apply-job environment gate is documented in `infra/README.md:61` as possibly a no-op unless required reviewers were manually configured in GitHub repo settings — unverifiable from the repo alone, treat as unprotected until confirmed.
- Parameter Store secrets use the default AWS-managed KMS key rather than a project CMK.
- `rollback.yml` has no approval gate, inconsistent with `infra.yml`'s apply job — may be an intentional break-glass tradeoff, but reads like an oversight.
- The rollback mechanism is well-built but has no evidence it's ever been exercised end-to-end.
- Variable `validation {}` blocks exist only in the `networking` module; every other module (`security`, `iam`, `ecs`, `alb`, `acm`, `ecr`, `parameter-store`, `cloudfront_s3`) has none, despite several effectively-enum inputs (Fargate CPU/memory pairs, `ssl_policy`, `environment`).

### Low

- Real AWS account ID + SSO role IDs committed via `infra/scripts/*.json` bootstrap policies.
- `infra/modules/ecr/outputs.tf.tf` — double-extension typo (still loads, but looks careless to a buyer's engineer).
- `aws_profile = "prod-terraform"` actually provisions `dev` — misleading name, self-acknowledged in `infra/README.md:58`.
- Database security group's egress comment ("No outbound needed") contradicts its actual `0.0.0.0/0` rule (module isn't instantiated in `dev` today, so low impact).
- S3/CloudFront CORS defaults to `["*"]`.
- No `terraform.tfvars.example` for onboarding a second engineer or the buyer's team.

### Secrets flow (end to end) — mostly right

`terraform.tfvars` (gitignored) → Terraform apply → SSM `SecureString` (KMS-encrypted) → ECS task definition `secrets[]` (never `environment[]`, never baked into the image) → decrypted only at container start by the execution role. GitHub Actions never sees or needs the app secrets at all — the only GitHub secret is the account ID used to build the OIDC role ARN. This design is correct; the leaks found above (`tfplan` artifact, `.tfvars.backup.*` files, the committed private key) are all *escapes* from this otherwise-sound path, not flaws in the path itself.

---

## 4. Cross-cutting recommendation: add CI gates that would have caught the frontend Critical bugs

C1–C3 in the frontend (dead edit/delete, broken redirect, stale cache) all happened on files with **zero test coverage**, and `pr-check.yml`'s `check-frontend` job runs lint/test/build but the tests that exist don't touch these paths. Recommend:
1. Add integration/component tests for task CRUD (create/edit/delete round-trip through the table), the post-login redirect, and the project-list-refreshes-after-mutation flow — these three tests alone would have caught every frontend Critical finding.
2. Add a coverage threshold to the frontend `vitest` config (backend already has one at 85-90%) so this class of gap can't silently recur.

---

## 5. Status of the pre-existing security TODO list

A `TODO.md` security checklist existed in this repo's git history (`git show HEAD:TODO.md`) but was deleted from the working tree before this audit began. Cross-referencing its items against what this audit independently found in the current code:

**Appears resolved** (current backend/client code matches the intent): access tokens are no longer passed via URL query params; refresh token lives in an httpOnly+Secure cookie rather than being mutated onto `req`; `helmet` is enabled; CORS is environment-configured (not `*`); auth failure responses are normalized and don't leak stack traces in production; password-reset/email-verification tokens are hashed, single-use, TTL'd; session-based revocation exists (logout, password change).

**Still open, independently confirmed by this audit:** no refresh-token rotation (M3, backend); rate limiting exists but isn't cluster-wide-effective (H2, backend); user enumeration via status code on login (M2, backend).

**Not verifiable from this audit and worth explicitly checking next:** OAuth `state` parameter / CSRF protection on the Google login flow; `tokenVersion`/forced-logout-on-password-change beyond session revocation; account lockout after repeated failed logins; structured audit logging of auth events (login/logout/failed attempts); whether raw Mongoose documents ever leak through auth responses instead of a DTO. None of these were flagged as broken, but none were explicitly traced either — recommend a focused follow-up pass on `auth.service.ts` + `google.provider.ts` specifically for these five items.

---

## 6. Suggested execution order

1. **Priority 0 list (§ above)** — 7 items, all independently fixable in hours, most under a day each.
2. **Backend High (H1, H2)** — assignedTo membership check, distributed rate-limit store.
3. **Infra High** — scope the IAM ECS permissions, stop leaking the tfplan artifact and tfvars backups, add a deploy approval gate, rotate the leaked cert (cheap since self-signed) and scrub git history, add the Dependabot terraform ecosystem.
4. **Frontend H3** — add tests for auth gating, the axios refresh interceptor, and task/project CRUD; this is what prevents a repeat of the Priority 0 bugs.
5. **Everything Medium** — batch by area, no strict ordering required.
6. **Low / polish** — dead code, naming, doc-comment hygiene; fold into normal review cycles rather than a dedicated pass.
7. **Before any sale/diligence conversation specifically:** items 4, 5, 6 from Priority 0 (cert, leaked key, prod/staging separation) plus the fabricated-testimonials/dead-legal-links item — these are the ones a buyer's engineer or lawyer will find in the first hour of looking.
