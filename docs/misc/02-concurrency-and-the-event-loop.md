# Concurrency and the Event Loop

Concurrency bugs are some of the hardest to reproduce and the easiest to introduce, because the code reads correctly line-by-line and only misbehaves under specific interleavings. This file covers the process/thread/event-loop model, why JavaScript's async ordering is deterministic and learnable rather than mysterious, and where real races still hide even in a single-threaded runtime.

## Processes, Threads, and Node's Single-Threaded Event Loop

A **process** is an OS-level unit of isolation — its own memory space, its own file descriptors. Two processes can't accidentally corrupt each other's memory; they can only communicate through explicit channels (pipes, sockets, shared memory). A **thread** is a unit of execution *within* a process — multiple threads in the same process share memory, which makes communication cheap but means they can race on the same data unless something coordinates access.

Traditional server frameworks (a multithreaded Java or Go server) handle concurrent requests with a thread (or goroutine) per request, all sharing memory, all needing locks around anything mutable and shared. **Node.js takes a different approach for application code**: your JavaScript runs on a single thread, one call stack, one thing executing at a time. There is no `synchronized` keyword to reach for and no risk of two request handlers simultaneously mutating the same in-memory object mid-operation, because they literally cannot run at the same instant.

This doesn't mean Node is single-threaded end to end — I/O (disk reads, network calls, DNS lookups, some crypto) is dispatched to a worker-thread pool (`libuv`) or the OS kernel itself, and the main thread is notified via the **event loop** when that work completes. The event loop is a loop over phases (timers, pending callbacks, poll, check, close callbacks) that pulls completed work off queues and runs the corresponding JavaScript callback on the single main thread, one at a time, to completion — no callback can be preempted mid-execution the way an OS can preempt a thread.

## The Call Stack, Callback Queue, and Microtask Queue

Three structures matter for predicting execution order:

- **Call stack** — synchronous JS execution. Function calls push frames on; returns pop them off. The event loop cannot process anything else while the stack is non-empty.
- **Macrotask queue** (a.k.a. "callback queue" / "task queue") — holds callbacks from `setTimeout`, `setInterval`, I/O callbacks, `setImmediate`. The event loop processes **one** macrotask per loop iteration.
- **Microtask queue** — holds `Promise.then`/`catch`/`finally` callbacks and `queueMicrotask()` callbacks. Critically, the **entire microtask queue is drained completely** after the current synchronous execution finishes and after *each individual* macrotask — not just one microtask per turn.

That "drain completely, every time" rule is why promises consistently run before timers, no matter how the code is written:

```js
console.log("1: sync start");

setTimeout(() => console.log("2: setTimeout (macrotask)"), 0);

Promise.resolve().then(() => console.log("3: promise (microtask)"));

console.log("4: sync end");

// Actual output:
// 1: sync start
// 4: sync end
// 3: promise (microtask)
// 2: setTimeout (macrotask)
```

The synchronous code (`1`, `4`) runs first because nothing else can run while the call stack is occupied. Once the stack is empty, the event loop drains the microtask queue (`3`) *before* it's allowed to pull the next macrotask off the queue, even though `setTimeout(..., 0)` asked for the shortest possible delay. This ordering is a specified behavior, not an implementation detail — relying on it is safe.

## Race Conditions in Async JavaScript

"Single-threaded" does not mean "race-free." A race condition is any outcome that depends on the order two independent operations *complete*, and async JS has plenty of interleaving points — every `await` is a place where another callback can run before this function resumes.

```js
let cachedUser = null;

async function getUser(id) {
  if (cachedUser) return cachedUser;
  const user = await db.findUser(id); // <- another call to getUser() can start here
  cachedUser = user;
  return user;
}

// Two requests arrive back-to-back before either await resolves:
getUser(1); // sees cachedUser === null, starts a DB call
getUser(1); // also sees cachedUser === null (the first call hasn't written cachedUser yet), starts a second DB call
```

Both calls pass the `if (cachedUser)` check before either `await` resolves and writes back to `cachedUser`, so the "cache" doesn't prevent a duplicate DB query — it just races. This exact shape (check a condition, `await` something, then act on the stale condition) is the single most common concurrency bug in Node backends, and it looks completely correct on a single read-through.

## Why Node Rarely Needs Mutexes — and Where the Race Moves Instead

Because only one callback runs at a time on the main thread, you never need a mutex to protect a plain in-memory JS object from two callbacks writing to it *simultaneously* — that simultaneity is structurally impossible. This is a real and significant simplification versus a multithreaded server.

But the race above shows the danger didn't disappear — it moved to the gap between an `await` and whatever happens after it. The database itself is the place this most often resurfaces as a genuine "check then write" race, because a database is a second, independently-scheduled system: two Node processes (or two requests on the same process) can both run `SELECT` (check "does this email already exist?") before either has run `INSERT` (write it), and both `INSERT`s can succeed unless something stops them.

```sql
-- WRONG: check-then-write race, two concurrent requests can both pass the check
SELECT id FROM users WHERE email = 'a@b.com'; -- both see: no row
INSERT INTO users (email) VALUES ('a@b.com');  -- both insert -> duplicate

-- RIGHT: let the database enforce it atomically
CREATE UNIQUE INDEX idx_users_email ON users (email);
INSERT INTO users (email) VALUES ('a@b.com'); -- the second one now fails with a unique-constraint violation
```

A unique index turns "check then write" into a single atomic operation the database guarantees, rather than two operations your application code has to hope run in the right order. For anything that spans more than one write, wrapping the whole check-and-act sequence in a database transaction (with an appropriate isolation level — see [`01-sql-and-relational-databases.md`](./01-sql-and-relational-databases.md)) closes the same class of gap by making the check and the write appear atomic to every other concurrent transaction.

## Where This Shows Up in AstriX

This exact check-then-write shape is a TOCTOU (time-of-check-to-time-of-use) race, and AstriX's refresh-token rotation logic already deals with a version of it, even though its own docs don't name it that way. When a refresh token is redeemed, the service reads the session's stored `refreshTokenHash`, compares it to the presented token's hash, and — if they match — rewrites the hash to the newly issued token, all inside `refreshAccessTokenService`. Two concurrent redemption attempts against the same session are exactly the kind of "read, decide, write" gap described above; AstriX's mitigation isn't a lock, it's *detection*: because rotation makes the old token single-use, a second request presenting an already-rotated token gets treated as reuse and the whole session is invalidated rather than silently allowing two live token pairs. See [`docs/Architecture.md`](../Architecture.md) (the refresh-token rotation and reuse-detection section) for the real code.
