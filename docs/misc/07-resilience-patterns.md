# Resilience Patterns

Any call that crosses a process boundary — a database query, an HTTP call to another service, a call to a third-party API — can fail, hang, or slow down in ways your code has no control over. Resilience patterns are the standard vocabulary for containing that failure instead of letting it cascade.

## Timeouts: Why Every Network Call Needs One

Without an explicit timeout, a network call's failure mode isn't "it returns an error" — it's "it hangs forever," because the default is to wait indefinitely for a response that may never come (a downstream service wedged, a TCP connection that's technically open but silent). A hung call ties up whatever resource made it: an HTTP connection-pool slot, a worker thread, a request that a client is still waiting on. Enough hung calls exhausts the pool and takes down callers that have nothing to do with the original failing service.

```js
const response = await fetch("https://api.example.com/data", {
  signal: AbortSignal.timeout(3000), // fail fast at 3s rather than hang indefinitely
});
```

A timeout converts an unbounded hang into a bounded, handleable failure. The gotcha: a timeout that's too short causes false failures under normal latency variance, and a timeout that's too long defeats the purpose — the right value is closer to "the slowest response you're willing to tolerate" than "the average response time."

## Retry With Exponential Backoff and Jitter

Retrying a failed call immediately, in a tight loop, is how a struggling downstream service gets pushed the rest of the way down — every client hammering it the instant it fails, in lockstep. Exponential backoff spaces retries out geometrically, and jitter (randomness) prevents many clients from retrying in the same synchronized instant:

```
delay = min(maxDelay, baseDelay * 2^attempt) + random(0, jitterRange)
```

```js
async function fetchWithRetry(url, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(3000) });
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
      const backoff = Math.min(10_000, 200 * 2 ** attempt);
      const jitter = Math.random() * backoff * 0.5;
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }
  }
}
```

The gotcha: retries are only safe for **idempotent** operations (a `GET`, or a `PUT`/`POST` designed to be safely repeatable, e.g. via an idempotency key). Blindly retrying a non-idempotent `POST /charge-card` can charge a customer twice.

## Circuit Breakers

A circuit breaker stops calling a downstream dependency once it's clearly failing, instead of letting every request pay the cost (and the latency) of discovering that failure individually. It has three states:

- **Closed** — normal operation. Calls pass through. Failures are counted; once they cross a threshold (e.g. 50% of the last 20 calls failed), the breaker trips.
- **Open** — calls fail immediately, without even attempting the network call, for a cooldown period. This protects both the caller (fast failure instead of a timeout wait) and the struggling downstream (no traffic while it recovers).
- **Half-Open** — after the cooldown, a limited number of trial calls are let through. If they succeed, the breaker closes (resumes normal operation). If they fail, it reopens and the cooldown restarts.

```
Closed --(failure threshold exceeded)--> Open
Open --(cooldown elapses)--> Half-Open
Half-Open --(trial calls succeed)--> Closed
Half-Open --(trial calls fail)--> Open
```

The gotcha: a circuit breaker without a sensible fallback just converts "slow failure" into "fast failure" — genuinely better for the caller's own responsiveness, but the caller still needs a real plan (cached data, a degraded response, a user-facing error) for what to return while the circuit is open.

## Bulkheads

Named after a ship's watertight compartments: isolate failure domains so one overwhelmed dependency can't exhaust resources shared with unrelated dependencies. Concretely, giving each downstream service its own connection pool (or thread pool) instead of one shared pool means a slow/hung `payments-service` can exhaust *its own* pool without also starving requests to `notifications-service`, which shares nothing with it. Without bulkheads, one slow dependency can indirectly take down calls to completely unrelated, healthy dependencies purely by resource contention.

## Rate-Limiting Algorithms

| Algorithm | How it works | Bursty or smooth | Memory cost |
|---|---|---|---|
| **Token bucket** | A bucket holds up to N tokens, refilled at a fixed rate; each request consumes one token, rejected if empty. | Allows bursts up to bucket size, then smooths to the refill rate. | O(1) per key (count + timestamp) |
| **Leaky bucket** | Requests queue into a bucket that drains (processes) at a fixed rate; the bucket overflowing rejects new requests. | Smooths output to a constant rate regardless of input burstiness. | O(1) per key, or O(queue size) if requests are actually queued |
| **Fixed window** | Count requests in a fixed wall-clock window (e.g. per-minute); reset the counter at each window boundary. | Allows up to 2x the limit right at a window boundary (a burst at 0:59 and another at 1:00). | O(1) per key — cheapest |
| **Sliding window (log or counter)** | Log: store every request timestamp, count how many fall in the trailing window. Counter: weight the current and previous fixed windows by how much of the sliding window overlaps each. | Smooth, no boundary-burst bug; log variant is exact, counter variant is an approximation. | Log: O(requests in window) per key — most expensive. Counter: O(1), same as fixed window. |

```js
// Token bucket, sketch
function allowRequest(bucket, now) {
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillRate);
  bucket.lastRefill = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}
```

The gotcha in interviews and in production alike: fixed window is the cheapest and most tempting default, but its boundary-burst behavior (2x the stated limit if traffic clusters right at a window edge) is a real correctness gap, not a theoretical one — it's the reason sliding-window counters (Redis's common rate-limiter pattern) exist as the practical middle ground between fixed window's cheapness and sliding log's exactness.
