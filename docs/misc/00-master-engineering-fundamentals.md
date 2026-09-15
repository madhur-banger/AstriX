# Misc — General Engineering Fundamentals

> This folder is different from every other module in `docs/`. [`Architecture.md`](../Architecture.md), `docs/backend/`, `docs/frontend/`, `docs/infra/`, and `docs/testing/` all teach **AstriX** — landscape of alternatives, then AstriX's actual choice, then AstriX's real code. This folder teaches the **fundamentals AstriX's specific stack never gives you an occasion to learn**, because a stack teaches you its own choices and stays silent about everything it didn't pick. AstriX is MongoDB-only, so nothing in `docs/backend/` explains SQL. AstriX runs on ECS Fargate, so nothing in `docs/infra/` explains Kubernetes beyond naming it. AstriX is React+Tailwind, so nothing in `docs/frontend/` explains the browser underneath it or raw CSS. Those are real, common, portable pieces of knowledge a strong full-stack/devops/infra engineer needs regardless of which employer's stack they land on next — and this folder exists to cover them, honestly, without pretending AstriX implements any of it.

## 1. Why this exists, and its one hard rule

Every other module's code snippets are "real, copied verbatim from AstriX." This module can't do that — most of what's below (SQL, Kubernetes, raw CSS, OWASP) isn't in this repo at all. The rule here instead: **every example must be real, correct, runnable syntax for the technology being taught** (real SQL, real `kubectl` YAML, real `iptables`/`systemctl` commands, real CSS) — never pseudocode standing in for the real thing. Where a file legitimately connects back to an AstriX decision (why Mongo instead of Postgres, why ECS instead of EKS), it says so in a short closing section — but that's a paragraph, not the point of the file.

## 2. Depth contract (deliberately lighter than the other four modules)

- **Target length: roughly 800–2,000 words of prose per file**, plus real code/config/command examples that don't count against that budget. This is a reference set, not a textbook — the other four modules are already the textbook, at 3,500–6,000 words per chapter. Don't pad to hit a number; don't cut a real example to save words.
- **Every file: core concepts → concrete example → the gotcha that actually bites people in production/interviews.** No mandatory "landscape of 2–4 alternatives" step like the other modules (there's no "AstriX's choice" to contrast against for most of these) — but a file *should* still name real competing tools/approaches by name where relevant (e.g. the message-queue file naming Kafka/RabbitMQ/SQS, not just describing "a queue" abstractly).
- **Don't re-teach what another module already owns.** If Docker fundamentals are needed, link to [`infra/01-containerization-and-docker.md`](../infra/01-containerization-and-docker.md) instead of re-explaining layers/union filesystems — this folder's Kubernetes file, for instance, assumes container fundamentals are already known and focuses on what's actually new (pods, controllers, services, the orchestration layer itself).
- **Close with a short "Where this shows up in AstriX" note, only where a real connection exists.** Not every file needs one — forcing a tie-back to a codebase that doesn't use the technology produces filler. Where it's genuine (e.g., "AstriX picked Mongo over Postgres — here's what that traded away"), it belongs; where it'd be invented, skip it.
- **No word-count padding, no invented AstriX behavior.** If a fact about AstriX is asserted, it must be traceable to something already documented in `docs/backend|frontend|infra|testing/` or `docs/Architecture.md`.

## 3. Files in this module

Grouped by cluster below; numbered flat (01–21) so the folder sorts as one sequence.

### Backend / CS fundamentals (01–09)
| # | File | Covers |
|---|---|---|
| 01 | [`01-sql-and-relational-databases.md`](./01-sql-and-relational-databases.md) | ACID, normalization, joins, indexing, query planning/`EXPLAIN` — the single largest gap, since AstriX is 100% MongoDB |
| 02 | [`02-concurrency-and-the-event-loop.md`](./02-concurrency-and-the-event-loop.md) | Processes vs. threads, Node's single-threaded event loop, microtasks vs. macrotasks, race conditions, locks |
| 03 | [`03-caching-strategies-and-invalidation.md`](./03-caching-strategies-and-invalidation.md) | Cache-aside vs. write-through vs. write-behind, TTL design, thundering herd, cache invalidation as "the hard half" |
| 04 | [`04-message-queues-and-event-driven-architecture.md`](./04-message-queues-and-event-driven-architecture.md) | Kafka vs. RabbitMQ vs. SQS/SNS, at-least-once vs. exactly-once, idempotent consumers, pub/sub vs. point-to-point |
| 05 | [`05-distributed-systems-fundamentals.md`](./05-distributed-systems-fundamentals.md) | CAP theorem, strong vs. eventual consistency, replication, sharding/partitioning, basic consensus |
| 06 | [`06-api-design-paradigms.md`](./06-api-design-paradigms.md) | REST maturity model, GraphQL, gRPC, WebSockets/SSE — when each actually wins |
| 07 | [`07-resilience-patterns.md`](./07-resilience-patterns.md) | Timeouts, retry+backoff, circuit breakers, bulkheads, rate-limiting algorithms (token bucket, leaky bucket, sliding window) |
| 08 | [`08-design-patterns-in-practice.md`](./08-design-patterns-in-practice.md) | GoF patterns as they actually show up in real backends — adapter, strategy, factory, decorator, observer |
| 09 | [`09-security-fundamentals-owasp-and-cryptography.md`](./09-security-fundamentals-owasp-and-cryptography.md) | OWASP Top 10 as one unified checklist, symmetric vs. asymmetric crypto, hashing vs. encryption, TLS at the concept level |

### Frontend fundamentals (10–14)
| # | File | Covers |
|---|---|---|
| 10 | [`10-browser-internals-and-rendering.md`](./10-browser-internals-and-rendering.md) | Critical rendering path, reflow/repaint/composite, the JS engine (parse → compile → execute), the event loop in a browser context |
| 11 | [`11-web-performance-and-core-web-vitals.md`](./11-web-performance-and-core-web-vitals.md) | LCP/INP/CLS, how to profile with DevTools/Lighthouse, perf budgets |
| 12 | [`12-accessibility-fundamentals.md`](./12-accessibility-fundamentals.md) | WCAG levels, semantic HTML, ARIA (and when not to use it), keyboard/screen-reader navigation |
| 13 | [`13-css-fundamentals-beyond-utility-frameworks.md`](./13-css-fundamentals-beyond-utility-frameworks.md) | Box model, flexbox/grid mechanics, cascade/specificity, what Tailwind is abstracting away |
| 14 | [`14-browser-storage-and-frontend-security.md`](./14-browser-storage-and-frontend-security.md) | Cookies vs. localStorage vs. sessionStorage vs. IndexedDB tradeoffs, CSP, Subresource Integrity, `postMessage` security |

### DevOps / Infra fundamentals (15–21)
| # | File | Covers |
|---|---|---|
| 15 | [`15-linux-and-shell-fundamentals.md`](./15-linux-and-shell-fundamentals.md) | Processes, file permissions, systemd, a real day-to-day CLI toolkit, shell scripting basics |
| 16 | [`16-networking-fundamentals.md`](./16-networking-fundamentals.md) | OSI/TCP-IP model, DNS resolution, HTTP/1.1 vs. 2 vs. 3, the TLS handshake — protocol-level, not AWS-resource-level |
| 17 | [`17-kubernetes-fundamentals.md`](./17-kubernetes-fundamentals.md) | Pods, deployments, services, ingress, the control plane — vs. ECS Fargate, and when you'd actually reach for it |
| 18 | [`18-observability-theory.md`](./18-observability-theory.md) | The three pillars (logs/metrics/traces), RED and USE methods, SLI/SLO/SLA, alerting philosophy — beneath any specific tool |
| 19 | [`19-git-internals-and-workflows.md`](./19-git-internals-and-workflows.md) | Objects/refs/the DAG, rebase vs. merge, trunk-based vs. GitFlow, `bisect`, real debugging workflows |
| 20 | [`20-performance-profiling-and-debugging-methodology.md`](./20-performance-profiling-and-debugging-methodology.md) | Flame graphs, Node's `--prof`/`--inspect`, diagnosing a slow query, diagnosing a memory leak |
| 21 | [`21-system-design-approach-and-estimation.md`](./21-system-design-approach-and-estimation.md) | How to approach a system-design problem from a blank page, back-of-envelope estimation, the vertical→cache→horizontal→queue→shard scaling playbook |

## 4. How this relates to `docs/ROADMAP.md`

[`ROADMAP.md`](../ROADMAP.md) is "what AstriX should build next, and why." This folder is "what you should know regardless of what AstriX builds." They overlap in places on purpose — e.g. `ROADMAP.md` proposes a message-queue for AstriX specifically; file 04 here teaches message queues as a general topic. Read the general chapter first if the concept itself is unfamiliar, then read `ROADMAP.md` for how it'd actually apply here.
