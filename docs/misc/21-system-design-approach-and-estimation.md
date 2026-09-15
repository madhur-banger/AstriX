# System Design Approach & Estimation

> Part of the [misc engineering fundamentals](./00-master-engineering-fundamentals.md) module.

A blank-page system design problem — in an interview or in a real planning meeting — has a predictable failure mode: jumping straight to architecture ("we'll need a load balancer, a cache, a queue...") before anyone has agreed on what the system actually needs to do or at what scale. This file is a usable, repeatable approach to avoid that, plus the estimation habits that make "at what scale" an actual number instead of a vibe.

## The Approach, in Order

**1. Clarify requirements and scale first.** What does the system actually need to do (functional requirements — read-heavy or write-heavy, real-time or eventually-consistent, what the core entities are), and roughly how big (daily active users, requests/second, data volume, growth rate)? This step is cheap and prevents the single most expensive mistake in system design: architecting for a scale the system doesn't have, or missing a requirement (strong consistency, an SLA) that invalidates an entire proposed architecture later.

**2. Define the API contract.** What are the actual endpoints/operations, their inputs and outputs? This forces precision about what the system does before any component is drawn — it's much easier to spot a missing requirement ("wait, how do we handle pagination here?") staring at an endpoint list than at a box-and-arrow diagram.

**3. Sketch the data model.** What are the core entities, their relationships, and — critically — the *access patterns* (what gets queried together, what gets written together, what needs to scale independently). The access pattern is what actually drives database choice and indexing strategy, not the entity list alone.

**4. Only then, discuss architecture.** Components, their responsibilities, how data flows between them, and where the real bottlenecks and single points of failure are.

Doing architecture first is the common mistake because it's the most visually satisfying part — draw boxes, name AWS services, feel like you're "designing a system" — while actually front-loading decisions (do we need a queue? a cache? how many database replicas?) that only have correct answers once requirements, scale, and access patterns are known. A load balancer and a cache proposed before anyone said how many requests/second the system handles is a guess dressed up as a design.

## Back-of-Envelope Estimation

A handful of real numbers, worth having memorized rather than re-derived every time:

- **Seconds per day ≈ 86,400** (60 × 60 × 24 = 86,400; close enough to "~100,000" or precisely "~86.4k" for quick math) — and per month, roughly 2.6 million seconds. A "1 million requests/day" system is therefore roughly 12 requests/second *average* — a number that sounds unimpressive until you remember peak traffic is typically several times the average, not the average itself.
- **Typical latency order-of-magnitude**: reading from memory (a cache hit, an in-process variable) is **microseconds**; reading from disk (an uncached database query) is **single-digit to tens of milliseconds**; a network round-trip within the same region is **low single-digit milliseconds**; a cross-region network round-trip is **hundreds of milliseconds** (physically bounded by the speed of light over real intercontinental distance, not just infrastructure overhead). These three tiers — memory vs. disk vs. cross-region network — differ from each other by roughly 3-4 orders of magnitude each, which is *why* caching and regional data placement are two of the highest-leverage performance levers that exist: they move a request from a slower tier to a faster one.

**Worked example** — estimate reads/second for 10 million daily active users, each loading a page that triggers 5 reads:

```
10,000,000 users × 5 reads/user = 50,000,000 reads/day
50,000,000 reads/day ÷ 86,400 seconds/day ≈ 579 reads/second (average)
```

If peak traffic runs roughly 3-5x average (a common, reasonable assumption to state explicitly rather than silently), that's **~1,700–2,900 reads/second at peak** — a number that starts to make concrete claims possible: is a single database instance enough, does read replication matter, does this justify a cache. The exact multiplier matters less than doing the arithmetic and stating the assumption out loud — a wrong assumption stated explicitly can be corrected by whoever's listening; an assumption skipped entirely can't be checked at all.

## The Scaling Playbook

Most real systems that actually need to scale go through the same ordered sequence — not because every system needs every stage, but because each stage is meaningfully cheaper in operational complexity than the next, and skipping ahead pays a real, avoidable cost:

1. **Vertical scaling first** — a bigger instance (more CPU, more RAM). This is "free" in the sense that it requires zero architectural change, no new failure modes, no new operational surface — just a bigger box. The cost of skipping past it: reaching for horizontal scaling or sharding before a single, larger instance was ever tried burns real engineering time solving a problem a config change might have solved.
2. **Add a cache** — the next cheapest lever, given how many orders of magnitude separate a memory read from a disk read (see above). The cost of skipping it: every read pattern that's naturally hot (the same handful of records read constantly) hits the database at full cost repeatedly, for no reason, right up until the database itself becomes the bottleneck.
3. **Horizontal scaling behind a load balancer** — multiple stateless application instances splitting load, once vertical scaling and caching alone aren't enough. This is where real operational complexity starts: instances need to be stateless (or externalize state to something shared), health checks and deployment coordination become real concerns. The cost of skipping straight here from step 1: paying that complexity tax before a bigger box or a cache would have been sufficient.
4. **Introduce a queue to decouple slow work** — move anything that doesn't need to happen synchronously in the request/response cycle (email sending, thumbnail generation, notification fan-out) off the hot path and into an asynchronronously processed queue. The cost of skipping it: slow, non-critical work keeps blocking request latency and consuming request-handling capacity for work that didn't need to run inline at all.
5. **Shard the database only when a single primary genuinely can't take the write volume.** Sharding — splitting data across multiple database instances by some partition key — is the most operationally expensive stage on this list: cross-shard queries and transactions become genuinely hard, rebalancing a poorly chosen shard key later is a significant migration, and every piece of application code that queries the database now has to be shard-aware. The cost of reaching for it before it's needed is the single most expensive mistake on this entire list: it multiplies operational complexity permanently, for a scaling problem the system doesn't actually have yet, when the first four stages — a bigger box, a cache, horizontal app-tier scaling, and a queue — often push the point where a single database primary actually becomes the bottleneck much further out than it first appears.
