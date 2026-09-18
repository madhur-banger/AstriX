# Load testing AstriX

A k6 suite that exercises the workspace/project/task CRUD paths under configurable
concurrency, spread across a configurable population of independent simulated users.
This doc is both a how-to and a record of what we actually learned building it -
several of the "gotchas" sections below cost real debugging time and are worth
reading before you change anything.

Requires [k6](https://k6.io/docs/get-started/installation/) (`brew install k6`).

---

## 1. k6 concepts, briefly

If you've never used k6 before, the vocabulary in this doc assumes the following:

- **VU (Virtual User)**: one simulated concurrent "worker" running your script in a
  loop. More VUs = more concurrency, not more total work by itself.
- **Iteration**: one full run through your exec function (e.g. one
  `workspaceScenario()` call). An **executor** decides how iterations are handed out
  to VUs.
  - `per-vu-iterations` (k6's common default in examples): each VU runs a *fixed
    number of iterations itself*, back-to-back. If VU 3 is assigned 20 iterations,
    it does all 20 before finishing - same VU, same identity if your script picks
    identity once per VU.
  - `shared-iterations` (**what this suite uses**): a *total* iteration count is
    pulled from one shared queue by all VUs concurrently. VUs and total-work are
    fully decoupled: 10 VUs pulling from a queue of 1000 iterations means each VU
    does roughly 100, but which VU does which iteration is not fixed in advance.
- **`setup()` / `teardown()`**: special functions that run once each, outside the
  VU pool - `setup()` before any scenario starts, `teardown()` after all scenarios
  finish. Both run on a single VU, sequentially, not in parallel with the load
  phase. **k6 does not call `teardown()` at all if `setup()` throws an exception.**
  This bit us - see §5.
- **`check()`**: an assertion on a single response (e.g. "did this request return
  201?"). Checks are informational - a failed check does **not** fail the k6 run or
  set a non-zero exit code by itself. They show up in `checks_succeeded` /
  `checks_failed`.
- **`threshold`**: a pass/fail condition on an aggregated metric across the *whole*
  run (e.g. "95th percentile of `http_req_duration` must be under 1000ms"). A
  crossed threshold **does** fail the k6 run (non-zero exit code, `✗` in the
  summary). This is the distinction that mattered most in practice - see §6.
- **`k6/execution`'s `scenario.iterationInTest`**: a globally-unique, zero-based
  counter for the current scenario, incrementing across every iteration regardless
  of which VU ran it. This suite uses it to assign a *different* user to every
  single operation (see §3).

---

## 2. What this suite tests

Three scenarios, each hitting one resource's create+delete pair:

- **`workspace_crud`**: `POST /workspace/create/new` then `DELETE /workspace/delete/:id`
- **`project_crud`**: `POST /project/workspace/:id/create` then `DELETE .../delete`
- **`task_crud`**: `POST /task/project/:id/workspace/:id/create` then `DELETE .../delete`

All three run **concurrently** (k6 starts every scenario at `time: 0` unless you
stagger them), so total load on the server is the sum of all three, not sequential.
`auth_login`/`auth_register` also get exercised once per user in `setup()`.

---

## 3. Architecture: many users, not one hammering account

The core design goal - and the thing we got wrong on the first pass - was
simulating realistic load: **many distinct users each making a small number of
calls**, not a handful of accounts each making hundreds of calls back-to-back.
Concretely:

- **`NUM_USERS`** independent accounts are provisioned (`loadtest+user0@...`,
  `loadtest+user1@...`, etc., derived from `LOAD_TEST_EMAIL` via +addressing).
- Every single operation - not every VU - picks a **different** user via
  `data.users[scenario.iterationInTest % NUM_USERS]` (`scenarios.js`, `pickUser`).
  This is why the suite uses `shared-iterations`, not `per-vu-iterations`: with
  per-VU iterations, a VU would pick one user once and reuse it for every
  iteration it runs - literally "one user making many calls," the opposite of the
  goal.
- **`*_VUS`** is pure concurrency (requests in flight at once) and is fully
  independent of `NUM_USERS`. **`*_ITERATIONS`** is the total operation count for
  that scenario and defaults to `NUM_USERS`, so by default every user does ~1
  workspace op + ~1 project op + ~1 task op across the whole run. Raise
  `*_ITERATIONS` above `NUM_USERS` deliberately if you want users making repeat
  calls; raise `NUM_USERS` if you want more distinct identities instead.

### Persistent fixtures vs. ephemeral load data

Two categories of data, treated very differently:

- **Persistent**: the account itself, and one `loadtest-base-workspace` /
  `loadtest-base-project` per user. Created once (via find-or-create in `setup()`),
  reused by every later run, **not** tagged with the current run's id, never
  auto-deleted. `project_crud`/`task_crud` create their throwaway records inside a
  user's base workspace/project rather than making a new workspace per operation.
- **Ephemeral**: everything the three scenarios actually create/delete during the
  run. Named `loadtest-<runId>-...` and cleaned up two ways: inline (the same
  iteration that created it deletes it immediately after), and a `teardown()`
  backstop that lists every user's workspaces and sweeps anything still tagged with
  the current run's prefix.

**Why fixtures are persistent, not per-run**: early on, the base workspace/project
*were* recreated fresh every run. Because k6 skips `teardown()` entirely when
`setup()` throws, every failed provisioning run (we hit this from both rate limits
and an OOM - see §5) permanently orphaned one workspace per already-provisioned
user, with zero cleanup path. Switching to find-or-create with fixed names solved
it structurally: a failed run simply has nothing new to orphan.

---

## 4. Running it

### Prerequisites

1. **Docker containers up** (Postgres + Redis - see `docker-compose.yml` at the
   repo root): `docker compose up -d`. If you get `ECONNREFUSED`/`Redis connection
   error` in the backend logs, this is almost always it - not a load-test issue.
2. **Backend running with both rate limiters raised.** See §5 for why both matter,
   not just one:
   ```bash
   cd backend
   API_RATE_LIMIT_MAX=100000 AUTH_RATE_LIMIT_MAX=5000 npm run dev
   ```
   (Defaults are 300/15min and 5/15min respectively - both sized for real traffic
   from many IPs, not a load-test client that *is* one IP regardless of how many
   app-level users it simulates.)

### Option A: raw k6

```bash
cd backend/loadtest
BASE_URL=http://localhost:8000/api \
LOAD_TEST_EMAIL=loadtest@example.com \
LOAD_TEST_PASSWORD='Str0ng!Passw0rd' \
NUM_USERS=700 \
WORKSPACE_VUS=15 \
PROJECT_VUS=15 \
TASK_VUS=25 \
k6 run scenarios.js
```

| Variable | Meaning | Default |
|---|---|---|
| `BASE_URL` | API base path, including `/api` | `http://localhost:8000/api` |
| `LOAD_TEST_EMAIL` / `LOAD_TEST_PASSWORD` | Base account synthetic users are derived from | *(required)* |
| `NUM_USERS` | Independent user accounts to provision and spread load across | `10` |
| `WORKSPACE_VUS` / `WORKSPACE_ITERATIONS` | Concurrency / total ops for workspace create+delete | `5` / `NUM_USERS` |
| `PROJECT_VUS` / `PROJECT_ITERATIONS` | Same, for project create+delete | `5` / `NUM_USERS` |
| `TASK_VUS` / `TASK_ITERATIONS` | Same, for task create+delete | `5` / `NUM_USERS` |
| `RUN_ID` | Overrides the auto-generated (timestamp) tag used to name/find this run's ephemeral data | `Date.now()` |

### Option B: `run-load-test.sh` (adds error/threshold analysis + saved artifacts)

```bash
cd backend/loadtest
./run-load-test.sh 700 15 15 25   # NUM_USERS WORKSPACE_VUS PROJECT_VUS TASK_VUS
```

Writes `load-test-results/test_<N>users_<timestamp>/` containing the full k6 log,
an extracted error log, and a generated report. It exits non-zero if **either**
request-level errors crossed a count threshold **or** k6's own latency thresholds
failed (see §6 for why both checks exist - the first version of this script only
checked the former, and silently called two separate threshold-failing runs
"clean").

---

## 5. Gotchas we actually hit (read this before debugging a "weird" failure)

- **`setup()` has a 60-second default timeout.** It provisions users
  *sequentially* (one login/register + a couple of creates per user, one at a
  time) - past a few hundred users this alone exceeds 60s and k6 kills the whole
  run with `setup() execution timed out`. Fixed via `setupTimeout: "20m"` in
  `options`; raise it further if you push `NUM_USERS` into the multi-thousands.
- **Two separate, independently-sized rate limiters gate provisioning.**
  `apiLimiter` (300/15min default, `API_RATE_LIMIT_MAX`) covers everything;
  `authLimiter` (5/15min default, `AUTH_RATE_LIMIT_MAX`) covers *only*
  `/auth/login` + `/auth/register`, and - subtly - only counts **failed**
  attempts (`skipSuccessfulRequests: true`). `loginOrRegister`'s first login
  attempt for a brand-new user always fails before it registers, so provisioning
  `NUM_USERS` new users costs `NUM_USERS` counted failures against
  `AUTH_RATE_LIMIT_MAX` specifically, on the *first* run only. Both env vars need
  raising independently; raising just one still gets you a 429 on the other.
- **A k6 run from one machine is one IP, no matter how many `NUM_USERS` you
  configure.** Both rate limiters above are keyed by IP by default
  (`express-rate-limit`'s default `keyGenerator`). This is a local-testing
  artifact, not a signal about real traffic - in production, distinct users come
  from distinct IPs.
- **k6 does not run `teardown()` if `setup()` throws.** Covered in §3 - this is
  why fixtures are persistent rather than per-run.
- **Backgrounding a long-running k6 process across separate agent/session
  invocations is unreliable** - a session boundary can SIGTERM a backgrounded
  shell mid-run. If you're driving this from an automated agent rather than your
  own terminal, prefer running it in the foreground of a persistent terminal you
  control, especially for `NUM_USERS` large enough that `setup()` takes minutes.
- **This suite's own dev machine has periodically OOM-killed the backend process
  outright** (silent - no exception, just `"Shutdown complete"` in the log, then
  nothing) under combined load from Docker Desktop + Postgres + Redis + the
  `ts-node-dev` TS-compiling dev server + k6 itself. If a run fails with
  `ECONNREFUSED` partway through and the backend log just stops, check whether the
  process is still alive (`curl localhost:8000/health`) before assuming it's a
  script bug. This is almost certainly a local resource-contention artifact of a
  laptop dev environment, not something to read into as an application ceiling -
  see the verdict in §7 for how this affects confidence in absolute numbers.
- **A user's provisioned-but-broken state.** `setup()` fails loudly
  (`throw new Error(...)`) if a workspace/project create doesn't come back with an
  id, rather than silently pushing a half-provisioned user into the pool - an
  earlier version didn't have this guard, which would have made scenario-level
  failures for that user impossible to distinguish from a real app bug.

---

## 6. Reading the results correctly

**This is the single most important section**, because getting it wrong looks
exactly like a passing test. k6's summary has (at least) three independent
signals, and only reading one of them gave us a false "all good" on two separate
real runs:

| Signal | What it means | Fails the run? |
|---|---|---|
| `checks_succeeded` / `checks_failed` | Per-response assertions (e.g. "did create return 201") | **No** - informational only |
| `http_req_failed` | % of requests with a non-2xx/network-level failure | Only if it crosses its own threshold (`rate<0.05` here) |
| **`THRESHOLDS` block, `✗` marks** | Aggregate performance targets (e.g. `p(95)<1000` on create latency) | **Yes** - non-zero k6 exit code |

We initially had 0% `http_req_failed` and 100% `checks_succeeded` on two different
runs (700 and 1000 users) where **every latency threshold had actually failed**
(p95 of 2.1-2.7s against a 1000ms target) - meaning every request eventually
*succeeded*, just far slower than the target. `run-load-test.sh`'s original error
analysis only grepped for `❌`-tagged request failures logged by `scenarios.js`,
so it reported "0 errors" on both - a materially misleading "all clear." The fixed
version reads k6's own `THRESHOLDS` block directly and treats a crossed threshold
as a failure in its own right, separate from request-level error counting.

**Takeaway for anyone reading a run's output by hand**: always check the
`THRESHOLDS` block specifically, not just `http_req_failed`/`checks_succeeded` -
"zero errors" and "fast enough" are two different claims.

---

## 7. Is this load testing good enough?

**For correctness under a large, diverse user population: yes.** Every clean run
we have - up to 1000 distinct users, 10,000 requests, mixed workspace/project/task
create+delete - shows 0% request failures and 100% check success. The
multi-user/multi-account design (§3) genuinely exercises per-user auth, ownership,
and role-guard paths at scale, not just one account's session reused.

**As a definitive performance/capacity benchmark: not yet**, for three concrete
reasons:

1. **Numbers were inconsistent run-to-run on this machine.** The same 700-user
   config failed p95 thresholds by 2x on one run (§6) and passed comfortably
   (p95 55-101ms) on another, with nothing in the app changed between them. Given
   the local OOM/resource-contention issues in §5, the most likely explanation is
   environmental noise (Docker/Postgres/Redis/dev-server all competing for RAM on
   a laptop), not a real intermittent app regression - but that's exactly the
   problem: **you can't currently tell those two explanations apart from this
   setup alone.**
2. **Never run against a dedicated, production-shaped environment.** Every run so
   far is against `localhost` with a laptop's Postgres/Redis containers and
   `PG_MAX_POOL_SIZE=15`. Before trusting any specific number as a capacity claim
   ("handles N concurrent users at Xms p95"), run it against a real staging
   environment sized like production, and correlate with `GET /metrics`
   (`pg_pool_waiting_count` especially - see the root `backend/src/utils/metrics.ts`)
   to know whether a slowdown is CPU-bound, DB-pool-bound, or something else.
3. **Concurrency hasn't actually been pushed hard.** `NUM_USERS` in the hundreds
   tests population/breadth, but `*_VUS` (the actual concurrency dial) has stayed
   modest (15-25) relative to that population, and every run so far has been a
   short burst (1-3 minutes), not sustained. A real capacity exercise still needs:
   a **stress run** (ramp `*_VUS` up until something actually breaks, to find the
   real ceiling instead of assuming one), and a **soak run** (moderate load
   sustained 30-60 minutes, to catch connection leaks/slow degradation that a
   short burst can't reveal).

**Bottom line**: this is a solid, correctly-built functional/regression load test
- good enough to catch a real correctness regression under concurrent multi-user
load, and to run before any change touching the workspace/project/task write
paths. It is not yet a capacity/performance benchmark you should quote a number
from - do that against non-local infra, with `*_VUS` deliberately pushed past
comfortable, and correlated against `/metrics`.
