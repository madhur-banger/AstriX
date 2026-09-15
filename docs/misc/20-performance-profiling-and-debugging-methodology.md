# Performance Profiling & Debugging Methodology

> Part of the [misc engineering fundamentals](./00-master-engineering-fundamentals.md) module.

"It's slow" is not a diagnosis. This file covers the actual workflows — flame graphs, Node's built-in profilers, and the concrete steps for the two most common real-world slowness reports: a slow database query and a memory leak.

## Reading a Flame Graph

A flame graph visualizes a CPU profile as stacked, horizontal bars. The **x-axis is *not* time** — it's the alphabetically-sorted (or otherwise arranged) collection of stack samples, so width represents *how much total CPU time* was spent in a function, not when it ran. The **y-axis is stack depth**: the bottom row is the entry point (e.g., `main` or the request handler), and each row above it is a function called by the one below — a child frame sitting directly on top of its caller.

The read that matters: **a wide bar near the top of the stack is a specific function consuming a lot of CPU time directly (not through something it calls further down)** — that's the hot path, the actual thing worth optimizing. A wide bar near the *bottom* just means a lot of *descendants* collectively took time; the real cost is wherever the width stops getting passed further up and starts being wide **in a leaf frame itself**. Profiling tools almost always let you click into a frame to "zoom" — isolating that subtree as its own full-width graph — which is the practical way to drill from "this general area is slow" down to "this exact function is slow."

## Node.js Profiling

Two built-in approaches, suited to different situations.

**`node --prof`** — samples the call stack periodically (a statistical, low-overhead profiler suitable for production or long-running processes) and writes a raw `isolate-*.log` file:

```bash
node --prof server.js
# ... reproduce the slow behavior while it runs ...
# stop the process, then process the log into a readable summary:
node --prof-process isolate-0x*.log > profile.txt
```

`profile.txt` breaks down time by "Summary" (ticks in JS vs. C++ vs. GC vs. shared libraries), then a "Bottom up (heavy) profile" listing the functions that consumed the most self-time directly — the CLI equivalent of reading a flame graph's widest top-row bars.

**`--inspect` + Chrome DevTools** — for interactive, visual profiling during development:

```bash
node --inspect server.js
# open chrome://inspect in Chrome, click "inspect" under Remote Target
```

DevTools' **Profiler** tab records a CPU profile with a live flame chart and a sortable function list (self time, total time); the **Memory** tab is the same connection used for heap snapshots (next section). `--inspect-brk` is the same flag with execution paused on the first line, useful when the slow behavior happens at startup rather than after the process is already running.

## Diagnosing a Slow Database Query

A repeatable, four-step workflow rather than guessing at indexes:

1. **Reproduce it in isolation.** Get the exact query and, ideally, exact parameters that are slow in production — not a similar-looking query run against a much smaller local dataset, which can look fast for reasons that don't hold at real data volume.
2. **Get the query plan.** Run the query prefixed with the database's explain mechanism (`EXPLAIN ANALYZE` in Postgres/MySQL, `.explain("executionStats")` in MongoDB) — the plan is the database's own account of how it intends to (or, with `ANALYZE`, actually did) execute the query: which indexes it used, if any, and how many documents/rows it examined versus how many it actually returned.
3. **Look for the two classic culprits** — a **missing index** (the plan shows a full collection/table scan, examining every document/row to find the few that match) or an index that exists but isn't being used (a type mismatch between the query's filter value and the indexed field, or a compound index whose field order doesn't match the query's filter pattern). What "reading a query plan for exactly this" looks like in depth — the actual `EXPLAIN` output shape, index types, and how to read "examined vs. returned" — is [`01-sql-and-relational-databases.md`](./01-sql-and-relational-databases.md)'s job, not repeated here.
4. **Apply the fix, then re-run the plan to verify.** Add the index (or rewrite the query to use an existing one), then run the exact same `EXPLAIN`/`.explain()` again and confirm the plan actually changed — an index that exists doesn't guarantee the query planner chooses it. "The query feels faster now" is not verification; a plan showing an index scan instead of a collection scan, with a documents-examined count close to the documents-returned count, is.

## Diagnosing a Memory Leak

A memory leak in a garbage-collected language (JS, most managed runtimes) isn't memory being "lost" — it's memory being *retained* because something still holds a reference to it that the developer didn't intend. The workflow is comparative, not a single snapshot:

1. **Take a baseline heap snapshot** (Chrome DevTools' Memory tab, connected via `--inspect`, or `node --heapsnapshot-signal=SIGUSR2` for a production process) once the application is in a steady, "warmed up" state.
2. **Perform the suspected leaking action N times** — deliberately, repeatedly (open and close a modal 50 times, process 50 requests through the suspect code path) — enough repetitions that a genuine per-iteration leak produces a clearly visible signal rather than noise.
3. **Take a second heap snapshot.**
4. **Compare the two snapshots' retained size**, using DevTools' "Comparison" view (or an equivalent diff in another tool) — it shows which object types and specific constructors grew in count and retained size between the two snapshots, sorted by delta. An object type whose count grew by roughly N (matching the number of repetitions) is the strong signal — it's being created once per iteration and never freed.
5. **Trace what's holding the reference.** DevTools' "Retainers" panel, for any object in the comparison, shows the actual reference chain keeping it alive — walk it up until it reaches something genuinely long-lived (a module-level variable, a singleton, `window`/`global`). The two most common real-world culprits: an **ever-growing array or map in a closure** (a cache with no eviction, an event log array that's only ever pushed to) that a long-lived function keeps a reference to, and **event listeners or timers that are added but never removed** — each one added per iteration keeps its entire closure scope (including anything it captured) alive for as long as the listener itself is registered, which in a leak is: forever.
