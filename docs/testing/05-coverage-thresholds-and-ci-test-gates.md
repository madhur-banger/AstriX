# Coverage Thresholds and CI Test Gates

Files 01–04 covered *how* AstriX's backend tests are written — unit, integration, e2e, and the fixtures/doubles that make them possible. This file is about a different question: once you have a pile of tests, how do you know they're *enough*, and how do you stop a PR from merging when they aren't? That's a measurement problem (coverage) bolted onto an enforcement problem (a CI gate), and the two are easy to conflate. This file keeps them separate on purpose, because they fail in different ways.

## 1. The Landscape

"Is this codebase tested enough" has no single agreed-upon answer, but the industry has converged on a handful of named, well-understood ways to approximate one.

**Line/statement coverage.** The simplest and by far the most common metric: instrument the code so that every time a line (or statement — the two are close cousins and often reported together) executes during a test run, it's marked as "covered." At the end of the run, divide covered lines by total lines. A tool like Istanbul (the engine behind `nyc` and Jest's built-in coverage) or V8's own native coverage instrumentation (what Vitest uses by default) produces this number cheaply, as a side effect of just running the suite — no extra test-writing discipline required. Its fatal weakness is well known and easy to demonstrate:

```javascript
function divide(a, b) {
  return a / b;
}

test("divide runs", () => {
  divide(10, 2); // line executes -> 100% line coverage
  // no assertion at all
});
```

That test gives `divide` full statement coverage while asserting *nothing* about its behavior — it wouldn't catch a bug if `divide` returned `a + b` instead. Line coverage answers "did this code run during tests," not "did tests verify this code behaves correctly." It's gameable, and it's the metric most teams reach for first because it's free and universally supported.

**Branch coverage.** A stricter sibling: instead of asking whether a line executed, it asks whether every branch of every conditional executed — both the `true` and `false` side of an `if`, every case of a `switch`, both sides of a `? :`. Consider:

```javascript
function greet(name) {
  if (name) {
    return `Hello, ${name}`;
  }
  return "Hello, stranger";
}

test("greet with a name", () => {
  expect(greet("Ada")).toBe("Hello, Ada");
});
```

That test gives `greet` 100% line coverage (both return statements execute across... no, wait — actually only one branch runs). This is exactly branch coverage's value: a single test that only ever calls `greet("Ada")` reaches 100% *line* coverage on nothing, since the `"Hello, stranger"` line never executes — but a version of `greet` with all its logic on one physical line via ternary would show 100% line coverage while completely missing the `else` path. Branch coverage forces both paths of `if (name)` to actually run before it reports 100%, closing a whole class of "line coverage lied to you" gaps around conditionals. It's strictly more expensive to satisfy than line coverage and catches meaningfully more, but it's still fundamentally the same category of measurement: did code *execute*, not did tests *verify*.

**Mutation testing.** A fundamentally different and much more rigorous approach, with Stryker (`stryker-mutator`) as the standard tool in the JS/TS ecosystem. Instead of asking "did my tests execute this code," mutation testing asks "if I deliberately broke this code, would my tests notice?" The tool automatically generates "mutants" — small, mechanical corruptions of the source, like flipping `>` to `>=`, negating a boolean condition, or changing `+` to `-` — reruns the test suite against each mutant, and reports the percentage of mutants that were "killed" (caused a test to fail) versus that "survived" (all tests still passed despite the bug). A mutant surviving is a direct, concrete demonstration that some test claiming to cover that code isn't actually asserting anything meaningful about it — it's the automated version of catching the `divide` example above. The tradeoff is real: mutation testing is dramatically slower, because it means re-running some or all of the test suite once per mutant, potentially hundreds or thousands of times for a modest codebase, and even with the optimizations modern mutation testers apply (incremental runs, test-impact analysis, mutant sampling) it's still far too slow to run on every commit the way line coverage is. That's why, even in disciplined 2026 organizations, mutation testing tends to show up as a periodic or opt-in signal — a nightly job, a pre-release gate, a metric tracked on a dashboard — rather than a hard block on every single PR.

**Coverage as a soft dashboard signal vs. a hard CI gate.** Orthogonal to *which* metric you measure is *what you do* with the number. Tools like Codecov, Coveralls, and SonarQube's quality gates are built around reporting and trend-tracking: they post a comment on the PR showing coverage delta, render a diff view highlighting exactly which new/changed lines aren't covered, and can be configured to fail a check — but many teams deliberately leave them informational, since a hard global-coverage requirement can block an otherwise-fine PR for reasons unrelated to that PR's own quality (see §5). The alternative is what this file is actually about: making the coverage tool itself part of the test run, with a threshold that causes the test *process* to exit non-zero — no dashboard, no separate service, just "the build fails" if the number drops below the line.

Neither line coverage nor branch coverage nor a hard gate is wrong on its own; they're different points on a cost/rigor tradeoff, and most real engineering orgs run more than one of these simultaneously rather than picking exactly one. AstriX's actual choice sits at one specific, legible point on that spectrum, described next.

## 2. AstriX's Choice

AstriX's backend uses Vitest's built-in `v8` coverage provider to measure statement, branch, function, and line coverage, with numeric thresholds (90% statements, 85% branches, 90% functions, 90% lines) enforced as a **hard, blocking CI gate** — `npm run test:coverage` runs in the `check-backend` job of `pr-check.yml`, and if any threshold isn't met, the step (and the whole PR check) fails outright. The frontend gets no equivalent treatment at all: `check-frontend` runs plain `npm run test`, with no coverage instrumentation, no threshold, and nothing in `client/vite.config.ts` configuring a `coverage` block in the first place. This is a real, stated asymmetry, not an oversight glossed over — the backend enforces a numeric floor on every PR; the frontend enforces nothing about coverage at all.

## 3. AstriX Implementation

The coverage configuration lives inline in the same `vitest.config.ts` that configures the rest of the backend's test environment (setup files, timeouts, `environment: "node"` — see file 00 for the full file in context). Here is the `coverage` block in full, comment included:

```typescript
    // Thresholds set once real coverage existed to compare against (see
    // backend/PLAN.md) - full suite currently sits around 99% statements/
    // lines, ~95% branches. Thresholds are set a bit below that so normal
    // future work has headroom, while still failing the build if coverage
    // regresses meaningfully.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/@types/**",
        "src/docs/**",
        "src/seeders/**",
        "src/index.ts",
        "src/config/database.config.ts",
        "src/config/swagger.config.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
```
*`backend/vitest.config.ts:40-62`*

That comment is worth reading twice, because it's an unusually honest and well-reasoned piece of threshold-setting rationale rather than a number pulled out of thin air. It says, explicitly: the thresholds weren't derived from some abstract "90% is industry best practice" rule of thumb — they were set *after* the suite already existed and already had real, measured coverage (around 99% statements/lines, around 95% branches at the time this was written), and the 90/85/90/90 numbers are deliberately set a bit *below* that observed baseline. The reasoning for the gap between "what we actually have" and "what we require" is spelled out too: headroom for normal future work, while still catching a *meaningful* regression. That's a specific design philosophy — a floor set intentionally below the ceiling, not a target the team is straining to hit — and it's worth returning to in §5, because it's the crux of the biggest tradeoff this file has to explain.

`provider: "v8"` selects V8's native coverage instrumentation (accessed via the `@vitest/coverage-v8` package, visible in `backend/package.json:54` as a devDependency) over the alternative Istanbul-based provider Vitest also supports. V8 coverage works by using the V8 engine's own built-in code-coverage instrumentation (the same mechanism Chrome DevTools uses), which requires no source transformation and tends to be faster than Istanbul's approach of injecting counters at parse time — a reasonable, low-friction default for a Node backend with no unusual bundling requirements.

The `include`/`exclude` globs scope what counts toward the aggregate at all — a file outside `include` or caught by `exclude` doesn't contribute either covered or uncovered lines to the percentage; it's simply invisible to the calculation. `include: ["src/**/*.ts"]` casts a wide net over the entire backend source tree, and `exclude` then carves out six specific categories, examined in depth in §4.

Now, the CI side — the actual mechanism that turns "vitest computed a percentage" into "the PR can't merge." Both relevant jobs from `pr-check.yml`, side by side to make the asymmetry impossible to miss:

```yaml
  check-backend:
    name: Backend Build Check
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: backend/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Type-check & build
        run: npm run build

      - name: Test (coverage-gated)
        run: npm run test:coverage

      - name: Build Docker image (not pushed)
        run: docker build -t astrix-backend:pr-${{ github.event.pull_request.number }} .

      - name: Scan image for vulnerabilities
        uses: aquasecurity/trivy-action@0.24.0
        with:
          image-ref: astrix-backend:pr-${{ github.event.pull_request.number }}
          severity: CRITICAL,HIGH
          exit-code: '1'
          ignore-unfixed: true
```
*`.github/workflows/pr-check.yml:21-55`*

```yaml
  check-frontend:
    name: Frontend Build Check
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: client
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: client/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm run test

      - name: Build (with placeholder API URL)
        run: npm run build
        env:
          VITE_API_BASE_URL: https://placeholder.example.com
```
*`.github/workflows/pr-check.yml:57-84`*

The step names alone tell the story: `check-backend`'s test step is literally labeled `Test (coverage-gated)` and runs `npm run test:coverage`; `check-frontend`'s equivalent is labeled plainly `Test` and runs `npm run test`, with no coverage word anywhere in the job.

The scripts those steps invoke, in full, from each package's `package.json`:

```json
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
```
*`backend/package.json:11-13`*

```json
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ui": "vitest --ui",
```
*`client/package.json:12-14`*

The backend has three test scripts, and only one — `test:coverage` — appends `--coverage` to `vitest run`, which is the flag that activates the `coverage` block in `vitest.config.ts` and its thresholds. `test` and `test:watch` run the exact same suite with no coverage measurement at all — a developer running `npm test` locally, or CI running plain `npm run test`, gets pass/fail per test with zero coverage overhead, which matters for iteration speed (coverage instrumentation isn't free). The frontend, by contrast, has no `test:coverage` script at all — `test:ui` is its third script, launching Vitest's browser-based UI reporter, not a coverage variant — and `client/vite.config.ts`'s `test` block confirms there's nothing to invoke even if someone tried: `environment: "jsdom"`, `setupFiles`, `css: false`, and nothing else.

## 4. Request/Data Flow

Trace what actually happens when a PR triggers `check-backend` and reaches the `Test (coverage-gated)` step:

1. `npm run test:coverage` expands to `vitest run --coverage`. `run` (as opposed to bare `vitest`) tells Vitest to execute once and exit rather than enter watch mode — the correct mode for CI, where nothing should sit waiting for a file change.
2. The `--coverage` flag activates the `coverage` block in `vitest.config.ts`. Vitest loads the `v8` provider (`@vitest/coverage-v8`), which hooks into V8's native coverage collection before any test file runs.
3. The full suite executes exactly as it would under plain `npm run test` — all 46 test files across `unit/`, `integration/`, and `e2e/` (per file 00's count), with the same `setupFiles` (`testEnv.setup.ts` then `vitest.setup.ts`) booting the same `MongoMemoryReplSet`. Coverage instrumentation is a passive observer here; it doesn't change test behavior, only what gets recorded alongside it.
4. As code executes, V8 records which statements, branches, and functions in every file actually under instrumentation were hit. Vitest scopes this by the `include`/`exclude` globs from the config — so even though V8 could technically report coverage for anything it instruments, Vitest only surfaces (and later checks thresholds against) files matching `src/**/*.ts` that aren't caught by one of the six `exclude` patterns:
   - `src/@types/**` — type-only declaration files. These contain interfaces and type aliases with no runtime code at all; there's no "branch" or "statement" for V8 to observe executing, because nothing in a `.d.ts`-style types file ever runs. Including it would either report a meaningless 100% (nothing to fail) or, depending on tooling quirks, an undefined/0% that would drag the aggregate down for no real reason. Excluding it is a correctness fix, not a leniency.
   - `src/docs/**` — Swagger/OpenAPI documentation source (schema definitions consumed by `swagger-jsdoc`, per file 09 of the backend module). Like types, this is metadata describing the API, not executable business logic with meaningful branches to cover.
   - `src/seeders/**` — one-off data-seeding scripts (`role.seeder.ts`, invoked via `npm run seed` per `backend/package.json:7`), run manually/administratively, not part of the request-handling code paths the test suite is built to exercise. Testing a seeder script the same way as a service function would mean writing tests whose only job is to prove "a hardcoded list of roles gets inserted," which doesn't buy meaningful confidence.
   - `src/index.ts` — the process bootstrap/wiring file (Express app construction, middleware mounting order, `app.listen`). This is exactly the kind of file that's exercised by the application *starting up successfully* rather than by targeted unit assertions — its correctness is really an e2e/startup concern, not something a coverage percentage over its own lines usefully measures.
   - `src/config/database.config.ts` — the MongoDB connection-setup module. Establishing a live database connection is precisely what the test suite's in-memory `MongoMemoryReplSet` setup replaces for testing purposes (see files 00 and 02) — the real connection logic to a real MongoDB URI isn't something the test suite ever exercises by design, so it can't organically earn coverage without a bespoke integration test whose only purpose is measuring this one file.
   - `src/config/swagger.config.ts` — Swagger UI/spec wiring, in the same category as `src/docs/**`: configuration and documentation plumbing, not business logic.
5. Once the suite finishes, Vitest aggregates covered vs. total statements/branches/functions/lines across every included, non-excluded file, and compares each aggregate percentage against its configured threshold: statements ≥ 90, branches ≥ 85, functions ≥ 90, lines ≥ 90.
6. If any one of those four falls below its threshold, the `vitest` process exits with a non-zero status code — this is Vitest's own built-in behavior when `thresholds` is configured, no custom scripting required on AstriX's part.
7. A non-zero exit code from `npm run test:coverage` means the `Test (coverage-gated)` step in `check-backend` is marked failed by GitHub Actions.
8. Because subsequent steps in the same job (Docker build, Trivy scan) never run in a failed job by default GitHub Actions semantics, the whole `check-backend` job fails.
9. If branch protection on `main` requires `check-backend` as a required status check (the standard GitHub configuration for this kind of gate, and the only way a failing job actually *blocks* anything rather than just showing a red X), the PR's merge button is disabled until the author pushes a fix that gets coverage back over every threshold.

That's the entire mechanism: no custom coverage-checking script, no separate tool — Vitest's native `--coverage` flag plus a `thresholds` object in its own config file is sufficient to turn "test coverage regressed" into "this PR cannot merge."

## 5. Design Decisions & Tradeoffs

The headline decision, per the config's own comment, is setting thresholds *below* current measured coverage (90/85/90/90 against an observed ~99%/~95%) rather than *at* it. It's worth being explicit about why that's the more defensible choice and not just a hedge. Setting the threshold equal to current coverage would make the gate a ratchet with zero slack: any single future PR that adds a new file, function, or branch not immediately covered by a test would fail CI — even a legitimate PR whose author simply hasn't finished writing tests yet, or one that adds a small amount of intentionally-uncovered scaffolding. Setting the threshold meaningfully below the current baseline converts the gate from "coverage must never move" into "coverage must not collapse" — it tolerates normal day-to-day variance (a new file added before its tests, a branch temporarily untested mid-PR) while still catching the failure mode a coverage gate actually exists to catch: someone merging a large amount of genuinely untested code, or accidentally deleting test files, and dragging the aggregate down by several points.

The alternative approach, common enough in the 2026 industry to be a named, standard feature rather than an edge case, is a *ratcheting* or *diff-coverage* gate: rather than a fixed global floor, the tool measures coverage specifically on the lines changed by *this* PR (Codecov's "patch coverage" feature is the canonical example — it can require, say, 90% coverage on new/changed lines specifically, independent of what the rest of the repository looks like). AstriX did not choose this. It chose the simpler global-floor approach instead, and that's a real tradeoff with a real cost, not a free simplification: a global floor evaluates the codebase in aggregate, so a single new file with genuinely poor coverage can still pass the gate cleanly if the other tens of thousands of already-well-tested lines are enough to keep the overall percentage above 90/85/90/90. The gate, as configured, does not guarantee that *this specific PR's new code* meets any bar at all — it only guarantees the *codebase as a whole*, after this PR lands, still clears the floor. A diff-coverage tool closes exactly that gap, at the cost of another dependency, another service integration (most diff-coverage tooling is a third-party SaaS product, not a built-in test-runner feature the way Vitest's `thresholds` is), and generally more configuration surface area to maintain. AstriX's choice trades some precision for the appeal of "zero extra infrastructure, one config block, one CI step" — a defensible tradeoff for a project at this stage, but one worth naming honestly rather than assuming the current gate catches everything a more sophisticated setup would.

A second, quieter design decision is scope: `include: ["src/**/*.ts"]` with the six-item `exclude` list means the thresholds apply to `src/` only — the coverage numbers say nothing at all about `backend/tests/` itself (test helper code, fixture factories, the `vitest.setup.ts` bootstrap) or anything outside `src/`. That's conventional — coverage tools almost universally measure application code, not test code — but it's worth stating plainly since it's implicit in the glob rather than spelled out anywhere in the config's comments.

## 6. Security Considerations

A coverage gate is a genuinely useful regression tripwire, but it is a blunt instrument specifically from a security standpoint, and it's worth being precise about exactly where the bluntness lives rather than treating "90% coverage" as a vague assurance of safety.

Line/statement coverage — even at 90% — says nothing whatsoever about *which* 10% is uncovered. A codebase can hit 90% statement coverage while its uncovered lines happen to concentrate almost entirely in error-handling branches, authorization edge cases, or input-validation failure paths — precisely the code most likely to hide a real vulnerability, because it's the code exercised only under attacker-controlled or unusual conditions rather than the happy path a feature's primary tests naturally walk through. A coverage percentage is an aggregate; it cannot distinguish "the 10% we're missing is a rarely-hit logging statement" from "the 10% we're missing is the `if (!hasPermission) throw` check on a sensitive route." Branch coverage, at AstriX's 85% threshold, is a meaningfully better proxy for exactly this reason — it specifically forces both the "permission granted" and "permission denied" paths of a conditional to have executed at least once, rather than letting a single happy-path test claim full credit for a two-sided `if`. But "better proxy" is not "guarantee" — a branch can execute under test without a meaningful assertion following it (echoing the `divide` example from §1), and mutation testing is the tool that would actually verify the assertions on that branch are load-bearing, which AstriX's setup does not do.

The `exclude` list itself is worth revisiting through a security lens, not just a "does this file have runtime branches" lens. Is it safe that `src/config/database.config.ts` and `src/index.ts` sit outside the coverage requirement entirely? The reasonable position, argued in §4, is that both are largely wiring/bootstrap code rather than business logic — but the practical consequence of that exclusion is that bugs in *how the database connects* or *how the server actually boots and mounts its middleware* are caught, if at all, only by integration and e2e tests successfully running at all (since those tests transitively depend on both files working correctly to even start), not by any coverage signal specifically pointing at those files. That's a meaningfully different safety net than "we measured this and it's covered" — it's closer to "if this were badly broken, everything downstream would presumably fail too," which is true, but it's an implicit guarantee riding on the rest of the suite rather than a direct one. For `database.config.ts` in particular — connection-string handling, TLS options, pool configuration are all places a misconfiguration could weaken a real production security posture — the absence of direct coverage measurement isn't dangerous by itself, but it does mean nobody would be alerted by a coverage regression if a change to that file quietly weakened something, the way they would be for a change to, say, an auth service function still inside the `include` scope.

## 7. Best Practice Check

Hard-blocking line/branch coverage gates in CI remain extremely common in 2026 and are still considered solid, unremarkable baseline practice — a reasonable engineering org running Vitest, Jest, or pytest-cov with a numeric floor wired into its pipeline is doing exactly what most peer organizations do. AstriX's backend setup — v8-provider coverage, a floor set intentionally below observed coverage rather than at it, wired as a genuine blocking CI step rather than an informational dashboard comment — matches that baseline cleanly and, per §3's reading of the config comment, is *more* thoughtfully justified than the median implementation, which more often just copies a round number like "80%" from a blog post without measuring anything first.

Where more mature 2026 organizations tend to go further is by layering additional tooling *on top of* a baseline gate like AstriX's, not by replacing it — this file's landscape section named the two most common additions: mutation testing (Stryker) run periodically or on a slower cadence to validate the *quality* of assertions behind the coverage numbers, and diff/patch-coverage tooling (Codecov-style) to guarantee new code specifically meets a bar rather than relying on the aggregate. AstriX has neither, and that is a legitimate, worth-naming gap rather than a failure — plenty of well-run 2026 teams also stop at "hard global-floor gate" and never add mutation testing, because the cost/benefit only tips in its favor once the codebase and team are large enough that "is this test actually asserting something" becomes a recurring, expensive-to-catch-by-review problem.

The far more notable gap, and the one worth flagging plainly rather than softening, is the frontend having *no* coverage gate whatsoever — not a lenient one, not a soft dashboard signal, nothing. `check-frontend` runs `npm run test` with zero coverage instrumentation configured anywhere in `client/vite.config.ts`, which means there is currently no automated signal at all if a frontend PR ships a large untested component or silently deletes existing frontend tests — the only backstop is `npm run test` itself failing if an *existing* test breaks, which catches regressions to tests that already exist but says nothing about the amount of new code that never got a test written for it in the first place. This isn't a shaming point — a coverage gate on `client/src` would need real thought about what threshold is achievable given the current ~22-file suite's actual coverage, exactly the kind of "measure first, set the floor slightly below" discipline the backend's own config comment demonstrates — but it is the single most concrete, low-effort improvement available to bring frontend testing rigor closer to parity with the backend. File 07 of this module picks this back up from the frontend-testing-gaps angle specifically (alongside the missing browser-level e2e runner and the absence of MSW-based network mocking), so it's worth treating this observation here as a pointer forward rather than the full story.

## 8. Debug Drill

**Scenario:** A PR adds a new, genuinely well-tested feature — new service functions, new controller logic, tests written for all of it, everything passes locally with `npm run test`. But when the PR opens, the `check-backend` job's `Test (coverage-gated)` step fails in CI. Where do you look first?

Work through it in order of cheapest-to-check, most-likely-culprit first:

1. **Reproduce locally with the actual gate, not the plain test script.** The author likely ran `npm run test` while developing (fast, no coverage overhead) rather than `npm run test:coverage`. Run `npm run test:coverage` locally first — the exact command CI runs — before speculating about anything else. This alone often reveals the same failure CI reported, with the same numbers, letting you skip straight to the real cause instead of guessing at what's different about the CI environment (usually nothing is).
2. **Read the actual threshold-failure output.** Vitest's coverage reporter, on a threshold failure, prints which specific metric(s) — statements, branches, functions, or lines — fell short, and by how much, along with a per-file breakdown table. Don't treat "coverage failed" as one undifferentiated signal; the failing metric tells you where to look next. A branches failure specifically, for instance, points toward an `if`/`switch`/ternary whose alternate path never ran — a different investigation than a blanket statements shortfall.
3. **Check whether the new file(s) are actually inside `include` and not accidentally caught by `exclude`.** The `include` pattern is `src/**/*.ts` and the `exclude` list is a fixed set of six path globs (`src/@types/**`, `src/docs/**`, `src/seeders/**`, `src/index.ts`, `src/config/database.config.ts`, `src/config/swagger.config.ts` — the exact list from `backend/vitest.config.ts:48-55`). If the new feature happens to live under a path that a broadened glob (say, someone widened `src/config/**` at some point) would now accidentally exclude, it would silently stop contributing covered lines to the numerator while still counting nowhere at all — worth ruling in or out early since it's a one-line diff to check against the config, not a debugging session.
4. **Confirm the new file's tests are actually importing and exercising it, not a duplicate or a stale import.** It's a common enough mistake for a new test file to import from the wrong path (a leftover scaffold, a typo'd relative path that TypeScript's module resolution nonetheless resolves to *something* else) and unknowingly test nothing from the intended new module at all — meaning the module looks "written but never executed" to V8's instrumentation regardless of how thorough the tests appear when read.
5. **Rule out a regression in an unrelated, pre-existing file.** Coverage is measured in aggregate across the whole `src/` tree, not per-file — so a PR whose own new code is 100% covered can still fail the gate if it also touches (or, via refactor, changes the reachable branches of) an existing file elsewhere, inadvertently leaving a previously-covered branch now unreachable by any existing test. `git diff` the PR against `main` for any file outside the "new feature" set, and check the per-file table from step 2 for any existing file whose coverage percentage dropped, not just the new ones.
6. **Generate and read the local HTML report for a precise, file-by-file, line-by-line view.** Running `vitest run --coverage` produces an HTML report (the default v8/Istanbul-style output) that highlights exactly which lines and branches were and weren't hit, color-coded per file — far more precise than eyeballing the terminal summary table, and the fastest way to visually confirm "yes, this specific `if` branch genuinely never executed" versus "this file looks fully covered and the shortfall must be elsewhere in the aggregate."

Working through these in order — reproduce with the real command, read which metric failed, check `include`/`exclude` scoping, verify the new tests actually exercise the new code, rule out a regression elsewhere, then use the HTML report for line-level precision — turns "CI says coverage failed" from a vague red X into a specific, fixable finding almost every time, without ever needing to guess.
