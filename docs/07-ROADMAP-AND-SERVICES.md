# AstriX — Roadmap: Next Features & Service Additions

This assumes the 🔴/🟠 items in the Security Concerns document are done first — building new features on top of a committed private key or an inverted cookie flag just means shipping the same mistakes into more surface area.

The roadmap is organized two ways: first as **sequenced milestones** (what to build, in what order), then as a **layer-by-layer catalog** of specific services/tools worth adding to backend, frontend, and infra independently — use the catalog to pick concrete next steps within whichever milestone you're on.

---

## Part A — Sequenced Milestones

### Milestone 0 — Credibility baseline (before any new feature)
1. **Test suite**, starting narrow: Vitest/Jest + Supertest for `auth.service.ts` (login, refresh, session revocation) and `roleGuard`/`getMemberRoleInWorkspace` (your highest-risk logic — a broken permission check silently grants access with no visible symptom). Add the test job to `pr-check.yml` as a required gate once it exists.
2. Fix the 🔴/🟠 items from the Security Concerns document.
3. Fill in the five `docs/*.md` stubs, or replace them with pointers into this document set.

### Milestone 1 — Real-time layer (Socket.io)
Highest "wow-factor per hour invested." Your domain (Workspace→Project→Task) is a natural fit:
- Live task-board updates: `socket.join(`project:${id}`)`, broadcast on status/assignee change from inside `task.service.ts` — not the controller, keeping broadcasting a side effect of the business-logic layer, consistent with how validation/authorization are already layered.
- Presence indicators ("3 people viewing this project").
- In-app notification bell + a new `Notification` model for events missed while offline (task assigned to you, mentioned in a comment, due-date approaching).

### Milestone 2 — Domain depth
- **Subtasks + dependencies** (`parentTaskId`, `blockedBy: TaskId[]`) — forces real thinking about cascading status updates and cycle detection.
- **Comments + an `ActivityLog` model** recording every state transition — this is what turns a CRUD app into something that feels like a real product, and a good excuse to practice MongoDB aggregation for the resulting activity feed.
- **Attachments** via Cloudinary or S3 (multi-file upload).
- **Sprints/milestones**, burndown data — pairs naturally with the analytics work already started (`workspace-analytics.tsx`, `project-analytics.tsx`).

### Milestone 3 — Auth/authorization depth
- GitHub OAuth alongside Google (the existing `passport.config.ts` pattern extends trivially).
- Email verification (OTP) — currently absent.
- TOTP-based 2FA (`otplib`).
- Surface the **already-built-but-unused** `getSessionsController`/`Session` model in a real "Manage Devices" settings page — this backend capability is already paid for, just not exposed in the UI.
- Account lockout after N failed logins (defense-in-depth on top of existing rate limiting).

### Milestone 4 — Dashboards & analytics
Deepen `workspace-analytics.tsx`/`project-analytics.tsx`: burndown/velocity charts, time-to-completion distributions per assignee, workspace-level admin view (member activity, task throughput). Good vehicle for learning MongoDB aggregation pipelines properly.

### Milestone 5 — SaaS billing
Rather than bolting on e-commerce-style payments, make this a genuine subscription product: Stripe subscriptions scoped to `Workspace` (free tier: 1 project / 3 members; paid tiers unlock more), webhook handling for subscription lifecycle events, entitlement checks integrated into the existing `roleGuard` layer. This fits the domain naturally instead of feeling grafted on.

### Milestone 6 — DevOps maturity, in parallel with the above
See Part B's Infra catalog for specifics — highlights: a real `staging` environment, parameterized CI/CD (matrix on branch), moving `local-exec` logic into GitHub Actions, blue/green ECS deploys before this ever serves real users.

**Suggested order**: Milestone 0 → Milestone 1 (real-time) → Milestone 2 (domain depth) → Milestone 3 (auth) → Milestone 6 in parallel with everything → Milestone 5 (billing) → Milestone 4 (analytics) as polish.

---

## Part B — Layer-by-Layer Service & Tooling Catalog

Concrete additions, organized by where they live. Use this as a menu while working through the milestones above.

### B1. Backend — services & tooling to add

| Addition | What it solves | Fits into |
|---|---|---|
| **Structured logger** (`winston` or `pino`) | Replaces 18 raw `console.log` calls; enables CloudWatch Logs Insights queries once running on ECS | Milestone 0, also closes S11 |
| **Test runner** (`vitest` + `supertest` + `mongodb-memory-server`) | Enables the entire Milestone 0 test-suite goal without needing a real MongoDB in CI | Milestone 0 |
| **Socket.io server**, mounted alongside Express (`src/config/socket.ts`), authenticated via the same JWT strategy on the handshake | Powers Milestone 1 entirely — presence, live board updates, notifications | Milestone 1 |
| **`Notification` model + service** | Persists events missed while a user is offline; paired with Socket.io for the live case | Milestone 1 |
| **`Comment` and `ActivityLog` models + services** | Comments on tasks; an audit trail of every state change (status, assignee, priority) | Milestone 2 |
| **File-upload service** (Cloudinary SDK, or `@aws-sdk/client-s3` + presigned URLs) | Task/comment attachments | Milestone 2 |
| **BullMQ + Redis** (job queue) | Needed once you add anything async: due-date reminder emails, recurring-task generation, digest notifications — none of this belongs inline in a request/response cycle | Milestone 2–3 |
| **`otplib`** (TOTP) + a `TwoFactorSecret` field on `User` | 2FA | Milestone 3 |
| **Email service abstraction** (`nodemailer` + a provider like Resend/SES) | OTP email verification, password reset, digest notifications — currently no email sending exists anywhere in the backend | Milestone 3 |
| **Stripe SDK + webhook handler route** | Milestone 5 billing, with idempotency keys on webhook processing (Stripe can and will redeliver events) | Milestone 5 |
| **`node-cron` or a scheduled ECS task** | Recurring tasks, due-date reminder sweeps, TTL-adjacent cleanup jobs that aren't naturally event-driven | Milestone 2 |
| **OpenAPI-generated client types** (`openapi-typescript` against the existing `/api/docs` spec) | Directly addresses the type-duplication risk called out in the Frontend↔Backend Connection document §5 — the Swagger spec already exists and is currently unused for this purpose | Ongoing, any milestone |
| **A shared `packages/types` workspace** (pnpm/npm workspaces) | Longer-term fix for the same duplication problem — a real shared-types package instead of a generated client, if the project grows enough to justify monorepo tooling | Later, once duplication pain is felt |

### B2. Frontend — services & tooling to add

| Addition | What it solves | Fits into |
|---|---|---|
| **`socket.io-client` + a `useSocket`/`useRealtimeTask` hook** | Consumes Milestone 1's backend real-time layer; should integrate with TanStack Query by calling `queryClient.setQueryData`/`invalidateQueries` on incoming events, not by maintaining a second parallel state store | Milestone 1 |
| **React Testing Library + Vitest** | Currently zero frontend tests; start with the axios refresh-queue logic (Doc 3 §6/§10.5) since it's the most concurrency-sensitive code in the app and the easiest to silently break | Milestone 0 |
| **Global `<ErrorBoundary>`** | Currently a thrown render error in any component has nothing catching it gracefully — wrap `AppLayout`'s `<Outlet/>` at minimum | Milestone 0 |
| **`react-dropzone` or similar** | Frontend half of Milestone 2's file-attachment feature | Milestone 2 |
| **A toast/notification-center component** wired to the new Socket.io notification events | UI half of Milestone 1's notification bell | Milestone 1 |
| **`cmdk`-based command palette** (`Cmd+K` to jump to any project/task) | Meaningful UX and portfolio polish; needs a debounced search endpoint on the backend (see B1's Redis/queue note re: debouncing) | Polish, after Milestone 2 |
| **`use-debounce` or a small custom debounce hook** | Currently no debouncing anywhere — needed the moment any search/filter input starts hitting the backend on every keystroke instead of filtering client-side data already in memory | Whenever server-side search is added |
| **A billing/settings page consuming Stripe's client SDK** (`@stripe/stripe-js`) | Frontend half of Milestone 5 | Milestone 5 |
| **Storybook** (optional, but the `components/ui/*` shadcn set is already isolated enough to document well) | Useful once the component count grows past what's easy to hold in your head; also a nice portfolio artifact on its own | Optional polish |

### B3. Infra — services & tooling to add

| Addition | What it solves | Fits into |
|---|---|---|
| **`infra/environments/staging/`** (copy of `dev`, parameterized) | The single biggest infra gap — there is currently no tested path for promoting a build beyond `dev` before it reaches whatever you'd call "prod" | Milestone 6 |
| **Parameterize the 5 GitHub Actions workflows** (matrix on branch → environment, replacing hardcoded `astrix-dev-*` names) | Required before a second environment is usable from CI without duplicating every workflow file | Milestone 6 |
| **ElastiCache (Redis)** Terraform module | Backing store for B1's BullMQ job queue and for Socket.io's adapter if you ever run more than one ECS task (Socket.io needs a shared adapter across replicas, or sticky sessions on the ALB — Redis solves this cleanly) | Milestone 1 (once ECS runs >1 task) |
| **Real ACM certificate + Route53 domain**, replacing the self-signed dev cert entirely | Removes the whole class of problem behind Security Concerns doc's S1; a DNS-validated ACM cert never has a private key that needs to exist outside AWS | Milestone 6, high priority alongside S1's remediation |
| **CodeDeploy blue/green** for the ECS service | Currently `force-new-deployment` does a standard rolling replacement — fine for `dev`, risky once real users are on this; blue/green gives you an automatic rollback trigger on failed health checks | Milestone 6, before real users arrive |
| **CloudWatch Alarms + SNS** (or a lighter tool like Better Uptime) on the `/health` endpoint and ECS service metrics | Currently zero alerting exists — you'd only find out about an outage from a user complaint | Milestone 6 |
| **AWS Secrets Manager** for anything requiring rotation (Stripe webhook secret, JWT secrets), keeping SSM Parameter Store for non-rotating config | Once Milestone 5 (Stripe) lands, its webhook secret is a good first candidate for real rotation support | Milestone 5–6 |
| **A `staging`/`prod` variant of the `ecs` module's auto-scaling config** (currently CPU/memory-based scaling exists but is tuned for a single dev task) | Needed once traffic is real enough that a fixed task count either wastes money or under-provisions | Milestone 6, later |
| **Terraform `pre-commit` hooks** (`terraform fmt -check`, `tflint`, `checkov` or `tfsec` for security scanning) | Would have caught the private-key-to-`local_file` pattern (S1) automatically before it was ever committed — this is the single highest-leverage infra tooling addition given what was actually found | Milestone 0, do this early |

---

## Why This Ordering

Milestone 0 and the infra catalog's `pre-commit`/security-scanning item are placed first deliberately: they're the cheapest possible insurance against repeating the exact class of mistake found in the Security Concerns document (S1 specifically — a secret-scanning pre-commit hook is a five-minute setup that turns "committed a private key" into "commit blocked locally before it ever reaches git history"). Everything after that is sequenced by learning value and portfolio impact per hour invested, with infra maturity (Milestone 6) deliberately run in parallel rather than saved for last, since it's cheap to advance incrementally alongside feature work rather than as one large effort at the end.