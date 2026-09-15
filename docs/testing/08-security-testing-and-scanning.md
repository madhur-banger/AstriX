> Part of the [AstriX engineering curriculum](../Architecture.md), under [Testing](./00-master-testing-strategy.md).

# Security Testing and Scanning

Every other file in this module has treated a test as something that answers one question: does the code behave correctly? A unit test asserts a function returns the right value. An integration test asserts a real database round-trip produces the right state. An E2E test asserts a real HTTP request through real middleware produces the right response. This file is about a different, narrower question that the same CI pipeline also answers, automatically, on every pull request: does the code (or its dependencies, or its container image, or its Terraform) contain a *known-dangerous pattern* — a leaked credential, a vulnerable package, an insecure cloud resource shape? These are still automated tests. They still run in `pr-check.yml` and `infra.yml` next to the Vitest suites covered in files 01–07. They still produce a pass/fail signal that blocks a merge. The only thing that changes is what they're testing *for*: not "is this logically correct," but "does this match a catalogue of things known to go wrong."

That distinction is worth holding onto, because it's easy to mentally file "security scanning" under a completely different bucket from "testing" — as an infra concern, a compliance checkbox, something bolted on separately from the test suite. AstriX's own CI configuration argues against that framing directly: the `secret-scan` job in `pr-check.yml` runs as a peer of `check-backend` and `check-frontend`, in the same workflow, gated by the same branch-protection mechanism, on the same trigger (`pull_request` targeting `main`). The Trivy step doesn't live in a separate "security" workflow either — it's a step *inside* `check-backend`, the same job that runs `npm run test:coverage`. Shift-left security tooling is shift-left *testing*: the same philosophy that says "catch a broken function in a two-second unit test instead of a five-minute E2E run instead of a production incident" says "catch a leaked API key in a ten-second CI step instead of a breached credential instead of a security incident." Different failure mode, same economics.

This file surveys the landscape of tools that do this kind of testing, states plainly which categories AstriX actually has wired into CI, walks through the real configuration for each, and traces exactly what happens — mechanically, step by step — when one of these automated security tests fails. The infra module's [`15-security-scanning-and-supply-chain.md`](../infra/15-security-scanning-and-supply-chain.md) already covers three of these same tools in depth from the infrastructure angle — how tfsec's Terraform analysis interacts with the module tree, the full mechanics of the two-stage container scanning story (Trivy at PR time, native ECR scan-on-push at deploy time), the specific asymmetry between those two stages' severity thresholds. This file doesn't re-derive that depth. Where the infra file already owns a piece of mechanics, it's cited rather than repeated; what's here instead is the testing-practice framing — SAST vs. SCA vs. secrets scanning vs. container scanning vs. DAST as categories of automated test, why AstriX draws its line where it does, and an honest accounting of what a test suite built entirely from pattern-matching against known-bad signatures structurally cannot catch.

---

## 1. The Landscape

"Automatically test for a security problem instead of a functional one" splits into several genuinely independent categories. Each one looks at a different artifact — source code, a dependency manifest, git history, a built container image, a running server — at a different point in the pipeline, for a different class of mistake. None of them substitutes for another; a codebase that runs four of these five and skips one has a real, specific blind spot in exactly the shape of whatever it skipped, not a redundant gap it can shrug off.

### (a) Static Application Security Testing (SAST)

SAST tools read an application's own source code — the code your team actually wrote, not its dependencies and not its infrastructure definitions — looking for security-relevant logic flaws directly in that code: a SQL query built with string concatenation instead of parameterized binding, user input flowing unsanitized into `eval()` or a shell call, an authorization check with an inverted condition, a hardcoded cryptographic key sitting in a constant. **Semgrep** is the most common lightweight entrant: it pattern-matches against a parsed AST using rules that read almost like the code they flag (`pattern: $QUERY = $A + $B` style matching against string-concatenated SQL, roughly), is fast enough to run on every PR, and ships a large open-source rule registry alongside the ability to write project-specific rules in an afternoon. **CodeQL**, GitHub's own engine, goes deeper: it compiles the codebase into a queryable relational database and runs genuine interprocedural dataflow queries against it, which lets it trace a value from an untrusted source (`req.body.email`) through several intervening function calls to a dangerous sink (a raw query, a `child_process.exec` call) — catching a class of bug a purely syntactic tool like Semgrep would miss because the taint crosses a function boundary. **SonarQube** sits somewhere between the two in a typical setup, bundling security-focused static rules ("Security Hotspots") alongside its broader code-quality analysis, usually run as a self-hosted or SaaS dashboard rather than a pure CI step. The tradeoff across all three is the same shape: faster and shallower (Semgrep) versus slower, heavier to configure, and semantically deeper (CodeQL); SonarQube trades some of both for a unified dashboard that also tracks non-security code smells.

What SAST catches that nothing else on this list can: a vulnerability that exists entirely inside code your own team wrote, with every dependency fully patched and every cloud resource correctly configured. A SQL injection in a hand-written Mongoose or raw-query string is invisible to a dependency scanner (the driver package itself isn't vulnerable — the query string is), invisible to a secret scanner (nothing there resembles a credential), and invisible to container or IaC scanning (the database and the image are both configured fine; the flaw is in application logic). **AstriX does not run a dedicated SAST tool against its own application source.** It's worth being precise about a common point of confusion here: tfsec, which AstriX does run (covered in §2–3 below), analyzes *Terraform*, not application code — it's an IaC-specific scanner, not a general-purpose SAST tool, and finding tfsec in the pipeline is not evidence of SAST coverage for the Express/React code in `backend/src` or `client/src`.

### (b) Dependency / Software Composition Analysis (SCA) scanning

SCA tooling reads a project's dependency manifests — `package.json`/`package-lock.json`, in AstriX's case — and cross-references every resolved version against a database of known, publicly disclosed vulnerabilities. **Dependabot** is GitHub-native: it reads lockfiles, checks them against the GitHub Advisory Database, and — distinctively — opens a pull request bumping the affected package to a patched version, so the artifact it produces is a diff, not just an alert. **Snyk** is the dominant third-party alternative, with broader multi-ecosystem vulnerability coverage in some cases plus license-compliance scanning Dependabot doesn't attempt. **`npm audit`** is the lowest-friction option: built directly into the npm CLI, checks the resolved `node_modules` tree against npm's own advisory feed, runs with zero setup either locally or as a CI step (`npm audit --audit-level=high`), but doesn't open PRs or track state across runs the way Dependabot does.

What SCA catches that nothing else can: a real, disclosed CVE living inside a transitive dependency several levels deep in the tree — code nobody on the team wrote and has no visibility into by reading their own source files. A SAST tool generally doesn't analyze `node_modules`; a secret scanner has nothing there to match against. This is squarely SCA's job, and it's the one category on this list where "test" and "fix" arrive together — a Dependabot PR is simultaneously the failing assertion and the patch.

### (c) Secrets scanning

Secrets scanning looks for literal credential material accidentally committed to a repository — API keys, private keys, database connection strings with embedded passwords — via a mix of provider-specific regex signatures (an AWS access key ID always starts `AKIA` followed by sixteen more characters, for instance) and Shannon-entropy heuristics for generic high-entropy strings that don't match any known format but still look secret-shaped. **gitleaks** is the open-source CLI AstriX runs, scanning a git diff or a repo's full commit history against a built-in ruleset. **TruffleHog** does the same regex-and-entropy detection but its more capable tiers add live credential verification — actually calling the provider's API with the discovered key to confirm whether it's still active, the difference between "this looks like an AWS key" and "this is a currently-valid AWS key." **GitHub's own native secret scanning** runs automatically on public repos (and private ones with GitHub Advanced Security), partners directly with many credential providers to auto-revoke a leaked key on detection, and its push-protection feature goes one step further than every tool named here: it can block the `git push` itself before the secret ever lands in the remote's history.

What secrets scanning catches that nothing else can: this is the only category here not looking for a *vulnerability* at all — it's looking for a literal, already-compromised piece of material. A codebase with zero known CVEs, a spotless SAST report, and a perfectly configured cloud environment is still instantly compromised the moment a real credential sits in a commit anyone with read access can see.

### (d) Container image scanning

Once application code and its dependencies are baked into a Docker image, a new surface appears that neither SCA (which reads source-level manifests, not the final filesystem) nor SAST (which reads application code, not the base OS layer underneath it) ever inspects: the actual OS packages and language-runtime libraries physically present in the image's layers. **Trivy** — the tool AstriX runs — unpacks an image's layers, inventories every OS package and language dependency it finds, and checks each against CVE databases. **Grype** (from Anchore) does substantially the same job with a different scanning engine and database backend. **Snyk Container** folds this into the same commercial platform as Snyk's SCA offering, for teams already paying for that dashboard.

What container scanning catches that nothing else can: a vulnerable OS-level package that arrived via the *base image* — `node:20-alpine`'s bundled `openssl` or `libc`, say — which no `package.json` entry could ever reference or reveal. AstriX's own use of Trivy, and the second, independent scanning layer that runs against the same image after it's pushed to ECR, are covered in registry-level detail in the infra module rather than re-derived here; see [`../infra/15-security-scanning-and-supply-chain.md §3.2–3.4`](../infra/15-security-scanning-and-supply-chain.md) for the full mechanics of both stages side by side, including a real asymmetry the infra file names plainly between what each stage's severity gate actually checks.

### (e) Dynamic Application Security Testing (DAST)

Every category above analyzes an artifact at rest — source text, a manifest, git history, an image's filesystem — without ever running the application. DAST is structurally different: it attacks a **running instance** of the application over the network, the way a real attacker would, sending crafted HTTP requests and observing the actual responses. **OWASP ZAP** (Zed Attack Proxy) is the dominant open-source entrant — it can crawl an application's routes and then throw a library of attack payloads at each one (SQL injection strings, XSS payloads, auth-bypass attempts) purely by watching request/response behavior, with no access to or understanding of the source code at all. **Burp Suite** is the dominant commercial tool doing the same class of work, widely used in both automated pipelines and manual penetration testing.

What DAST catches that nothing else on this list can: vulnerabilities that only manifest in the actual request/response cycle of a live system — an authentication bypass that only shows up when a real session token is manipulated against a real running auth middleware, an injection point that behaves differently once an actual database driver and actual connection pool are involved instead of a static read of the query-building code. A SAST tool can flag a *suspicious pattern* that looks like it could allow injection; DAST can prove an actual request against an actual running server actually succeeds at it (or doesn't). **AstriX has no DAST tooling anywhere in its pipeline.** This is a meaningful, specific gap, not an oversight buried among many — it's the one category on this list AstriX has zero tooling for.

The tradeoff that explains why DAST is the one most commonly skipped, at AstriX's size and at most comparably-sized teams: SAST, secrets scanning, dependency scanning, and container scanning are all relatively cheap, fast, and fully automatable against a static artifact that already exists the moment code is pushed — that's exactly what makes them "shift-left," runnable in a CI job that finishes in well under a minute against nothing more than a checked-out repo or a locally built image. DAST requires an actual running environment — a real deployed (or deploy-like) instance with real routes to attack, meaning either a dedicated staging deployment or spinning the full application stack up inside CI itself — and it's inherently slower, since it has to make real network round-trips against a live server rather than statically reading a file. That extra infrastructure and time cost is exactly why it's the category most frequently deferred or skipped entirely by smaller teams, AstriX included.

---

## 2. AstriX's Choice

AstriX runs three of the four "shift-left" static categories in CI as hard, blocking gates: **gitleaks** for secrets scanning, running on every pull request; **Trivy** for container image vulnerabilities, running on every pull request against the backend's freshly built Docker image; and **tfsec** for Terraform/IaC misconfigurations, running on every pull request or push that touches infra code. Alongside those three PR-time gates, **Dependabot** runs continuously on its own weekly schedule rather than per-PR, opening pull requests when a dependency has a newer or patched version available. What's absent is equally clean-cut: AstriX has **no SAST tool** scanning its own application source code in either `backend/src` or `client/src`, and **no DAST tooling** anywhere in the pipeline.

---

## 3. AstriX Implementation

### 3.1 Secrets scanning — the `secret-scan` job

The entire job, run on every pull request targeting `main`:

```yaml
# .github/workflows/pr-check.yml:1-19
name: PR Check

on:
  pull_request:
    branches: [main]

jobs:
  secret-scan:
    name: Secret Scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

As a piece of *test* configuration, this reads exactly like any other job in the same workflow: one setup step (`checkout`), one step that runs the actual check (`Gitleaks`), and an implicit pass/fail signal derived from the step's exit code — no different in shape from `check-backend`'s `npm run test:coverage` step two jobs down. `fetch-depth: 0` is the one detail specific to this being a security test rather than a functional one: the default shallow checkout would give gitleaks only the PR's final diff to scan, but a credential added in one commit and removed in a later commit on the same branch would still be sitting, live, in that branch's full history — so gitleaks needs the entire commit range, not just the net result, to actually catch it. `GITHUB_TOKEN` here authenticates the action's API calls to post results back to the PR as a check; it isn't a scanning credential, and gitleaks itself needs no cloud credentials to do its pattern-matching.

### 3.2 Container image scanning — the Trivy step inside `check-backend`

```yaml
# .github/workflows/pr-check.yml:46-55
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

This is the clearest example in this file of the "these are just tests" framing made concrete: it's literally one more step in the same job that already ran `npm run build` and `npm run test:coverage` a few steps earlier, testing a different property (does this built artifact contain a known CVE) using the exact same pass/fail-gates-the-job mechanism. The full `severity`/`exit-code`/`ignore-unfixed` policy and what each key does mechanically is already covered from the infra angle in [`../infra/15-security-scanning-and-supply-chain.md §3.2`](../infra/15-security-scanning-and-supply-chain.md) — what matters for this file is simpler: `exit-code: '1'` means a qualifying finding fails this CI *step* exactly the way a failing assertion fails a Vitest *test*, and a failed step fails the job the same way a failed test file fails `npm run test:coverage`.

### 3.3 IaC scanning — tfsec inside the `validate` job

tfsec isn't a standalone job; it's the last step in `infra.yml`'s `validate` job, which is worth seeing in full rather than as an isolated snippet, since the job's own comment states its purpose in testing terms directly — "catches formatting drift and known-bad patterns... before a human ever reads the diff":

```yaml
# .github/workflows/infra.yml:36-69
jobs:
  # -----------------------------------------------------------------------
  # VALIDATE - runs on every PR touching infra/, and before any
  # workflow_dispatch run. No AWS credentials needed - catches formatting
  # drift and known-bad patterns (the class of thing a manual audit finds
  # months later) before a human ever reads the diff.
  # -----------------------------------------------------------------------
  validate:
    name: Terraform Validate & Scan
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: infra/environments/dev
    steps:
      - uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.7.0

      - name: Terraform fmt (check only)
        run: terraform fmt -check -recursive ../../..

      - name: Terraform init (no backend, for validate only)
        run: terraform init -backend=false

      - name: Terraform validate
        run: terraform validate

      - name: tfsec
        uses: aquasecurity/tfsec-action@v1.0.3
        with:
          working_directory: infra
```

Reading this job as a whole makes the "shift-left testing" framing literal in a way the isolated tfsec step doesn't: `terraform fmt -check` and `terraform validate` are functional-correctness checks — is this HCL syntactically and structurally sound — run as ordinary CI steps with no special security framing at all, and `tfsec` sits as the very next step in the exact same job, checking a different property (does this HCL describe an insecure resource) using the identical step-fails-job-fails-PR mechanism. There's no separate "security job" here; security testing and correctness testing for Terraform are steps 4 and 5 of the same five-step job. `working_directory: infra` — rather than the job's own default working directory of `infra/environments/dev` — means this one tfsec step statically analyzes every module in the whole `infra/modules/` tree in a single pass, which the infra file covers in more depth for readers who want to trace exactly which modules that includes.

### 3.4 Dependency scanning — the full `dependabot.yml`

```yaml
# .github/dependabot.yml:1-35
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/backend"
    schedule:
      interval: "weekly"
    groups:
      backend-minor-patch:
        update-types:
          - "minor"
          - "patch"

  - package-ecosystem: "npm"
    directory: "/client"
    schedule:
      interval: "weekly"
    groups:
      client-minor-patch:
        update-types:
          - "minor"
          - "patch"

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"

  # Tracks the AWS provider version constraint in the dev environment's
  # required_providers block. The modules under infra/modules are consumed by
  # local path, so they inherit whatever this environment pins.
  - package-ecosystem: "terraform"
    directory: "/infra/environments/dev"
    schedule:
      interval: "weekly"
```

This is the one category in this file whose "test" doesn't run inside a GitHub Actions workflow at all — Dependabot is a scheduled background process built into GitHub itself, not a CI step defined in `.github/workflows/`. But the moment it opens a PR, that PR flows straight back into the same testing machinery as any other change: a Dependabot PR bumping a `backend` package triggers `pr-check.yml` exactly like a human-authored PR would, meaning `check-backend`'s full suite — `npm run build`, `npm run test:coverage`, the Docker build, and the Trivy scan — all run against the bumped dependency before that PR can merge. A dependency bump that breaks a unit test, or one that (ironically) swaps in a *newer* package version that happens to introduce a fresh CVE flagged by Trivy, gets caught by the same gates covered in files 01–07 and §3.2 above, not by anything special about how Dependabot PRs are treated.

---

## 4. Request/Data Flow

**gitleaks: every PR, full history, immediate block.** The trigger is `pull_request` targeting `main` (`pr-check.yml:3-5`); `secret-scan` runs as its own independent job (`pr-check.yml:7`), not gated behind `check-backend` or `check-frontend` finishing first — all three jobs start in parallel the moment the PR event fires. `actions/checkout@v4` with `fetch-depth: 0` (`pr-check.yml:12-14`) pulls the complete commit history for the PR's branch, not just its tip. `gitleaks/gitleaks-action@v2` (`pr-check.yml:16-19`) then scans every commit in that range against its regex-and-entropy ruleset. Any match at all — one matched pattern, anywhere in the range — makes the action exit non-zero, which fails the `secret-scan` check on the PR. If branch protection on `main` requires this check (the branch-protection mechanism itself belongs to the CI/CD file, not re-derived here), the merge button is blocked outright, independent of whether `check-backend` and `check-frontend` both pass cleanly. There's no severity tiering here the way there is for Trivy — a match is a match, and the job fails.

**Trivy: after the image is built, inside the same job, CRITICAL/HIGH with a fixability filter.** Trivy doesn't run standalone — it runs as a step inside `check-backend`, *after* `docker build` has already produced a real local image tagged with the PR number (`pr-check.yml:46-47`). `aquasecurity/trivy-action@0.24.0` (`pr-check.yml:49-55`) then scans that image's layers. `severity: CRITICAL,HIGH` scopes what's reported and gated on to only those two tiers — MEDIUM/LOW/UNKNOWN findings are still scanned and appear in the step's log output, but don't affect pass/fail. `exit-code: '1'` means any qualifying finding fails the step, which fails the job, which blocks the merge the same way a failing `npm run test:coverage` run would. `ignore-unfixed: true` is the one flag worth being precise about: a finding only counts toward that fail/pass decision if a patched version of the affected package actually exists right now — a CVE with no available fix anywhere upstream is scanned, appears in Trivy's output, but does not fail the build. Put plainly, this flag means the gate only ever blocks a merge for a vulnerability that is *currently fixable* — if this step is red, there is, by construction, a fix available to apply.

**tfsec: on infra-touching changes, before any `terraform apply` runs anywhere.** The trigger is narrower than the other three — `pull_request` scoped to `paths: ['infra/**', '.github/workflows/infra.yml']` (`infra.yml:3-8`), plus manual `workflow_dispatch` runs. `validate` is the first job in the workflow and the one every other job (`plan-on-pr`, the manual `terraform` job) depends on via `needs: validate` (`infra.yml:79,140`) — nothing downstream runs at all if `validate` fails, which means tfsec, as the last step in that job, sits directly upstream of every path that could eventually reach a real `terraform apply`. It needs no AWS credentials (the job comment says so explicitly) because it's reading Terraform source text statically, the same way `terraform fmt`/`terraform validate` two steps earlier read it — no cloud API calls are involved in finding an open security group or an unencrypted resource in HCL.

**Dependabot: on its own clock, then through the exact same gates as any human PR.** Unlike the three tools above, Dependabot's own trigger isn't a PR event — each `updates` entry fires on its own `schedule: interval: weekly` (`dependabot.yml:5,15,25,33`), checking each ecosystem's current lockfile/provider-constraint against known advisories independent of any human activity. When it finds something to bump, it opens a normal PR against the affected directory. From that point forward, that PR is indistinguishable from a human-authored one to the rest of the pipeline — it triggers `pr-check.yml` exactly as covered above, going through `secret-scan`, `check-backend` (build, test, Docker build, Trivy), and `check-frontend` the same way, and merges only if all three pass, exactly as any other PR would.

---

## 5. Design Decisions & Tradeoffs

The unifying design choice across all four tools is the same one, repeated four times: gitleaks, Trivy, and tfsec are all free, open-source, and integrate into GitHub Actions with a single `uses:` line and a handful of `with:` keys; Dependabot is free and built directly into GitHub itself, requiring nothing more than one YAML file at the repo root. The alternative path — a paid unified platform like Snyk or GitHub Advanced Security, which can consolidate SAST, SCA, secrets scanning, and container scanning into one dashboard with cross-referenced findings — was not taken. What AstriX gets in exchange for that is real, if unglamorous: four separate tools, four separate places a developer has to look to understand why a check failed, no single "here's your overall security posture" view, and none of the cross-tool correlation a unified platform can sometimes offer (for instance, flagging that the same vulnerable package shows up in both an SCA finding and a container-image finding). What it gives up nothing on is licensing cost — every one of these four tools runs at zero marginal dollar cost per PR — and each one is a narrowly-scoped, best-in-class tool for exactly its own job rather than a jack-of-all-trades feature inside a larger paid product.

The more consequential tradeoff is what's *not* run at all: no SAST tool for application source. The concrete cost of that gap is specific, not vague — a SQL/NoSQL injection introduced via raw string concatenation in a Mongoose query, an unsafe `JSON.parse`/`eval` call on user input, an XSS-prone spot in templated output, or an authorization check with a silently inverted boolean would need to be caught by code review or by the functional test suites covered in files 01–07 of this module, rather than by an automated scanner purpose-built to catch exactly that shape of bug on every single PR without a human needing to spot it by eye. A unit or integration test can catch this class of bug only if someone already thought to write a test asserting the vulnerable behavior doesn't happen — which is a fundamentally different, weaker guarantee than a SAST tool's rule library flagging the dangerous *pattern itself*, independent of whether anyone thought to test for its consequence.

---

## 6. Security Considerations

This entire file is, by its nature, already "security considerations" — so the useful synthesis here is ranking what the four covered categories actually protect AstriX against, and being honest about where the two gaps sit relative to each other.

Secrets scanning protects against the single most catastrophic and, empirically, most common real-world incident category in this list: a live, working credential sitting in a place anyone with repo read access — or anyone who ever clones the repo, since git history doesn't forget — can find and use immediately, no further exploitation required. Container image scanning protects the actual deployed runtime's attack surface — the OS packages and libraries the application is physically running on top of in production. IaC scanning protects the shape and blast radius of the cloud environment itself, catching a misconfiguration before it's ever provisioned rather than after an audit finds it live. Dependency scanning protects against the slower-burning but still real risk of a disclosed CVE sitting unpatched in a transitive dependency nobody on the team is actively watching.

Ranked against that, the SAST and DAST gaps are the two most actionable next steps, and they're not equally sized. Adding a SAST tool like Semgrep is a comparatively cheap addition to the exact `pr-check.yml` pattern that already exists — one more `uses:` step, no new infrastructure, no running environment required, since it reads static source the same way gitleaks and tfsec already do. Standing up real DAST tooling is a fundamentally bigger lift: it requires an actual running, deploy-like environment for a tool like OWASP ZAP to attack, which AstriX's current pipeline has no equivalent of — there's no staging deployment this could point at today without first building one. That asymmetry in cost is exactly why, if AstriX closes one of these two gaps before the other, SAST is the more natural first move.

---

## 7. Best Practice Check

Against 2026 industry-standard shift-left security testing, gitleaks + Trivy + tfsec + Dependabot as a baseline toolkit is genuinely solid and matches what a well-run small-to-mid-size team commonly runs — secrets scanning and dependency updates are close to table stakes at this point, and having a working IaC scanner plus container image scanning on top of those two is ahead of a lot of comparably sized projects, many of which stop at secrets and dependencies alone. The absence of any SAST tool for application source code, and the absence of any DAST tooling, are both real and both common gaps at this team size — worth naming plainly as things worth closing, not as a damning finding. Plenty of teams AstriX's size carry exactly this same pair of gaps; closing either one is a meaningful step up, not a sign the current setup is inadequate as it stands.

---

## 8. Debug Drill

**Scenario:** A Dependabot PR bumping a transitive dependency — a package `backend/package.json` doesn't reference directly, but that something in its dependency tree pulls in — suddenly fails the `check-backend` job's Trivy step. The PR's author (in this case, a bot, but imagine a human opening the equivalent bump manually) needs to figure out: did the *bump itself* introduce this vulnerability, or was it already present in the image before this PR and only now getting flagged for some other reason?

Work it through in order:

1. **Check whether the flagged package is the one that actually changed.** Trivy's output names the specific package and installed version it's flagging. Compare that against the Dependabot PR's diff of `package-lock.json` — is the flagged package literally the one the PR bumped, or is it some unrelated package that was already sitting in the lockfile untouched by this PR? If it's unrelated, the vulnerability was already present in every prior build of this image; this PR just happens to be the next one that triggers a fresh scan, not the cause.
2. **If it is the bumped package, check whether the new version is genuinely more vulnerable, or whether Trivy's vulnerability database itself was simply updated since the last time a build ran.** Trivy pulls from a continuously updated CVE feed — a base image or dependency that scanned clean last week can scan dirty this week purely because a new CVE against an already-installed version was disclosed in the interim, with zero code change on AstriX's side at all. Diff the old and new resolved versions of the flagged package directly; if the version didn't change, or if the CVE's "affected versions" range includes the version that was already in place before this PR, the bump isn't the cause — the disclosure timing is.
3. **Either way, the fact that this specific failure is happening at all tells you something concrete: `ignore-unfixed: true` means only vulnerabilities with a currently-available fix count toward `exit-code: '1'` failing the step** (`pr-check.yml:55`). An unfixed CVE would be scanned and logged but would never turn this step red. So a red Trivy step here is not just "a vulnerability was found" — it specifically means a patched version of the flagged package is available to apply *right now*. If the failure was caused by the bump itself (step 1 confirmed it), the fix is very likely to bump further, to whatever version actually contains the patch. If the failure predates this PR (step 1 ruled the bump out), the fix is to bump the flagged package independently — possibly in a follow-up PR of its own — rather than treating this Dependabot PR as the wrong place to solve it.

The instinct to avoid here is the same one file 05's coverage-gate drill and the infra module's own Trivy drill both name: don't reach for `continue-on-error: true`, don't delete the scan step, don't widen `ignore-unfixed` or narrow `severity` just to make this one PR's check go green. `ignore-unfixed: true` already means every red result here has a real, applicable fix sitting one version bump away — which makes "investigate which package and apply the fix" almost always cheaper than any workaround that would also silence the next unrelated finding on a completely different PR.
