# AstriX Engineering Curriculum — Plan & Progress Tracker

> **If you are a fresh session reading this:** this file is the single source of truth for the docs/ curriculum — what it is, how each file must be written, and exactly what's done vs. left. Read "Status" first to find the next file to write. Do not re-derive the plan from scratch; follow this document. Update the Status table (and this file's "Last updated" line) every time a file is finished — that's what keeps this resumable across sessions.

**Last updated:** 2026-09-11 · **Phase in progress:** `docs/Architecture.md`, all 10 `docs/backend/` files, all 11 `docs/frontend/` files, and all 16 `docs/infra/` files are done and verified under the v2 contract. `docs/testing/` is now ALSO complete: all 9 files (master + 8 dives, re-planned per §4/§5) written and verified — master, backend unit testing, backend integration testing, backend e2e/API testing, test doubles/fixtures/test data, coverage thresholds & CI test gates, frontend component/hook testing, frontend testing gaps & e2e considerations, security testing & scanning. **All 5 planned modules are now complete.** No further module is queued in §4.

---

## 1. Purpose

Not reference docs — a curriculum, and not just about AstriX. Every file must leave the reader (Madhur) able to:
1. Explain *why* AstriX is built the way it is.
2. Name the other real, industry-standard ways to solve the same problem — not just the one AstriX picked.
3. Reproduce any of those patterns (AstriX's or an alternative) in a *different* codebase.
4. Open an unfamiliar backend/frontend/infra codebase — one structured completely differently from AstriX — and know where to look first, because the *landscape* of approaches is familiar even if this particular arrangement of folders isn't.

Every code snippet is pulled from the real AstriX source, reproduced **in full as an actual code block** — never just a `path:line` pointer standing in for the code — with an exact `path:line` citation as its caption. Nothing invented, nothing generic, nothing hand-waved as "see the file."

**Hard boundary:** this curriculum is deliberately kept separate from the production-readiness audit at repo-root `PLAN.md`. Do not cite specific audit findings, severities, or finding numbers from that file inside `docs/`. Real git history (actual commits, actual diffs) is fair game as a teaching example — the audit document specifically is not.

**Security is a thread, not a bucket.** There is no single `docs/security/` folder. Instead, every deep-dive file — backend, frontend, infra, testing alike — carries a mandatory "Security Considerations" section (see template below), and `testing/` additionally gets one dedicated file on security *testing* practices (SAST, dependency scanning, secrets scanning). This matches how security actually gets built into a real engineering org: threaded through every layer, not bolted on as an afterthought module.

---

## 2. Depth & style contract

- **Target length:** 3,500–6,000 words of prose per deep-dive file, **plus** however much real code it takes to show what's being discussed in full — code blocks don't count against the prose target and must never be trimmed to hit a word count. Master (`00-...`) files are shorter — system maps with links out, not chapters themselves — but still carry real code, not just prose describing code.
- **Audience:** a strong engineer who wants to go from "can use this stack" to "can design, defend, and debug this stack under pressure," **in any codebase, not just this one**. Explain concepts from first principles before showing the AstriX snippet — don't assume the concept is already known.
- **No bare `path/to/file.ts:45–67` citations standing in for content.** That notation is a *caption*, not a substitute. If a snippet is discussed, the snippet's actual code must be pasted into the file as a fenced code block, immediately preceded or followed by its `path:line` citation. A reader should never have to leave the doc to see the code being explained.
- **Every file surveys the landscape before describing AstriX's choice.** For the core problem the file addresses (e.g. "how do you structure a backend's folders," "how do you handle auth," "how do you validate input"), name 2–4 real, named, industry-recognized approaches — not strawmen — with a tiny illustrative snippet or a concrete well-known example (a library, a framework convention, a company's known practice) for each, and honest tradeoffs. Only after that does the file say which one AstriX picked and show it in full. See the template below, step 1.
- **Every snippet must be real**, copied verbatim from the actual file. If a concept AstriX doesn't implement needs explaining for contrast (e.g., "here's what a circuit breaker is, AstriX doesn't have one"), say so explicitly rather than implying it exists.
- **Best-practice comparisons use current (2026) industry standard**, not what was standard when the library was first released. Say plainly where AstriX matches it, where it's a dated-but-reasonable choice, and where it's a real gap — flag gaps without shaming the codebase; the point is calibrating judgment, not scorekeeping.

---

## 3. Per-file teaching template

Every non-master file follows this eight-step skeleton, in this order, so the curriculum reads consistently end to end:

1. **The Landscape** — the general engineering problem in isolation, before touching AstriX at all. Name 2–4 real alternative approaches used across the industry to solve this exact problem (e.g. for "where does business logic live," survey transaction-script-in-controller, a service layer, and a domain-model/DDD approach). Give each a tiny illustrative snippet or a named real-world example, and honest tradeoffs — not a strawman lineup where one option is obviously right.
2. **AstriX's Choice** — one short paragraph stating plainly which approach (or blend) AstriX uses, before the code, so the reader has a label to hang the next section on.
3. **AstriX Implementation** — the real code, **reproduced in full as fenced code blocks**, each with an exact `path:line` citation. Not a summary of the code — the code.
4. **Request/Data Flow** — step-by-step trace of what actually happens at runtime, tied to the snippets above.
5. **Design Decisions & Tradeoffs** — why AstriX picked this approach over the alternatives surveyed in step 1; what it gave up to get it.
6. **Security Considerations** — what could go wrong here specifically (injection, auth bypass, secret exposure, SSRF, misconfig, etc.), how AstriX's current implementation addresses or doesn't address it. Mandatory in every file, sized to relevance (a forms-validation file talks XSS/input trust boundaries; a networking file talks least-privilege and blast radius; a testing file talks about what a test suite can and can't catch).
7. **Best Practice Check** — comparison to current (2026) industry-standard practice for this exact problem.
8. **Debug Drill** — one concrete, generic "if X breaks or behaves unexpectedly, where do you look first and why" exercise. Written as a realistic scenario, not sourced from or naming any specific finding in the root audit.

Master files (`00-...`) keep step 1 as a *brief* landscape orientation (a paragraph or table, not a full survey — that depth belongs in whichever deep dive owns the topic) and replace steps 4–8 with a full-system map for that layer: diagram, real representative code, tech-stack table, and links to each deep dive.

---

## 4. Build order

**One full module per pass**, in this order — finish and hand back the whole folder before starting the next. File counts per module are **not fixed** — split a module into as many files as the material genuinely supports; a module with many distinct components (backend, infra especially) should end up with *more* files, each tightly scoped, rather than fewer files each covering multiple unrelated concerns. The counts below are the current plan for the module in progress; frontend/infra/testing counts will likely grow similarly once reached — re-plan each module's table just before starting it, don't assume the original 6-per-module estimate still holds.

**The v2 contract (§§2–3) is not backend-specific — it applies identically to every module, full stop.** Backend was rebuilt first and is the reference example, but frontend/infra/testing are not exempt from any part of it. Concretely, when planning and writing frontend/infra/testing:
- Every non-master file still opens with a "Landscape" step (2–4 real, named, industry-recognized alternatives — e.g. for frontend state management: prop-drilling vs. Context vs. a global store like Zustand/Redux vs. server-state libraries like React Query; for infra: Terraform vs. Pulumi vs. CDK vs. ClickOps; for testing: the testing-pyramid vs. testing-trophy vs. ice-cream-cone shape) before describing what AstriX does.
- Every code reference is pasted in full as a real fenced block with a `path:line` caption — never a bare citation, no exceptions for frontend/infra/testing just because the code is JSX/HCL/YAML instead of TypeScript.
- Expect each of these modules to grow past its original ~6-7-file estimate the same way backend grew from 6 to 10 — a component that has real alternatives worth surveying (e.g. frontend state management, or infra's networking/IAM, or testing's unit-vs-integration-vs-e2e split) earns its own file rather than being a subsection of a broader one. Re-plan the table for each module against this same "split it out if it has its own landscape to survey" test, not against the old fixed count.
- Same 3,500–6,000-word prose target (plus real code on top) and same mandatory Security Considerations step for every file in every module.

1. `docs/Architecture.md` (root master — shared vocabulary/diagrams the rest link back to)
2. `docs/backend/` — master + 9 dives (expanded from an initial 6 — see Decisions log)
3. `docs/frontend/` — master + dives (re-plan file list when this module starts, following the same "split by distinct component" principle)
4. `docs/infra/` — master + dives (re-plan file list when this module starts)
5. `docs/testing/` — master + dives (re-plan file list when this module starts, incl. the dedicated security-testing file)

Within a module, files are delegated to `tech-docs-writer` subagents once that module's master file is written, each pinned to: the exact source files to read (with instruction to paste real code, not cite line ranges), the 8-step template above, and "must not invent APIs/behavior not present in the code."

---

## 5. Status tracker

Legend: `[ ]` not started · `[~]` in progress · `[x]` done

**All 5 modules complete — 47 files total.** Compressed reference below: filenames + one-line topic only (full detail lives in the files themselves — don't re-derive it, just open the file). Each module was delegated file-by-file to `tech-docs-writer` subagents per §4, verified for the 8-step skeleton, real pasted `path:line`-cited code, and 3,500–6,000-word prose (several ran longer where the domain genuinely warranted it — not padding).

### `docs/Architecture.md` — [x]
Root master: system topology, deploy flow, cross-cutting auth flow, tech-stack table.

### `docs/backend/` — 10/10 [x]
00 master (layered arch, request lifecycle, bootstrap) · 01 architecture-patterns-and-project-structure (layered vs. feature-based vs. hexagonal vs. MVC) · 02 authentication-and-authorization (JWT + rotating session + Google OAuth + RBAC) · 03 middleware-and-request-pipeline · 04 error-handling-patterns (`AppError`/`asyncHandler`/`errorHandler`) · 05 validation-strategies (Zod-in-controller) · 06 services-and-business-logic-layer · 07 database-schema-design (10 Mongoose models) · 08 database-queries-and-transactions (`mongodb-memory-server`) · 09 api-design-and-external-providers (REST, Swagger, Resend/Google adapters).

Gaps found (independent, not audit findings): `errorHandler` omits `errorCode` in 3/8 branches; duplicate-key branch misuses `VALIDATION_ERROR`; OAuth callback/workspace-join validate ad hoc instead of shared Zod convention; no `.lean()`/`select:false` anywhere; Swagger has schemas but no documented `paths`; `removeMemberFromWorkspaceService` has a non-transactional multi-write gap.

### `docs/frontend/` — 11/11 [x]
00 master (component tree, provider nesting, 3-layer state model) · 01 project-structure-and-component-patterns · 02 routing-and-code-splitting (`react-router-dom` v7) · 03 client-state-management (Zustand+immer) · 04 server-state-and-data-fetching (React Query) · 05 forms-and-validation (`react-hook-form`+Zod) · 06 authentication-and-authorization-ui (memory-token + axios refresh interceptor + client RBAC) · 07 api-layer-and-http-client (axios+`api.ts`) · 08 ui-component-library-and-styling (Tailwind+Radix+shadcn) · 09 error-handling-loading-states-and-resilience (`ErrorBoundary`, toasts, skeletons) · 10 build-tooling-and-bundle-optimization (Vite).

Gaps: no Sentry-style monitoring in `ErrorBoundary`; its `console.error` is ungated by environment; `CustomError` typing inconsistent across `hooks/api/*.tsx`; client-side RBAC is a documented UX affordance only, never a security boundary; frontend hand-maintains `api.ts` types instead of consuming backend's Swagger spec (drift risk).

*(Frontend testing lives in `docs/testing/`, not here — taught once for both stacks.)*

### `docs/infra/` — 16/16 [x] — no Kubernetes file (AstriX runs ECS Fargate; k8s only named in file 06's landscape survey, per user instruction)
00 master (AWS topology, Terraform module graph, deploy flow) · 01 containerization-and-docker (`backend/Dockerfile`) · 02 networking-and-vpc-design (2-AZ VPC) · 03 security-groups-and-network-segmentation · 04 identity-and-access-management (ECS roles, GitHub OIDC) · 05 container-registry-and-image-lifecycle (ECR) · 06 compute-and-container-orchestration-ecs-fargate · 07 load-balancing-and-traffic-routing (ALB) · 08 tls-and-certificate-management (ACM) · 09 secrets-and-configuration-management (Parameter Store+KMS) · 10 cdn-and-static-asset-delivery (S3+CloudFront) · 11 infrastructure-as-code-with-terraform (S3+DynamoDB state, single `dev` env) · 12 cicd-with-github-actions (OIDC workflows) · 13 deployment-strategies-and-rollback (rolling + circuit breaker) · 14 observability-monitoring-and-alerting (CloudWatch+SNS+Budgets) · 15 security-scanning-and-supply-chain (tfsec/gitleaks/Trivy/Dependabot).

Split rationale (so a future session doesn't re-ask): networking/security-groups/IAM are 3 files not 1 (distinct landscapes: VPC topology vs. traffic filtering vs. identity); ALB and CloudFront+S3 are split (backend L7 LB vs. CDN/static delivery are different problems); deployment strategy (13) is split from CI/CD mechanics (12) (rollout-safety landscape vs. pipeline-tooling landscape).

### `docs/testing/` — 9/9 [x] — deep on backend (5 dives, mirrors the real 46-file suite), lighter on frontend (2 dives, 22-file suite + honest gaps), 1 security-testing file (infra crossover with `infra/15`)
00 master (pyramid as actually implemented both sides, coverage config, CI gate) · 01 backend-unit-testing (mockist unit tests, 3 model-mocking shapes) · 02 backend-integration-testing (`MongoMemoryReplSet`, `.init()` race fix) · 03 backend-e2e-and-api-testing (`buildRoutedApp`+real middleware) · 04 test-doubles-fixtures-and-test-data (`buildFake*` factories, `asConstructorMock`) · 05 coverage-thresholds-and-ci-test-gates (90/85/90/90 v8 thresholds, backend-only gate) · 06 frontend-component-and-hook-testing (RTL+`user-event`) · 07 frontend-testing-gaps-and-e2e-considerations (no Playwright/Cypress/MSW, no frontend coverage gate) · 08 security-testing-and-scanning (gitleaks/Trivy/tfsec/Dependabot, DAST gap named).

**File count is no longer fixed at 30** — grew via the "split by distinct component" principle (backend alone grew from 7→10). This table is the reference for anything built on top of the curriculum going forward.

---

## 6. Decisions log

Recorded so a future session doesn't re-ask what's already settled:

- **Depth:** textbook chapter, 3,500–6,000 words of prose per deep-dive file, plus full code (not counted against the word target).
- **Pacing:** one full module per pass (backend → frontend → infra → testing), reviewed between modules.
- **Audit separation:** `docs/` never cites root `PLAN.md` findings by number/severity/commit-of-fix. Real git history is still usable as a teaching example where it's just "here's an actual commit that changed X."
- **Security:** woven into every file via the mandatory step 6, plus one dedicated `testing/*-security-testing-and-scanning.md`. No separate top-level `docs/security/` folder.
- **Root file name:** `docs/Architecture.md` (not `MainArchitecture.md`).
- **2026-09-11 — v1 rejected, contract rewritten.** The first backend pass (master + 6 dives, ~1,050–5,600 words each) was rejected by the user for two structural reasons: (1) files described AstriX's implementation as *the* way to do things, without first teaching the general landscape of alternative approaches (e.g. layered vs. feature-based folder structure) — the user wants to be able to navigate a *differently-structured* backend later, not just this one; (2) code was cited as `path/to/file.ts:45–67` instead of being pasted, making the docs unreadable as a standalone teaching artifact. Fix, applied retroactively to the template in §§2–3 and going forward to every module: every deep-dive file now opens with a "Landscape" step surveying 2–4 real named alternatives before describing AstriX's choice, and every code reference must be a pasted, real, verbatim code block captioned with its `path:line`, never a bare citation standing in for content. The backend module was also split from 6 dives into 9 — error handling and input validation were each promoted from a subsection of a combined file into their own full chapter, and a new file 01 was added specifically for the "how should a backend's folders be organized" architecture-pattern survey the user asked for by name. `docs/Architecture.md` and `docs/backend/00-master-backend-architecture.md` (both v1) are being rebuilt under the new contract; the other 6 v1 backend files were deleted outright rather than patched, since the gap was structural, not a rough edge.
