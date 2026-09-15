# Observability Theory

> Part of the [misc engineering fundamentals](./00-master-engineering-fundamentals.md) module.

Any specific tool — CloudWatch, Datadog, Prometheus — is an implementation of a smaller set of underlying ideas: what evidence to collect, how to decide something is wrong, and when a human actually needs to be told. This file covers those ideas independent of tooling.

## The Three Pillars

- **Logs** — discrete, timestamped events, usually free-text or structured (JSON) records of something that happened: a request came in, an exception was thrown, a job finished. Good for: rich, arbitrary detail about one specific occurrence — exactly what you want when debugging a single incident after the fact. Bad for: answering aggregate questions ("what's our error rate over the last hour") without first running a query over a potentially huge volume of individual lines.
- **Metrics** — numeric measurements aggregated over time into a time series (CPU utilization sampled every 60 seconds, request count per minute). Good for: cheap to store and query at scale, ideal for dashboards, trends, and threshold-based alerting. Bad for: explaining *why* a number moved — a metric shows CPU jumped to 90%, not which specific request or code path caused it.
- **Traces** — the path a single request takes across services, represented as a tree of timed **spans** (one span per hop: "API gateway → auth service → database"), each with its own duration, letting you see exactly which hop in a multi-service call chain ate the latency. Good for: pinpointing the slow or failing hop in a distributed request. Bad for (or rather, pointless for): a single-process, single-hop system — tracing exists to solve a *multi-service* problem, and its cost (instrumentation, a tracing backend to run or pay for) isn't worth paying for a request that only ever touches one process.

The three are complementary, not substitutes: a trace tells you *which* hop was slow, a log from that hop tells you *why* (a stack trace, a slow query, a specific input), and a metric tells you *whether this is happening more than usual* right now versus a normal baseline.

## RED and USE

Two mnemonic checklists for "what should I actually be measuring," each suited to a different kind of thing:

**RED** — for request-driven services (an API, a web server):
- **Rate** — requests per second.
- **Errors** — the rate of failing requests (5xx responses, exceptions).
- **Duration** — how long requests take (usually as a distribution — p50/p95/p99, not just an average, since an average hides a slow tail that a meaningful fraction of real users actually experience).

**USE** — for resources (CPU, disk, memory, a connection pool):
- **Utilization** — the percentage of time the resource is busy doing work.
- **Saturation** — how much work is queued waiting for the resource (a CPU run queue, a connection pool's waiting requests) — the leading indicator that utilization alone misses, since a resource can be at 70% utilization but already have a growing queue behind it.
- **Errors** — the count of error events the resource itself reports (disk I/O errors, out-of-memory kills).

The split matters because the two are answering different questions: RED asks "is the service doing its job correctly for users," USE asks "is the infrastructure underneath it healthy." A service can look fine on RED (low error rate, acceptable latency) while a resource it depends on is quietly heading toward saturation — USE is what catches that before it becomes a RED problem.

## SLI, SLO, SLA

Three related but distinct terms, easiest understood with one concrete example running through all three:

- **SLI (Service Level Indicator)** — the actual measurement: "99.95% of requests complete in under 200ms, measured over a rolling 28-day window." This is a number you compute from real telemetry, nothing more.
- **SLO (Service Level Objective)** — the internal target you hold that SLI to: "we aim to keep the 200ms-p99 SLI at or above 99.9%." An SLO is a goal a team sets for itself, typically stricter than any external promise, to leave margin.
- **SLA (Service Level Agreement)** — the external, often contractual promise made to customers, usually looser than the internal SLO and backed by a stated penalty if missed: "99.5% monthly uptime, or affected customers receive a service credit." The gap between the SLO (99.9%, internal) and the SLA (99.5%, external) is deliberate headroom — it lets the team notice and react to degradation well before it's bad enough to actually violate the customer-facing promise.

## Alerting Philosophy

The core discipline: **alert on symptoms users actually feel, not on every possible cause.** A disk crossing 80% full is a *cause* that might eventually produce a symptom (writes start failing); paging a human for it immediately, every time, at 3am, trains that human to ignore alerts — the single most damaging outcome an alerting system can produce, because it erodes trust in every alert, including the real ones. The better pattern is alerting on the symptom itself (write failures, elevated error rate, latency past a threshold) and using the underlying cause (disk usage, CPU) as supporting evidence a human pulls up *after* being paged, not as the trigger itself.

This is where the **error budget** concept comes from: if the SLO allows 0.1% of requests to fail over a 28-day window, that 0.1% is a budget to be spent, not a target to avoid entirely. A team that's nowhere near exhausting its error budget can ship faster and take more risk; a team that's burned through most of its budget partway through the window should slow down and prioritize reliability work over new features. Alerting philosophy and error budgets are the same idea from two angles: don't alert on every deviation, alert on ones that meaningfully threaten the budget users were actually promised.

## Where This Shows Up in AstriX

AstriX's actual observability stack is CloudWatch — log groups fed by the ECS `awslogs` driver, Container Insights, five CloudWatch alarms (ECS CPU/memory/task-count, ALB 5xx/unhealthy-host) publishing to a single SNS topic ([`infra/14-observability-monitoring-and-alerting.md`](../infra/14-observability-monitoring-and-alerting.md)). That's real, working logs-and-metrics coverage — structured JSON logging with a per-request ID, and alarms covering both container-level health and ALB-observed HTTP correctness — but there is no distributed tracing anywhere in the stack today, a gap that file names honestly rather than glossing over. It's also not currently a consequential gap: AstriX is one backend service talking to one external dependency (MongoDB Atlas), so there's no multi-hop request path for a trace to illuminate that structured, request-ID-tagged logs don't already cover reasonably well. That changes the moment [`ROADMAP.md`](../ROADMAP.md)'s Phase 2 lands — a background job queue and a second ECS worker service processing domain events asynchronously means a single logical action (say, a task assignment) now spans a request into the API, a queue message, and a separate worker process picking it up — three hops with no shared trace context tying them together, which is exactly the shape of problem tracing exists to solve and structured logging alone starts to strain against.
