# AstriX — Product & Engineering Roadmap

> Scope of this file vs. the rest of `docs/`: [`Architecture.md`](./Architecture.md) and `docs/backend|frontend|infra|testing/` document **what exists today**, verified against real code. Root [`PLAN.md`](../PLAN.md) tracks **production-readiness bugs** in what already exists (security/correctness findings, ranked, with file:line citations). This file is neither — it's **what doesn't exist yet and whether it should**: the feature and infrastructure work that turns AstriX from "a working Jira-lite" into "a Jira-lite you could actually run a team's real work on, or sell." Every item below is judged against a concrete question — *does a real PM tool (Jira, Linear, Asana) need this, and does AstriX need it now* — not added because it's trendy. §6 is the reject list, and it matters as much as the build list.

**Last updated:** 2026-09-11

---

## 1. Where AstriX stands today (condensed)

AstriX is a workspace → project → task management app: JWT + rotating-session auth with Google OAuth, per-workspace RBAC, a layered Express/MongoDB API, a React SPA, deployed on AWS (ECS Fargate + ALB for the API, S3 + CloudFront for the SPA), Terraform-managed, GitHub Actions CI/CD with OIDC. Full detail lives in the module docs linked below — this table is deliberately just enough to orient, not a re-derivation.

| Layer | Built | Reference |
|---|---|---|
| **Domain model** | User, Account (OAuth), Workspace, Member, Role/Permission, Project, Task, Session, email-verification + password-reset tokens. **No** Comment, Attachment, Notification, Activity-log, or Billing model yet. | [`backend/07`](./backend/07-database-schema-design.md) |
| **Auth** | Hand-rolled JWT access/refresh pair, server-tracked revocable sessions with reuse detection, Google OAuth (manual authz-code flow), per-workspace RBAC via a static permission map | [`backend/02`](./backend/02-authentication-and-authorization.md) |
| **API** | REST, layered (routes → middleware → controllers → services → Mongoose), Zod validation, centralized error handling, Swagger (non-prod only), rate-limited via `rate-limit-mongo` | [`backend/00`](./backend/00-master-backend-architecture.md)–[09](./backend/09-api-design-and-external-providers.md) |
| **Frontend** | React 18 SPA, TanStack Query for server state, Zustand for auth state (memory-only token), `react-hook-form`+Zod, Tailwind+Radix (shadcn), config-based routing with guards | [`frontend/00`](./frontend/00-master-frontend-architecture.md)–[10](./frontend/10-build-tooling-and-bundle-optimization.md) |
| **Infra** | VPC (2 AZ, public/private split), ALB+ACM, ECS Fargate (autoscaling, deployment circuit breaker), ECR (scanned), S3+CloudFront (OAC, SPA routing), SSM Parameter Store+KMS, CloudWatch+SNS alarms, AWS Budgets — **one environment (`dev`), which is the only environment that exists** | [`infra/00`](./infra/00-master-infra-architecture.md)–[15](./infra/15-security-scanning-and-supply-chain.md) |
| **CI/CD** | GitHub Actions, OIDC-federated (no static AWS keys), `pr-check.yml` (Gitleaks/lint/test/Trivy), separate backend/frontend/infra deploy workflows, manual `rollback.yml`, Dependabot | [`infra/12`](./infra/12-cicd-with-github-actions.md)–[13](./infra/13-deployment-strategies-and-rollback.md) |
| **Testing** | Backend: 46 files, unit+integration+E2E, `mongodb-memory-server`, 90/85/90/90 coverage gate in CI. Frontend: 22 files, component/hook only — **no E2E (Playwright/Cypress), no coverage gate** | [`testing/00`](./testing/00-master-testing-strategy.md)–[08](./testing/08-security-testing-and-scanning.md) |
| **Explicitly missing** | File upload/storage, real-time (WebSocket), caching layer, background job queue, comments, notifications, activity log, search, billing/payments, second environment | this file, §3–4 |

**Production-readiness bugs** (leaked secrets in logs, self-signed ALB cert, single environment, etc.) are tracked and ranked in root [`PLAN.md`](../PLAN.md) — fix those before building anything below; a feature roadmap on top of an insecure foundation just ships the insecurity to more users faster.

---

## 2. How to read §§3–5

Every item states: **what it is**, **why a PM tool needs it** (with the comparable in Jira/Linear/Asana named), and **what pattern fits AstriX's existing stack** rather than a generic "add X" — since the whole point of this exercise is calibrating judgment, not accumulating a buzzword list. Items are phased by dependency and payoff, not by difficulty — some Phase 1 items are the least glamorous work in this document.

---

## 3. Backend & feature roadmap

### Phase 1 — table-stakes for a PM tool (nothing here is exotic; Jira/Linear/Asana all ship all of it)

| Item | Why AstriX needs it | Pattern |
|---|---|---|
| **Task comments** | A task with no discussion thread isn't a PM tool, it's a spreadsheet. Every competitor's core loop is "assign → discuss → resolve." | New `Comment` model (`taskId`, `authorId`, `body`, soft-delete flag), nested under `task.route.ts`. Author-or-admin edit/delete, same `roleGuard` pattern already used everywhere else. |
| **File attachments** | Screenshots, specs, design files attached to a task — universal in Jira/Linear. This is the "file upload" the brief named, and it's genuinely load-bearing, not decorative. | **Don't proxy file bytes through Express.** Backend issues a short-lived S3 **presigned PUT URL** (client uploads directly to S3), then records `{ key, filename, size, mimeType, uploaderId }` in a new `Attachment` model on success callback. Enforce size/MIME allowlist both client-side (UX) and via S3 bucket policy/Lambda (real boundary). New S3 bucket, separate from the frontend's build bucket — different access pattern, different lifecycle policy, must never be public. |
| **File preview/viewer** | Clicking an attachment and downloading a blob is 2010-era UX. Images/PDFs should preview inline (Jira, Linear, Notion all do this). | Images: signed S3 GET URL + `<img>`, no extra infra. PDFs: `<iframe>`/`pdf.js` against the same signed URL. **Thumbnail generation** (for a fast grid view) is the one piece of real backend work — an S3-upload-triggered Lambda (or a queue consumer, see Phase 2) running `sharp`, writing back a `-thumb` variant. Don't build a generic "file viewer service" — this is 90% frontend, 10% a thumbnail job. |
| **Activity log / audit trail** | "Who moved this to Done, and when" is expected, not optional — and it's also the cheapest form of the audit trail a diligence conversation (already flagged in root `PLAN.md`) will ask about. | Append-only `Activity` model, written from the service layer (not controllers — services already own the transaction boundary, see [`backend/06`](./backend/06-services-and-business-logic-layer.md)) on every state-changing task/project/member mutation. This doubles as the seed of the event backbone in Phase 2 — write it as "domain event happened" now, and Phase 2 just adds subscribers. |
| **Notifications (in-app, then email)** | "You were assigned/mentioned/unassigned" — if a user has to poll the board to find out something changed, the product feels dead. This is the single highest-leverage item on this list. | In-app: `Notification` model + a `GET /notifications` endpoint + unread count, populated by the same mutation points that write `Activity`. Email: reuse the existing Resend provider, but **move it off the request path** — it's already a known bug class (root `PLAN.md` P0 #5 is a token-in-logs bug that only exists because email sending happens synchronously inline). This is the forcing function for Phase 2's queue, not a "nice to have someday." |
| **Search** | Typing a task title into a search box is the #1 navigation pattern in Jira/Linear once a workspace has more than ~30 tasks. | Start cheap: a MongoDB **text index** on `Task.title`/`description` and `Project.name` — zero new infra, `$text` query in the existing service layer. Do **not** stand up Elasticsearch/Meilisearch/Atlas Search until a real workspace's task count and query patterns justify it (ranking, typo tolerance, faceted filters) — that's a Phase 3+ decision, revisit with actual usage data. |

### Phase 2 — collaboration & the event-driven backbone

This phase is one coherent piece of infrastructure — a message broker — that then unlocks four separate features. Build the broker once, not once per feature.

| Item | Why | Pattern |
|---|---|---|
| **Background job queue** | Email sending, thumbnail generation, and notification fan-out are all "do this soon, not now, and retry if it fails" work — exactly what a request/response HTTP handler is the wrong place to do it. | **SQS**, not a new dependency: `infra/modules/iam/main.tf` already has unused `sqs:SendMessage`/`sqs:ReceiveMessage` IAM statements scaffolded — someone already planned for this. Add an SQS queue (+ DLQ) per job type, a `services/queue.service.ts` producer, and a small worker (`npm run worker`, a **second ECS service** sharing the same Docker image but running a consumer loop instead of Express) as the consumer. This is "event-driven" done at the right scale for one team's PM tool — not Kafka, not a home-grown event store. |
| **Domain events → subscribers** | `Activity` (Phase 1) already captures "what happened." Formalize it: services publish a typed event (`TaskAssigned`, `TaskStatusChanged`, `CommentAdded`) to the queue; the worker fans it out to notification-creation, email-send, and (later) webhook-delivery consumers, each independently retryable. | Same SQS infra as above. This is the actual "event-driven" pattern the brief asked about — a small, real one, not a rewrite into event sourcing (see §6). |
| **Real-time updates (WebSocket)** | This is the brief's "multiple people working on one project/board" ask. What real PM tools actually do: when teammate A moves a card or comments, teammate B's open board updates **without a refresh** — Linear and Jira's live board, not Google-Docs-style character-level co-editing (AstriX has no shared-document feature for that to apply to — see §6). | `socket.io` (or plain `ws`) on the existing Express process, authenticated the same way as REST (JWT off the connection handshake). Broadcast scope: **workspace/project room**, not global. The one real infra wrinkle: ECS runs `desired_count = 2`, so a socket opened against task A won't see a broadcast originating on task B — needs a **Redis pub/sub adapter** (`socket.io-redis-adapter`) so events fan out across all running tasks, plus **ALB target-group stickiness** (or accept the adapter alone is enough — verify under load, don't assume). This is also where "who else is viewing this task" presence indicators become cheap to add. |
| **Caching layer (Redis)** | Three real uses, not "cache everything": (1) the pub/sub backbone above needs Redis anyway, so this isn't even a new piece of infra, just a second use of one; (2) hot, low-churn reads — workspace metadata, role/permission lookups — currently hit Mongo on every request; (3) replace `rate-limit-mongo` with a Redis-backed limiter, which is both faster and the industry-standard pairing (`rate-limiter-flexible` or `express-rate-limit`'s Redis store). | AWS ElastiCache for Redis (new `infra/modules/redis` — a security group opening 6379 from ECS only, per the existing `infra/modules/security` scaffolding that already documents this port). At AstriX's current scale, Upstash (serverless Redis, pay-per-request) is a legitimate cheaper alternative to a standing ElastiCache node — decide based on expected request volume, not by default. |
| **Outbound webhooks** | Once a real event backbone exists, "notify Slack/a customer's system when a task changes" is nearly free — and it's the standard way a PM tool becomes an integration platform instead of a silo (Jira, Linear both sell this as a feature). | A `Webhook` model (workspace-scoped URL + subscribed event types + a signing secret), delivered by a queue consumer with retry/backoff and delivery-log visibility — mirrors Stripe's own webhook design, which is worth studying directly since Phase 3 adds a real Stripe integration anyway. |

### Phase 3 — monetization & multi-tenant hardening

| Item | Why | Pattern |
|---|---|---|
| **Billing (Stripe)** | Root `PLAN.md` already talks about "sale conversation" and "diligence" — that means this is heading toward being sold as a product, and a PM SaaS with no billing model isn't monetizable. Workspace-level (not user-level) subscription, matching how Jira/Linear/Asana all bill — a workspace is the tenant. | Stripe Checkout + Customer Portal (don't hand-roll card handling — that's a PCI-scope mistake, not an engineering-effort one). One `Subscription` field on `Workspace` (plan tier, seat count, Stripe customer/subscription IDs), enforced at the service layer (seat-count check on invite, feature-gate check on plan-restricted actions). Stripe webhooks land on the same outbound-webhook delivery infra built in Phase 2, just inbound — reuse the signature-verification pattern. |
| **Per-plan rate limiting & quotas** | Once there's a paid tier, "free workspace hits the same rate limit as an enterprise workspace" stops making sense. | Rate limiter (already Redis-backed from Phase 2) keyed by `workspaceId` + plan tier instead of just IP/user. |
| **Public API + API keys** | Only build this if a real integration need shows up (a customer asking to script against AstriX) — don't build a public API speculatively. | Workspace-scoped API keys (hashed at rest, same pattern as refresh-token hashing already in `auth.service.ts`), scoped permissions reusing the existing RBAC permission map. |

### Phase 4 — only if a specific feature justifies it (don't pre-build)

- **Collaborative document editing (CRDT/Yjs)** — only becomes relevant if AstriX adds an actual shared-document feature (a Confluence-style "Project Notes/Wiki" page). Do not build character-level real-time editing infrastructure for task titles/descriptions — nobody co-edits a task title, and Phase 2's WebSocket layer already covers "see updates live," which is what tasks actually need.
- **i18n** — only once there's a non-English-speaking customer base to justify the maintenance cost.
- **Mobile app / PWA** — revisit once the web product has product-market fit; a PWA wrapper is cheap later, a native app is not cheap ever.

---

## 4. Infra, cloud & CI/CD roadmap

Carryover from root `PLAN.md` (self-signed ALB cert, leaked key, single environment, unverifiable environment-reviewer gates) are **blockers**, not roadmap items — fix those first; nothing below matters if the current environment isn't trustworthy.

### New infra Phase 1/2 features above actually require

| Need | Addition | Notes |
|---|---|---|
| File uploads | New S3 bucket (uploads), bucket policy blocking public access, CORS scoped to the frontend origin, lifecycle rule for orphaned/expired presigned-upload attempts | Separate from the existing frontend-build S3 bucket — different write pattern (many small writers, not one CI pipeline), different blast radius if misconfigured |
| Thumbnailing | Either an S3-event-triggered Lambda, or a consumer on the Phase 2 SQS queue | Lambda is simpler for a single, isolated, bursty job; prefer it over adding this to the main worker unless the worker already exists for other reasons |
| Background jobs | SQS queues (+ DLQs) per job type, a second ECS **service** (same image, worker entrypoint) in the existing cluster | IAM policy statements for this already exist unused in `infra/modules/iam` — this is finishing, not starting, that scaffolding |
| Caching + pub/sub | ElastiCache Redis (new module) or Upstash | New security group; ECS-task-only ingress on 6379, matching the existing SG-chain pattern in `infra/modules/security` |
| WebSocket at 2+ tasks | Redis pub/sub adapter (above) + verify ALB behavior for long-lived connections (idle timeout, target stickiness) | The ALB's default idle timeout (60s) will kill idle WebSocket connections unless raised or the app pings — check this explicitly, it's a real gotcha, not hypothetical |
| Billing | Stripe webhook endpoint (public, unauthenticated by JWT, authenticated by Stripe signature instead) — needs a route explicitly carved out of the blanket `authenticate` mount pattern | Document this exception clearly; it's the one deliberate hole in "every domain router sits behind `authenticate`" |

### Broader production-maturity gaps (independent of the feature roadmap)

| Area | Gap | Why it matters |
|---|---|---|
| **Environments** | Only `dev` exists (already a P0 in root `PLAN.md`) | Every feature above should land in a real `staging` environment before `prod` — right now there's nowhere to test a WebSocket/Redis rollout safely |
| **Database migrations** | Mongoose has no schema-migration tool; today's "migration" is deploying new code against old documents and hoping defaults cover the gap | Add `migrate-mongo` (or similar) once `Comment`/`Attachment`/`Notification` models start landing — backfilling/reshaping documents needs a real, ordered migration story, not tribal knowledge |
| **Observability** | CloudWatch covers infra-level metrics (CPU/mem/5xx); nothing traces a request across services, and there's no frontend error tracking | Add OpenTelemetry tracing once there's a worker + queue + Redis in the request path — "why is this task assignment notification slow" becomes a multi-hop question the moment Phase 2 ships. Add Sentry (or equivalent) on both frontend and backend — `ErrorBoundary`'s `console.error` today is a dead end in production, already flagged in `docs/frontend/09`'s gap list |
| **Secrets rotation** | SSM/KMS storage is solid; rotation is manual | Fine at current scale; automate (Lambda-triggered rotation, or a documented quarterly runbook) once there's a real on-call rotation to hand it to |
| **WAF** | CloudFront has no WAF attached (noted as a Medium in root `PLAN.md`) | Becomes non-optional once file uploads and a public API exist — both are new attack surface |
| **Backup/DR** | MongoDB Atlas backup exists at the platform level; no documented RTO/RPO or restore runbook in this repo | Write the runbook before it's needed under pressure, not during an incident |
| **Deployment strategy** | ECS rolling deploy + circuit breaker (good default) | Blue/green (via CodeDeploy) or canary is worth revisiting only once real user traffic makes a bad rolling deploy expensive — premature before that |

### CI/CD roadmap

- SHA-pin every third-party GitHub Action (already flagged as Medium in root `PLAN.md` — do this regardless of the feature roadmap).
- Split the single shared OIDC role (plan-on-PR / apply / deploy / rollback all use one role today) into a **read-only plan identity** separate from apply/deploy/rollback — least-privilege, already flagged.
- Add a `staging` deploy stage once that environment exists: `main` → auto-deploy `staging` → manual-approval promote to `prod`, instead of `main` → `prod` directly.
- Add a Docker-base-image Dependabot ecosystem entry for `backend/Dockerfile` (flagged gap).
- Once the worker service (Phase 2) exists, its Docker build/deploy piggybacks on `deploy-backend.yml`'s existing pattern — don't build a third parallel pipeline, extend the one that already builds this image.
- Load-test gate (k6, run against `staging`) before a release that touches the hot path (auth, task mutations) — not on every PR, on release candidates.

---

## 5. Frontend roadmap

| Item | Ties to backend phase | Notes |
|---|---|---|
| File upload UI (drag-drop, progress, presigned-URL flow) + inline preview/viewer components | Backend Phase 1 | Direct-to-S3 upload means the UI owns progress tracking itself (`XMLHttpRequest`/axios upload progress events) — the request never touches the Express API except to mint the presigned URL and record metadata |
| Comment thread UI, `@mention` autocomplete | Backend Phase 1 | Mentions feed directly into the Phase 1 notification model — build the data shape with that in mind from day one |
| Notification center (bell icon, unread count, mark-read) | Backend Phase 1 | React Query polling is fine until the WebSocket layer exists; don't build a polling *and* a WebSocket path for the same data long-term |
| WebSocket client (reconnect/backoff, optimistic local updates reconciled against server broadcasts) | Backend Phase 2 | This is real complexity — reconciling an optimistic local mutation with a same-entity broadcast from another user's action needs a deliberate conflict rule (last-write-wins is fine for a task board; document that it's a deliberate choice, not an oversight) |
| Virtualized board/list rendering | — | Becomes necessary once a workspace has hundreds of tasks on one board; not needed today, but worth knowing `@tanstack/react-virtual` (same vendor as the table library already in use) before it's urgent |
| Sentry (or equivalent) error monitoring | — | Directly closes the gap already named in `docs/frontend/09`: `ErrorBoundary`'s `console.error` is production-invisible today |
| Playwright E2E suite | — | Already named as a gap in `docs/testing/07`; becomes more valuable, not less, once WebSocket/optimistic-UI logic ships — that's exactly the class of bug component tests can't catch |
| Bundle splitting (`manualChunks`) | — | Already flagged in root `PLAN.md` (1.09 MB bundle); do this regardless of the roadmap, and again after Socket.io/Stripe.js land, since both are non-trivial bundle weight |

---

## 6. Explicitly rejected / deferred (this is the part that keeps the roadmap honest)

| Idea | Verdict | Reasoning |
|---|---|---|
| Microservices split | Reject for now | One team, one deploy cadence, one database — [`Architecture.md` §1](./Architecture.md) already makes this case. Revisit only if a specific domain (e.g., the future worker) has genuinely independent scaling needs that a second ECS *service* (not a second *system*) can't satisfy. |
| Kubernetes/EKS | Reject | ECS Fargate already gives autoscaling + rolling deploys with far less operational surface. Nothing in this roadmap needs multi-cloud portability or the k8s ecosystem (operators, Helm, etc.) badly enough to justify the ops tax — see the honest survey in [`infra/06`](./infra/06-compute-and-container-orchestration-ecs-fargate.md). |
| GraphQL | Reject | REST has no under-fetching/over-fetching pain here yet — the frontend hits a small, well-known set of endpoints per screen. Revisit only if a mobile client or third-party API consumers create a real aggregation problem. |
| CRDT collaborative document editing | Defer | No shared-document feature exists to apply it to (see Phase 4). Bolting Yjs onto task fields nobody co-edits is solving a problem AstriX doesn't have. |
| Event sourcing / full CQRS | Reject | The Phase 2 event backbone (SQS + domain events + an `Activity` log) gets 90% of the benefit — audit trail, async fan-out, decoupled consumers — without committing to rebuilding every read model as a projection. Revisit only if audit/replay requirements become genuinely regulatory. |
| Multi-region active-active | Reject | Single-region with a real second environment, tested backups, and a documented DR runbook is the correct next step — not multi-region, which multiplies operational complexity for availability AstriX doesn't have paying customers depending on yet. |
| Self-hosted search (Elasticsearch cluster) | Defer | Mongo text index first (Phase 1); revisit with real usage data, not speculatively — an Elasticsearch cluster is real ops burden for a team of this size. |

---

## 7. How this maps to becoming a better engineer

This roadmap is also a deliberate skill curriculum if worked through in order — each phase forces a genuinely different kind of engineering judgment, not just more CRUD:

- **Backend**: moving business logic off the request path (queues), designing idempotent consumers (a notification or webhook delivered twice must be safe), cache invalidation (the actually-hard half of caching), multi-tenant billing correctness (seat counts, proration, webhook replay safety), and the discipline of choosing SQS-over-Kafka / Redis-over-a-generic-cache for the actual scale in front of you instead of the scale in a blog post.
- **Infra**: running a second real environment end-to-end (not just declaring it), operating a stateful new dependency (Redis) under Terraform, reasoning about ALB behavior for long-lived connections, and building the muscle of "what's the cheapest infra that satisfies this requirement" (Upstash vs. ElastiCache, Lambda vs. a queue consumer) rather than defaulting to the biggest tool available.
- **Frontend**: reconciling optimistic UI against real-time server events (a genuinely hard, common interview-level problem), file-upload UX that doesn't route bytes through your own server, and knowing when virtualization/code-splitting actually matter vs. premature optimization.

---

## 8. Suggested execution order

1. Close root `PLAN.md`'s P0s (secrets-in-logs, ALB cert, second environment) — nothing above should ship on top of an untrusted environment.
2. Backend Phase 1, in this order: comments → attachments (+ S3 bucket) → activity log → notifications (still synchronous) → Mongo text search. Each is independently shippable and user-visible.
3. Stand up the SQS worker service and move notification email off the request path — this is the smallest slice of Phase 2 that immediately pays down a real bug class (the token-in-logs issue was caused by *synchronous* email sending in the first place).
4. Redis (cache + rate limiter first, since that's low-risk) → WebSocket layer on top of the same Redis (pub/sub adapter) — don't stand up Redis for WebSockets alone if the cache/rate-limiter use case can justify it first and de-risk the infra.
5. Webhooks (outbound), reusing Phase 2's delivery infra.
6. Billing — only once product usage or an actual paying customer makes it real, not speculatively.
7. Everything in §6 stays rejected/deferred until its stated trigger condition actually occurs.

---

*Methodology: derived from a full read of `docs/Architecture.md`, all `docs/backend|frontend|infra|testing/` files, the current `backend/src` domain model, and root `PLAN.md`. Every "why" is anchored to a real, named comparable product (Jira/Linear/Asana) or an already-existing signal in this repo (e.g. the unused SQS IAM statements) — not a generic best-practices checklist.*
