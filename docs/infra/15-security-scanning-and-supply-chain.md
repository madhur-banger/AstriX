> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md).

# Security Scanning and Supply Chain

Every other file in this module has, at some point, said a version of "and here's how AstriX defends against X" for one specific layer — a security group, an IAM policy, a KMS-encrypted parameter. This file is about the machinery that checks whether those defenses (and everything else in the repo) are actually sound, automatically, on every single change, without waiting for a human to notice. That machinery runs in exactly two places in a codebase like this: inside CI, before a pull request can merge, and as a background process against artifacts already sitting in a registry. Neither replaces a human security review. Both exist because a human reviewing a diff by eye will not reliably notice that a newly-added npm package has a disclosed critical CVE, or that a Terraform change quietly reopened a security group to `0.0.0.0/0`, or that a `.env.example` file someone copy-pasted from a real `.env` still has a live API key in it. Machines are bad at judgment and very good at "does this string match a known-bad pattern" — shift-left security tooling is built entirely around exploiting that asymmetry.

This chapter surveys the real categories of tooling that make up a modern shift-left security posture, then verifies — by reading every workflow file in `.github/workflows/` and the full `dependabot.yml`, not by assuming — exactly which of those categories AstriX actually has wired up, which one it doesn't, and where two of AstriX's own scanning layers disagree with each other in a way worth naming plainly.

---

## 1. The Landscape

"Catch a security problem before it reaches production" splits into five largely independent categories, each looking at a different kind of artifact, at a different point in the pipeline, for a different kind of mistake. They don't substitute for each other — a codebase can have all five, some, or none, and the ones it's missing are real, specific blind spots, not redundant coverage it can safely skip.

### (a) Static Application Security Testing (SAST)

SAST tools read your own application source code — not its dependencies, not its infrastructure definitions — and look for security-relevant logic flaws: a database query built with string concatenation instead of parameterization, user input flowing unsanitized into an `eval()` or a shell command, a hardcoded cryptographic key, a comparison that looks like an auth check but has an inverted condition. **Semgrep** is the dominant lightweight, rule-based entrant — it pattern-matches against an AST using rules that read almost like the code they're flagging, is fast enough to run on every PR, and has a large open-source rule registry plus the ability to write custom rules quickly. **CodeQL** — GitHub's own, and the same engine that (does not, as of this repo) power GitHub's default "code scanning" feature — takes a heavier, more precise approach: it compiles the codebase into a queryable relational database and runs semantic dataflow queries against it, which lets it trace a value from an untrusted source (`req.body`) through the actual call graph to a dangerous sink (a raw SQL query, a `child_process.exec` call) even across multiple function calls, catching things a purely syntactic pattern-matcher would miss. The tradeoff is symmetrical: Semgrep is faster to adopt and cheaper to run but shallower; CodeQL is deeper (real interprocedural dataflow) but heavier to set up and slower to run per-PR.

What SAST catches that nothing else in this list can: a vulnerability that exists entirely in code your own team wrote, correctly typed, using dependencies that are all fully patched, running on perfectly-configured infrastructure. A SQL injection in a hand-written query is invisible to a dependency scanner (the `pg` driver isn't vulnerable — your query string is), invisible to a secret scanner (nothing looks like a credential), and invisible to IaC or container scanning (the database is configured fine; the flaw is in application logic). This is the category with no substitute.

### (b) Dependency / software-composition-analysis (SCA) scanning

SCA tooling looks at your dependency manifests (`package.json`/`package-lock.json`, `requirements.txt`, Terraform provider blocks) and cross-references every resolved version against a database of known, disclosed vulnerabilities — CVEs, or ecosystem-specific advisories. **Dependabot** is GitHub-native: it reads your lockfiles, checks the GitHub Advisory Database, and opens a pull request bumping the vulnerable dependency to a patched version — the fix, not just the finding, arrives as a diff. **Snyk** is the dominant third-party SaaS alternative: broader multi-ecosystem coverage, a larger and more actively curated vulnerability database than GitHub's own advisory feed in some ecosystems, plus license-compliance scanning that Dependabot doesn't attempt. **`npm audit`** is the lowest-friction option of the three — built directly into the `npm` CLI, checks resolved `node_modules` versions against npm's own advisory feed, and can be wired into a CI step (`npm audit --audit-level=high`) or run on a developer's machine with zero setup, but it doesn't open PRs or track state across runs the way Dependabot and Snyk do.

What SCA catches that nothing else can: a real, disclosed vulnerability in code you didn't write and have no visibility into by reading your own source — the vulnerability lives inside a transitive dependency three levels deep in the tree. SAST tools generally don't analyze `node_modules`; a secret scanner has nothing to find there; this is squarely SCA's job.

### (c) Secret scanning

Secret scanning looks specifically for literal credential material accidentally committed to a repository — API keys, private keys, database connection strings with embedded passwords, OAuth client secrets — usually via a combination of regex patterns matched against known provider key formats (`AKIA[0-9A-Z]{16}` for an AWS access key, for instance) and Shannon-entropy heuristics for generic high-entropy strings that don't match a known format but still look like a secret. **gitleaks** is a widely-used open-source CLI that runs this detection across a git diff or a repo's full history. **TruffleHog** does the same regex-plus-entropy detection but adds a distinctive extra step in its more capable tiers: live credential verification, actually calling the provider's API with the discovered credential to confirm whether it's still active — the difference between "this looks like an AWS key" and "this is an AWS key that still works right now." **GitHub's own native secret scanning** runs automatically on public repos (and on private repos with GitHub Advanced Security) and partners directly with many credential providers (AWS, Stripe, Slack, and others) to auto-revoke a leaked key the moment it's detected, and its **push protection** feature goes one step further than any of the above — it can block the `git push` itself, before the secret ever lands in the remote repository's history at all, rather than detecting it after the fact in CI.

What secret scanning catches that nothing else can: this is the only category in this list not looking for a *vulnerability* at all — it's looking for a literal piece of leaked material. A perfectly-written, perfectly-patched, perfectly-configured system with a real AWS secret key sitting in a committed `.env` file is instantly compromised the moment anyone with read access to the repo — or anyone who ever clones it, forever, since git history doesn't forget — finds that commit. No SAST tool flags "hardcoded string," no SCA tool cares about `.env` files, no container scanner looks at git history at all.

### (d) Infrastructure-as-Code (IaC) scanning

IaC scanners statically analyze infrastructure definitions — Terraform HCL, CloudFormation templates, Kubernetes manifests — for known-insecure resource configurations, before anything is ever applied to a real cloud account: a security group with an ingress rule open to `0.0.0.0/0` on a sensitive port, an S3 bucket without encryption or public-access blocking, an IAM policy with an unscoped `"Action": "*"`, a database with no backup retention configured. **tfsec** is a Terraform-specific static analyzer with a large built-in library of these checks, purpose-built to run fast against a `.tf` directory with zero cloud credentials needed. **Checkov** (from Bridgecrew, now part of Prisma Cloud) covers a broader surface — Terraform, CloudFormation, Kubernetes manifests, and even Dockerfiles — from one tool with a larger combined policy library. **Terrascan** takes a similar multi-IaC-format approach, built on Open Policy Agent's Rego policy language, which makes custom organization-specific rules more expressive at the cost of a steeper authoring curve than tfsec's built-in checks.

What IaC scanning catches that nothing else can: a misconfiguration that will exist the moment infrastructure is provisioned, independent of any application code running on top of it. A Trivy scan of a container image says nothing about the security group in front of the load balancer serving that container; a SAST scan of application source says nothing about whether the S3 bucket the app writes to is public. The vulnerability lives in the *shape of the infrastructure itself*, and only a tool reading the infrastructure definition can see it before it's live.

### (e) Container image scanning

Once application code and its dependencies are baked into a container image, a new surface appears that neither SCA (which reads source-level manifests, not the final built filesystem) nor SAST (which reads your application code, not the base OS image underneath it) inspects: the actual OS packages and language-runtime libraries physically present in the image's layers. **Trivy** is the dominant open-source scanner here — it unpacks an image's layers, builds an inventory of every OS package (from `apt`/`apk`/`yum` metadata) and language dependency it finds, and checks each against CVE databases, typically run as a CI step against a locally built image before it's ever pushed anywhere. **Native registry scan-on-push** — AWS ECR's built-in scanning being the concrete example here, with equivalents in GCR and ACR — runs automatically the moment an image lands in the registry, using the registry provider's own scanning engine, entirely independent of whatever CI pipeline pushed it.

What container scanning catches that nothing else can: a vulnerable OS-level package that arrived via the *base image*, not via anything declared in `package.json`. A Node application's `package-lock.json` says nothing about the version of `openssl` or `libc` baked into the `node:20-alpine` base layer underneath it — that library only becomes visible once something actually inspects the built image's filesystem, which is exactly what SCA structurally cannot do and container scanning is built specifically to do. (A brief, clearly-scoped aside: in a Kubernetes environment, this same category often gets a second enforcement point via an admission controller that refuses to schedule a pod whose image hasn't passed a scan — AstriX runs on ECS Fargate, not Kubernetes, so no such admission-controller layer exists or is relevant here; see [`06-compute-and-container-orchestration-ecs-fargate.md`](./06-compute-and-container-orchestration-ecs-fargate.md) for why.)

---

## 2. AstriX's Choice

AstriX runs a real, functioning shift-left stack covering **four of these five categories**: **gitleaks** for secret scanning, **tfsec** for IaC scanning, **Trivy plus native ECR scan-on-push** for container image scanning (at two genuinely different pipeline stages, covered in full below), and **Dependabot** for dependency/supply-chain updates across three separate ecosystems (npm for both `backend` and `client`, GitHub Actions itself, and the Terraform AWS provider). The one category that is **honestly absent** is SAST — verified by listing every file in `.github/workflows/` (`deploy-backend.yml`, `deploy-frontend.yml`, `infra.yml`, `pr-check.yml`, `rollback.yml`) and reading each one in full: there is no CodeQL workflow, no Semgrep step, no `.github/codeql` configuration directory, and no reference to either tool anywhere in the repository's CI configuration. This isn't a hedge or a guess — it's a direct read of the actual files this repository ships.

---

## 3. AstriX Implementation

### 3.1 Secret scanning — gitleaks in `pr-check.yml`

The entire `secret-scan` job, run on every pull request targeting `main`:

```yaml
# .github/workflows/pr-check.yml:8-19
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

Two details here matter more than they look. First, `fetch-depth: 0` on the checkout step — the default `actions/checkout@v4` behavior is a shallow clone of just the tip commit, which would let gitleaks scan only the final diff of the PR; `fetch-depth: 0` pulls the *entire* git history for the checked-out ref, which is what lets `gitleaks-action` scan every commit introduced by the PR, not just the squashed net result — a secret added in one commit and then deleted in a later commit on the same branch is still caught, because it still exists somewhere in that commit range's history. Second, `GITHUB_TOKEN` is passed only so the action can post scan results as a check/comment on the PR via the GitHub API — it is not a scanning credential, and gitleaks itself needs no cloud or third-party credentials to do its actual pattern-matching work.

### 3.2 Container image scanning, stage one — Trivy in `pr-check.yml`

Trivy runs inside the `check-backend` job, immediately after a real Docker image is built locally in the runner (never pushed anywhere at this stage):

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

Read the four `with:` keys literally, because every one of them is a distinct policy decision. `severity: CRITICAL,HIGH` — Trivy is told to only report (and gate on) findings at these two severities; MEDIUM/LOW/UNKNOWN findings are scanned but don't affect the outcome. `exit-code: '1'` — when a finding at or above the configured severity is present, the Trivy action process exits non-zero, which GitHub Actions then treats as a failed step, which fails the job, which blocks the PR from being merge-able (assuming branch protection requires this check, which is the entire point of running it in a PR workflow at all). `ignore-unfixed: true` — a finding is only counted toward that exit-code decision if a fixed version actually exists for the affected package; a CVE with no available patch yet is scanned and would still appear in Trivy's output/logs, but does not fail the build.

### 3.3 IaC scanning — tfsec in `infra.yml`

Part of the `validate` job, which runs on every pull request touching `infra/**` and needs no AWS credentials at all:

```yaml
# .github/workflows/infra.yml:66-69
      - name: tfsec
        uses: aquasecurity/tfsec-action@v1.0.3
        with:
          working_directory: infra
```

`working_directory: infra` — not `infra/environments/dev` — means tfsec statically analyzes every Terraform module in the repository in one pass: `infra/modules/networking`, `infra/modules/security`, `infra/modules/iam`, `infra/modules/ecr`, `infra/modules/ecs`, `infra/modules/alb`, `infra/modules/acm`, `infra/modules/parameter-store`, `infra/modules/cloudfront_s3`, and the `infra/environments/dev` root that composes them — a single misconfigured resource anywhere in that module tree fails this one step, regardless of which specific `.tf` file the PR actually touched.

### 3.4 Container image scanning, stage two — native ECR scan-on-push, checked in `deploy-backend.yml`

This is a structurally different scan from Trivy above: it doesn't run as an explicit CI step invoking a scanning tool — AWS ECR scans the image automatically and asynchronously the instant it's pushed, as a property of the registry itself. The workflow's job is to *wait* for that scan to finish and *decide* what to do with the result, which is exactly what this bash block does, in full:

```yaml
# .github/workflows/deploy-backend.yml:56-87
      - name: Wait for ECR image scan and check findings
        env:
          IMAGE_TAG: ${{ github.sha }}
        run: |
          echo "Waiting for ECR image scan to complete..."
          for i in $(seq 1 30); do
            STATUS=$(aws ecr describe-image-scan-findings \
              --repository-name "$ECR_REPOSITORY" \
              --image-id imageTag="$IMAGE_TAG" \
              --query 'imageScanStatus.status' --output text 2>/dev/null || echo "IN_PROGRESS")
            if [ "$STATUS" = "COMPLETE" ] || [ "$STATUS" = "FAILED" ]; then
              break
            fi
            sleep 10
          done

          if [ "$STATUS" != "COMPLETE" ]; then
            echo "::warning::ECR scan did not complete in time (status: $STATUS) - not blocking deploy, but check the scan manually."
            exit 0
          fi

          CRITICAL=$(aws ecr describe-image-scan-findings \
            --repository-name "$ECR_REPOSITORY" \
            --image-id imageTag="$IMAGE_TAG" \
            --query 'imageScanFindings.findingSeverityCounts.CRITICAL' --output text 2>/dev/null || echo "0")
          CRITICAL=${CRITICAL/None/0}

          echo "Critical vulnerabilities found: $CRITICAL"
          if [ "$CRITICAL" != "0" ]; then
            echo "::error::$CRITICAL CRITICAL vulnerabilities found in the image. Review: aws ecr describe-image-scan-findings --repository-name $ECR_REPOSITORY --image-id imageTag=$IMAGE_TAG"
            exit 1
          fi
```

This step is checked in detail in [`05-container-registry-and-image-lifecycle.md`](./05-container-registry-and-image-lifecycle.md) from the registry-lifecycle angle (why the polling loop is shaped this way, what the timeout means for the registry itself); the point of pasting it again here is to have it sitting directly next to the Trivy step above so the two can be compared side by side in §5 without flipping between files.

### 3.5 Dependency / supply-chain updates — the full `dependabot.yml`

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

Four `updates` entries, three distinct ecosystems: `npm` twice (once per package root — `/backend` and `/client` are independent `package.json`/`package-lock.json` trees with no shared root manifest, so each needs its own Dependabot entry), `github-actions` once at the repo root (this is what keeps `actions/checkout@v4`, `aquasecurity/trivy-action@0.24.0`, `gitleaks/gitleaks-action@v2`, and every other pinned Action version across all five workflow files current — a genuinely supply-chain-relevant concern, since a compromised third-party Action is itself a real, documented attack vector in the GitHub Actions ecosystem), and `terraform` once, scoped to `infra/environments/dev` specifically, with a comment explaining why that single directory is sufficient even though the actual provider configuration is consumed by every module under `infra/modules/` — because those modules are referenced by local path from the environment, not as independently versioned Terraform registry modules, they inherit whatever provider version constraint `dev` resolves, so there is exactly one `required_providers` block in the whole Terraform tree that actually needs a bot watching it.

---

## 4. Request/Data Flow

**Trace one: a secret leak, caught before merge.** A developer is debugging a local Stripe integration, hardcodes a live secret key directly into a config file to test something quickly, commits it with a message like `wip: test stripe key`, and opens a pull request. On `pull_request` targeting `main`, `pr-check.yml`'s three jobs start in parallel (`.github/workflows/pr-check.yml:3-5,7`) — `secret-scan` doesn't wait on the others. `actions/checkout@v4` with `fetch-depth: 0` (`pr-check.yml:12-14`) pulls the full commit history for the PR's branch, including the exact commit that added the key. `gitleaks/gitleaks-action@v2` (`pr-check.yml:16-19`) scans every commit in that range against its built-in regex/entropy rule set; a Stripe secret key has a recognizable, documented prefix (`sk_live_...`), which gitleaks' default ruleset matches directly — no entropy heuristic even needed for a well-known key format like this one. The action exits non-zero, which fails the `secret-scan` check on the PR. If branch protection on `main` requires this check to pass — the mechanism itself is covered in [`12-cicd-with-github-actions.md`](./12-cicd-with-github-actions.md), not re-derived here — the PR's merge button is blocked, full stop, regardless of whether `check-backend` and `check-frontend` both pass cleanly. The key never reaches `main`, and critically, the *fix* here isn't "delete the commit and force-push" — even after that, the key was live and exposed to anyone with read access to the branch the moment it was pushed, so the correct remediation is always rotating the credential at the provider, not just scrubbing history.

**Trace two: a container vulnerability, and why timing changes the outcome.** Suppose a new CVE is disclosed against a package baked into the backend image's Alpine base layer, rated HIGH severity, with a fix already available upstream — right in the middle of `ignore-unfixed: true`'s "does count" bucket. Two different moments matter here, and they produce two different results.

If the CVE is disclosed *before* a given PR's `check-backend` job runs: `docker build` (`pr-check.yml:47`) produces the image locally, `aquasecurity/trivy-action@0.24.0` (`pr-check.yml:50-55`) scans it, finds the HIGH-severity, fixed-upstream CVE, and because `severity: CRITICAL,HIGH` includes HIGH and `exit-code: '1'` means any matching finding fails the step unconditionally, the job fails and the PR is blocked until the base image or affected package is bumped. This is the strict path — HIGH severity alone, with no available exception, stops the merge.

Now suppose that exact same CVE is disclosed the day *after* an unrelated, already-scanned, already-merged PR shipped to `main`, and `deploy-backend.yml` runs, builds a fresh image from current `main`, pushes it to ECR, and reaches the "Wait for ECR image scan and check findings" step (`deploy-backend.yml:56-87`). ECR's native scanner runs its own independent scan against the freshly pushed image and will, in fact, find the same HIGH-severity CVE — but the bash block only ever queries `imageScanFindings.findingSeverityCounts.CRITICAL` (`deploy-backend.yml:77-80`); nothing in this step reads or checks the HIGH count at all. `CRITICAL` for this image is `"0"`, the `if [ "$CRITICAL" != "0" ]` check (`deploy-backend.yml:84`) is false, the step exits successfully, and `aws ecs update-service --force-new-deployment` (`deploy-backend.yml:89-94`) proceeds — deploying an image the team's own PR-time gate would have rejected outright, had it been scanned at that severity bar at this stage instead. The same vulnerability, the same severity, the same image contents — a different pipeline stage checking a narrower severity band is the entire reason the outcome differs.

---

## 5. Design Decisions & Tradeoffs

**The Trivy-vs-ECR severity and failure-mode asymmetry, named plainly.** Reading these two steps side by side (§3.2 and §3.4) surfaces a real inconsistency in this repository's own security posture, independent of anything either file states about itself: `pr-check.yml`'s Trivy gate treats CRITICAL and HIGH as equally build-breaking, with a hard `exit-code: '1'` and no escape hatch — if the scan runs and finds a qualifying vulnerability, the job fails, unconditionally. `deploy-backend.yml`'s ECR-scan gate checks *only* CRITICAL, and even that check has a built-in bypass: if the scan simply hasn't finished within five minutes (30 iterations × a 10-second sleep, `deploy-backend.yml:61,69`), the step logs a warning and exits `0` — deploy proceeds with **no scan result checked at all**, not "checked later." So the stage that runs *earlier* in the lifecycle (PR time, before merge) is strictly *stricter* than the stage that runs *later* (deploy time, right before real traffic hits the new image) — a HIGH-severity, fixed-upstream CVE that would fail a PR outright is entirely invisible to the gate standing between a merge and production traffic.

It's worth reasoning through which way this asymmetry *should* run, because "PR gate stricter than deploy gate" isn't obviously wrong on its face — a case could be made that PR time is exactly when you want the tightest bar, before a vulnerable image is even built, and deploy time is a last-resort backstop that only needs to catch the most severe class of finding to avoid blocking routine deploys on a slow-moving HIGH-severity patch backlog. But that argument doesn't survive contact with the actual timing gap between the two scans: the image scanned at PR time and the image that actually ships are frequently *different builds* — a PR can sit open for days while new CVEs are disclosed against packages nobody touched, and `main` accumulates other merges in the meantime. The PR-time Trivy scan only proves "this specific build, at this specific moment, had no known CRITICAL/HIGH finding" — it says nothing about the image ECR receives days or weeks later from a rebuild off a different `main`. A deploy-time gate that's *narrower* than the PR gate is not a redundant backstop; it's a real gap in coverage, at the exact moment — seconds before real traffic — where the strictest check would matter most. If anything, the deploy-time gate is the one that should match or exceed the PR-time severity bar, precisely because it's checking the artifact that's actually about to run, not a snapshot from whenever the PR happened to be scanned.

**Why `ignore-unfixed: true` is set, and what it actually costs.** This flag is a defensible, common choice — failing a build on a CVE with no available patch anywhere upstream doesn't make the team any safer; it just makes CI permanently red for a class of finding no action can currently resolve, training engineers to ignore or override failing builds altogether, which is a worse outcome than the unfixed CVE itself. But the real cost is worth stating plainly rather than assuming the flag is free: an unpatched CRITICAL or HIGH CVE, once disclosed, sits present in every subsequently built image indefinitely, with **zero CI signal** — it doesn't appear as a warning, it doesn't fail softly, it produces literally the same green checkmark as an image with no vulnerabilities in it at all. The only way anyone learns a fix has since shipped upstream is re-running the scan manually or waiting for the next PR to happen to trigger one — there's no polling or re-check step anywhere in this repository that revisits previously-ignored, now-fixed findings on a schedule.

**Why Dependabot groups minor/patch updates but leaves major versions ungrouped.** `backend-minor-patch` and `client-minor-patch` (`dependabot.yml:7-11,17-21`) bundle every eligible minor/patch bump into a single PR per ecosystem per week — a defensible bet that minor/patch releases follow semver's own contract (no breaking API changes) closely enough, across a whole dependency tree, that reviewing and merging them as one batch is safe and dramatically cuts down on PR-review overhead compared to one PR per package per bump. Major-version bumps are conspicuously **not** included in either group, which means each one arrives as its own separate, ungrouped PR — the correct call, because a major version bump is exactly the case where semver's guarantee explicitly does *not* hold: a maintainer is telling you, via the version number itself, that something can break. Batching multiple major bumps together would mean a single failing test in a group of five unrelated major upgrades blocks all five merges at once, and worse, makes it much harder to tell *which* upgrade actually caused the failure — keeping majors singular and ungrouped preserves the ability to bisect a break to one specific dependency change.

---

## 6. Security Considerations

Stepping back from the individual tools: AstriX's shift-left coverage is real, not aspirational — it functions across four of the five categories surveyed in §1, gating actual merges and actual deploys, not sitting unused as a checkbox. Secrets are checked on every PR with full-history depth. Infrastructure changes are statically checked against known-insecure patterns before any human reviews the Terraform diff. Container images are checked twice, at two different pipeline stages, even though (per §5) those two checks disagree with each other on severity bar and failure mode. Dependencies across three separate ecosystems get automated, weekly, semver-aware update PRs. That is a genuinely non-trivial security posture for a project of this size, and it would be inaccurate to describe it as thin.

The one clean, structural gap is SAST — verified absent in §2, not inferred. Concretely, this means: a SQL-injection-shaped bug introduced in a hand-written Mongoose query, an authorization check with an inverted boolean, a path-traversal flaw in a file-upload handler, or a hardcoded secret pattern that isn't quite regular enough for gitleaks to flag as a *secret* but is still a cryptographic misuse — none of these would be caught by anything currently running in this repository's CI. Every one of the four categories AstriX does have is looking at a different artifact (git diffs for secrets, Terraform HCL for IaC, container layers for image scanning, lockfiles for dependencies) — none of them read application source code looking for logic flaws, which is squarely what Semgrep or CodeQL exist to do, and neither currently runs here.

The second, more structural point worth stating clearly: every tool in this file — Trivy, ECR's scanner, tfsec, gitleaks, Dependabot — works by matching against a database of *already-known* patterns: known CVEs, known-insecure Terraform resource shapes, known secret formats, known vulnerable package versions. None of them can find a novel logic flaw unique to this codebase's own business logic, and none of them can find a zero-day vulnerability that hasn't been disclosed and added to a CVE database yet. This is not a criticism specific to AstriX's setup — it's a structural property of every scanner in this category, everywhere, for every codebase. Automated scanning compresses the enormous, tedious work of checking "is any of my 400 transitive dependencies on a public list of known-bad versions" into a five-minute CI step; it does not, and cannot, replace a human thinking about whether a specific piece of business logic can be abused in a way nobody has ever named and catalogued yet. That's precisely the gap SAST partially — not fully — helps close by analyzing actual code paths instead of matching against a static list, but even SAST is bounded by the ruleset it ships with.

---

## 7. Best Practice Check

Against 2026 industry-standard shift-left security practice, four categories covered with SAST as the sole clean gap is roughly in line with — arguably slightly ahead of — a well-run team at AstriX's size and stage. Plenty of teams this size have secret scanning and dependency updates wired up and stop there; having a working IaC scanner and two independent container-image scanning layers, even with the asymmetry named in §5, is more coverage than a lot of comparably-sized projects ship. The clearest, single most actionable gap to close next is exactly the one named honestly in §2 and §6: SAST. Either Semgrep (faster to bolt on, given it needs no compiled build step and has a large free rule registry that would catch a meaningful first pass of real issues with a day's setup work) or CodeQL (deeper analysis, native GitHub integration, somewhat heavier to configure and slower per-run) would close this gap outright; either is a reasonable starting choice, and adding one doesn't require removing or replacing anything currently running.

One further gap sits adjacent to this file's scope without belonging in it: [`05-container-registry-and-image-lifecycle.md`](./05-container-registry-and-image-lifecycle.md) already covers, in its own Security Considerations section, that this repository generates no SBOM and performs no image signing or provenance attestation for anything it builds — a real, separate gap in the software-supply-chain story from the scanning gap this file focuses on, not re-derived here.

---

## 8. Debug Drill

**Scenario:** A pull request is blocked by the Trivy scan in `check-backend`, and the engineer who opened it is confident the flagged CVE doesn't actually apply — the vulnerable code path is in a feature of the affected package the application never calls, or the vulnerability requires a runtime configuration AstriX doesn't use. Separately, but for the same underlying reason, imagine gitleaks flags something in a test fixture file — a string that looks exactly like an AWS access key but is actually a hardcoded, obviously-fake placeholder used only to exercise a validation function in a unit test.

The instinct to avoid in both cases is the same: don't disable the check. Not `continue-on-error: true` slapped onto the whole step, not deleting the `secret-scan` or Trivy step from the workflow, not lowering `severity` to `CRITICAL` only to make a specific HIGH finding go away. Any of those "fixes" the immediate CI failure and permanently removes the check's ability to catch the *next* real finding of the same shape, on a completely unrelated PR, from anyone on the team, for as long as the change stands.

The right sequence, for the Trivy case:

1. **Read the actual finding, not just the fact that the job failed.** Trivy's output names the specific package, installed version, CVE identifier, and a summary of the vulnerable code path or condition. Pull that CVE up directly (the NVD entry or the vendor's own advisory) and read what triggers it — not a secondhand summary.
2. **Determine, concretely, whether the vulnerable code path is reachable.** "We don't use that feature" is a real, valid finding only if it's actually verified against how the package is invoked in this codebase — grep for the specific function or configuration flag the advisory names being used anywhere in `backend/src`, not assumed from memory of what the package generally does.
3. **If genuinely a false positive or truly unreachable, use Trivy's own suppression mechanism with a documented reason** — a `.trivyignore` file entry naming the specific CVE ID, with a comment stating exactly why it doesn't apply and who determined that, so the exception is scoped to that one finding, visible in code review, and auditable later by someone who wasn't in the room when the call was made. This is a targeted allowlist entry, not a change to the scan's severity threshold or a disabled step — the next unrelated HIGH-severity finding on a different package still fails the build exactly as before.
4. **If the package is genuinely unused or replaceable, prefer removing or upgrading it** over suppressing the finding at all — a suppression is a documented, deliberate exception, not the default resolution path; it should be reached for after confirming a version bump or removal isn't the simpler fix.

The gitleaks false-positive case follows the identical shape, just with gitleaks' own tooling instead of Trivy's: confirm the flagged string really is fake (not a real credential someone thought was safe to hardcode as a "placeholder"), then add a scoped exception — gitleaks supports both inline allowlist comments and a `.gitleaksignore` file keyed to the specific commit/fingerprint of the match — with a comment explaining why that exact string is a known-fake test fixture, rather than disabling the `secret-scan` job or weakening its ruleset globally. In both cases, the pattern is the same: investigate to a real true/false-positive determination first, then suppress narrowly and visibly if it's genuinely a non-issue — never widen the blast radius of the fix to "turn the check off" just because one specific finding on one specific PR was a false alarm.
