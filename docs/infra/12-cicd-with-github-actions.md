# CI/CD with GitHub Actions

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md).

Every other file in this module builds a piece of infrastructure and stops — a VPC, a load balancer, a registry. This file is about the thing that *moves code into* all of that infrastructure: what actually happens, mechanically, between a developer running `git push` and a new container serving real traffic. Every other AWS resource in this repo is inert until something decides to change it; that something, for AstriX, is a set of YAML files living in `.github/workflows/`.

---

## 1. The Landscape

"How does a code change reach a running environment" has a small number of real, structurally different answers, and they don't converge — a team's choice here shapes everything downstream, from what credentials exist and where, to how fast rollback happens, to who gets paged when a deploy goes wrong.

### (a) Push-based CI/CD platforms

GitHub Actions, GitLab CI, CircleCI, and Jenkins are all the same shape underneath: a pipeline runs in response to a git event — a push, a merge, a tag — on infrastructure the CI platform (or a runner you host) controls, and that pipeline itself reaches *out* to the target environment to make the change happen. The CI runner calls the AWS API, or `kubectl apply`s a manifest, or SSHes into a box and restarts a service. The defining property is direction: control flows from the pipeline outward to production.

```yaml
# illustrative push-based deploy — not AstriX's actual workflow
on:
  push:
    branches: [main]
jobs:
  deploy:
    steps:
      - run: aws ecs update-service --cluster prod --service api --force-new-deployment
```

For this to work, the CI runner needs *some* credential capable of making that AWS call — a stored access key, an assumed role, an OIDC-derived session token. That credential requirement is the central tradeoff of the whole category: convenient (the pipeline is a single system that both tests and ships code, and a human never has to leave GitHub's UI to trigger a deploy), but it means a credential capable of writing to production exists somewhere the CI platform can reach, even if — as covered below — that credential can be made short-lived and narrowly scoped rather than a permanent secret. This is the model AstriX uses.

### (b) Pull-based GitOps

Argo CD and Flux invert the direction entirely. A controller runs *inside* the target environment — almost always a Kubernetes cluster — and continuously watches a git repository (usually one holding rendered Kubernetes manifests or Helm values, separate from the application's source repo) for changes. When it sees a new commit, it reconciles the cluster's actual state to match what's declared in git, pulling the change in on its own schedule rather than being pushed to.

```yaml
# illustrative Argo CD Application resource — not part of AstriX
apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  source:
    repoURL: https://github.com/example/k8s-manifests
    targetRevision: main
  syncPolicy:
    automated: {}
```

This has become the increasingly common pattern in Kubernetes-native shops, and the reason is specifically about credentials, not about elegance: no CI runner ever needs standing or even short-lived write-access credentials to the production cluster, because the CI system's job stops at "build the image and update a manifest in a git repo it already has write access to anyway." The cluster reaches out to pull that change — using credentials that live entirely inside the cluster's own trust boundary — instead of the other way around. A compromised CI pipeline in this model can, at worst, propose a bad manifest change; it cannot directly call the cluster's API with elevated privileges, because it was never handed any credential that could. The cost is real too: it only cleanly applies to environments with a reconciling controller to run in the first place (overwhelmingly Kubernetes today), it adds a second repository and a sync-lag concept to reason about, and "what's actually running" now requires checking both the manifest repo and the controller's own reconciliation state rather than reading one pipeline's log top to bottom.

### (c) Manual and scripted deploys

The oldest pattern: a human runs a script from their laptop, or SSHes into a box and runs commands directly — `rsync` for static files, a shell script wrapping `docker build && docker push && ssh host 'systemctl restart app'`. No CI system is involved unless the script itself happens to be invoked from one. This is not a strawman relegated to legacy shops; it is exactly the pattern AstriX's own `infra/scripts/*.sh` files (`push-backend-image.sh`, `deploy-frontend.sh`, and friends) represent — and it's telling that AstriX keeps this path around explicitly as a **fallback**, not the primary deploy mechanism. `05-container-registry-and-image-lifecycle.md` covers `push-backend-image.sh` in more depth; the relevant fact here is that it authenticates with a human's own AWS profile and pushes an image by hand, entirely outside any git-event trigger. The honest tradeoff: zero infrastructure to maintain and it works when CI itself is down or misconfigured, but it depends entirely on a specific human remembering the right sequence of commands, running them from a machine with the right credentials already configured, and not fat-fingering a step — there's no audit trail beyond shell history, no automatic test gate, and no institutional memory beyond whoever wrote the script.

### (d) Trunk-based continuous deployment vs. release-branch-gated deployment

This is a different axis from (a)–(c) — it's not about *what system* executes a deploy, but about *when* one happens at all. In trunk-based continuous deployment, every merge to the main branch is a deploy candidate, and (usually) actually deploys, automatically, with no separate "cut a release" step. In release-branch-gated deployment, work accumulates on `main` (or feature branches merged into it) and a human explicitly cuts a release — tagging a commit, branching a `release/x.y` line, or triggering a dedicated pipeline — and only *that* action deploys. Trunk-based continuous deployment forces small, frequent, individually low-risk changes and removes an entire class of "big bang release" incidents, but it means the *only* checkpoint between a merged PR and production is whatever automated gate exists on the deploy path itself — there's no "decide today is not a good day to ship" pause built into the workflow shape. Release-branch gating adds exactly that pause (and a natural place to batch a changelog or coordinate a rollout with other teams), at the cost of a real ceremony that has to be maintained and remembered, and a growing gap between what's merged and what's actually running.

---

## 2. AstriX's Choice

AstriX uses push-based CI/CD via GitHub Actions, authenticated to AWS through OIDC federation rather than any stored access key, deploying on a trunk-based cadence — every merge to `main` that touches the right paths triggers a deploy workflow automatically — with GitHub Environments inserted as a manual-approval gate between "the workflow fired" and "the workflow's steps actually execute against AWS." That combination — automatic trigger, human-gated execution — is the specific shape worth understanding before reading the YAML: it is neither pure continuous deployment (nothing ships without a click) nor release-branch gating (there's no separate release ceremony; the gate lives inside the same workflow the merge already triggered).

---

## 3. AstriX Implementation

### 3.1 The OIDC authentication block (common to every deploy-capable workflow)

Every workflow in this repo that touches AWS repeats the same two ingredients: a `permissions` block granting the job the ability to request an OIDC token, and a `configure-aws-credentials` step that exchanges it for temporary AWS credentials. Shown here in full from `deploy-backend.yml`, since it's the clearest instance:

```yaml
# .github/workflows/deploy-backend.yml:17-19
permissions:
  id-token: write
  contents: read
```

```yaml
# .github/workflows/deploy-backend.yml:34-38
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/astrix-dev-github-actions-role
          aws-region: ${{ env.AWS_REGION }}
```

`deploy-frontend.yml:15-17` and `:30-34`, and `infra.yml:31-34` and its two `role-to-assume` occurrences at `:88-91` and `:150-153`, repeat this exact shape — same permissions block, same role ARN, same action. The mechanics of what this actually does at the IAM/STS layer — the OIDC provider, the trust policy's `sub` condition, why `AssumeRoleWithWebIdentity` never touches a stored secret — are covered in full in `04-identity-and-access-management.md`; this file treats it as the credential source every deploy job below builds on, without re-deriving it.

### 3.2 `deploy-backend.yml` — the full build/scan/deploy job

The trigger and environment gate, first:

```yaml
# .github/workflows/deploy-backend.yml:1-30
name: Deploy Backend

on:
  push:
    branches: [main]
    paths:
      - 'backend/**'
      - '.github/workflows/deploy-backend.yml'
  workflow_dispatch:

env:
  AWS_REGION: us-east-1
  ECR_REPOSITORY: astrix-dev-backend
  ECS_CLUSTER: astrix-dev-cluster
  ECS_SERVICE: astrix-dev-backend-service

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    name: Build and Deploy
    runs-on: ubuntu-latest
    # Gated behind the "production" GitHub Environment, the same mechanism
    # infra.yml's apply job uses ("infra-apply"). This is what makes a push to
    # main pause for approval instead of shipping straight to the environment
    # that de facto serves real users - add required reviewers to the
    # "production" environment in repo settings, or this is a no-op.
    environment: production
```

That comment is not editorializing added by this doc — it's the workflow author's own words, sitting directly above `environment: production` in the real file. It says, plainly, exactly what section 6 below expands on: the YAML alone does not create an approval gate.

The image build, ECR-scan wait, and ECS deploy, in full:

```yaml
# .github/workflows/deploy-backend.yml:40-101
      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag, and push image to ECR
        id: build-image
        working-directory: backend
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG -t $ECR_REGISTRY/$ECR_REPOSITORY:latest .
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:latest
          echo "image=$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" >> $GITHUB_OUTPUT

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

      - name: Update ECS service
        run: |
          aws ecs update-service \
            --cluster $ECS_CLUSTER \
            --service $ECS_SERVICE \
            --force-new-deployment

      - name: Wait for service stability
        run: |
          echo "Waiting for ECS service to stabilize..."
          aws ecs wait services-stable \
            --cluster $ECS_CLUSTER \
            --services $ECS_SERVICE
          echo "✅ Deployment complete!"
```

The scan-polling mechanics (the 30-iteration/10-second loop, the `CRITICAL`-only threshold, the non-blocking timeout) are the subject of `05-container-registry-and-image-lifecycle.md` §3.4 — this file treats that step as one link in the deploy chain, not a thing to re-derive. Likewise, `--force-new-deployment` and `services-stable` sit on top of ECS's rolling-deployment behavior and the deployment circuit breaker configured on the service itself, both covered in `13-deployment-strategies-and-rollback.md` — here they're just "the two calls that actually make the new image live and confirm it stayed up."

### 3.3 `deploy-frontend.yml` — distribution lookup, SSM fetch, build, sync, invalidate

```yaml
# .github/workflows/deploy-frontend.yml:1-26
name: Deploy Frontend

on:
  push:
    branches: [main]
    paths:
      - 'client/**'
      - '.github/workflows/deploy-frontend.yml'
  workflow_dispatch:

env:
  AWS_REGION: us-east-1
  S3_BUCKET: astrix-dev-frontend

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    name: Build and Deploy
    runs-on: ubuntu-latest
    # Gated behind the "production" GitHub Environment - see the same comment
    # in deploy-backend.yml. Required reviewers must be configured on that
    # environment in repo settings for this to be an actual approval gate.
    environment: production
```

Once past the same OIDC credential exchange as §3.1, the job has to solve two problems a static-site deploy doesn't usually have: it needs to know *which* CloudFront distribution fronts this bucket (nothing in the workflow hardcodes a distribution ID), and it needs the backend's real API URL baked into the Vite build at build time, not read at runtime:

```yaml
# .github/workflows/deploy-frontend.yml:36-58
      - name: Get CloudFront Distribution ID
        id: cloudfront
        run: |
          # Find CloudFront distribution by S3 bucket origin (handles multiple domain formats)
          DIST_ID=$(aws cloudfront list-distributions \
            --query "DistributionList.Items[?Origins.Items[?contains(DomainName, '${S3_BUCKET}')]].Id | [0]" \
            --output text)
          
          if [ "$DIST_ID" == "None" ] || [ -z "$DIST_ID" ]; then
            echo "❌ CloudFront distribution not found for bucket: $S3_BUCKET"
            echo "Listing all distributions for debugging:"
            aws cloudfront list-distributions --query "DistributionList.Items[*].{Id:Id,Origins:Origins.Items[*].DomainName}" --output table
            exit 1
          fi
          
          echo "distribution_id=$DIST_ID" >> $GITHUB_OUTPUT
          echo "✓ Found CloudFront Distribution: $DIST_ID"

      - name: Get API URL from SSM
        id: ssm
        run: |
          API_URL=$(aws ssm get-parameter --name "/astrix/dev/VITE_API_BASE_URL" --query "Parameter.Value" --output text)
          echo "api_url=$API_URL" >> $GITHUB_OUTPUT
```

The distribution lookup is a JMESPath query, not a stored config value — it asks CloudFront directly for whichever distribution has an origin whose domain name contains the bucket name, and fails loudly (with a full listing dumped for debugging) if nothing matches. The SSM fetch is a plain, non-`SecureString` parameter read — `09-secrets-and-configuration-management.md` covers Parameter Store's KMS-backed secret path in depth; this particular parameter is a build-time URL, not a credential, which is exactly why it's readable with a bare `get-parameter` call and no decryption step.

Both values then drive the actual build and publish:

```yaml
# .github/workflows/deploy-frontend.yml:60-86
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: client/package-lock.json

      - name: Install dependencies
        working-directory: client
        run: npm ci

      - name: Build
        working-directory: client
        run: npm run build
        env:
          VITE_API_BASE_URL: ${{ steps.ssm.outputs.api_url }}

      - name: Sync to S3
        working-directory: client
        run: |
          aws s3 sync dist/ s3://$S3_BUCKET/ --delete

      - name: Invalidate CloudFront
        run: |
          aws cloudfront create-invalidation \
            --distribution-id ${{ steps.cloudfront.outputs.distribution_id }} \
            --paths "/*"
          echo "✅ Frontend deployed and cache invalidated!"
```

`VITE_API_BASE_URL` is a Vite build-time environment variable — `10-build-tooling-and-bundle-optimization.md` covers what that means for how Vite inlines it into the compiled bundle. The consequence worth noting here: this URL is baked into static JS files at `npm run build` time, so if the API's URL ever changes, a frontend redeploy is required to pick it up — there is no runtime config read on page load. `aws s3 sync --delete` makes the bucket's contents exactly match the fresh `dist/` output (removing files from a previous build that no longer exist), and the CloudFront invalidation with `--paths "/*"` busts every cached object at the edge so the new build is served immediately rather than waiting out each object's TTL — `10-cdn-and-static-asset-delivery.md` covers CloudFront's caching model in more depth.

### 3.4 `infra.yml` — the three-job structure

`infra.yml` has a different shape from the two deploy workflows: it's split into three jobs that don't all run on the same trigger, because "validate a Terraform change" and "apply a Terraform change" have genuinely different credential and approval requirements.

```yaml
# .github/workflows/infra.yml:1-34
name: Infrastructure

on:
  pull_request:
    branches: [main]
    paths:
      - 'infra/**'
      - '.github/workflows/infra.yml'
  workflow_dispatch:
    inputs:
      action:
        description: 'Terraform action to perform'
        required: true
        default: 'plan'
        type: choice
        options:
          - plan
          - apply
      environment:
        description: 'Environment'
        required: true
        default: 'dev'
        type: choice
        options:
          - dev

env:
  AWS_REGION: us-east-1
  TF_WORKING_DIR: infra/environments/${{ inputs.environment || 'dev' }}

permissions:
  id-token: write
  contents: read
  pull-requests: write
```

**Job 1 — `validate`.** Runs on every PR touching `infra/`, and (via `needs: validate`) before either of the other two jobs, with no AWS credentials involved at all:

```yaml
# .github/workflows/infra.yml:36-69
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

`terraform init -backend=false` is what makes this job credential-free — it initializes providers and modules without ever trying to reach the real S3/DynamoDB state backend, so `fmt`, `validate`, and `tfsec` can all run on a fork or an untrusted PR with zero AWS exposure. `tfsec` itself is a static-analysis scanner over the HCL, not something that needs live AWS state; `15-security-scanning-and-supply-chain.md` covers what class of finding it actually catches, in depth.

**Job 2 — `plan-on-pr`.** Only on pull requests (`if: github.event_name == 'pull_request'`), and only after `validate` passes:

```yaml
# .github/workflows/infra.yml:76-129
  plan-on-pr:
    name: Terraform Plan (PR)
    if: github.event_name == 'pull_request'
    needs: validate
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: infra/environments/dev
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/astrix-dev-github-actions-role
          aws-region: ${{ env.AWS_REGION }}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.7.0

      - name: Terraform Init
        run: terraform init

      - name: Terraform Plan
        id: plan
        run: |
          terraform plan -no-color -input=false 2>&1 | tee /tmp/plan_output.txt
        continue-on-error: true

      - name: Post plan to PR
        uses: actions/github-script@v7
        env:
          PLAN_STATUS: ${{ steps.plan.outcome }}
        with:
          script: |
            const fs = require('fs');
            let planOutput = fs.readFileSync('/tmp/plan_output.txt', 'utf8');
            const maxLen = 60000;
            if (planOutput.length > maxLen) {
              planOutput = planOutput.slice(0, maxLen) + '\n... (truncated)';
            }
            const body = `#### Terraform Plan (\`infra/environments/dev\`) - ${process.env.PLAN_STATUS === 'success' ? '✅' : '❌'}\n<details><summary>Show plan</summary>\n\n\`\`\`\n${planOutput}\n\`\`\`\n\n</details>`;
            await github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body,
            });

      - name: Fail if plan failed
        if: steps.plan.outcome != 'success'
        run: exit 1
```

`terraform plan` deliberately runs with `continue-on-error: true` and its output is piped to a file rather than left to fail the step outright — that's what lets the *next* step run regardless of whether the plan itself succeeded, post whatever it produced (a real plan or an error) as a PR comment via `actions/github-script`, and only *then* explicitly fail the job (`Fail if plan failed`) based on the recorded `steps.plan.outcome`. The net effect: a reviewer never has to check out the branch or trust a description of "what this Terraform change does" — the actual computed diff shows up as a comment on the PR itself, collapsed behind a `<details>` disclosure so it doesn't dominate the PR page. This job holds AWS credentials (it has to, to compute a real plan against real state) but never calls `terraform apply` anywhere in its steps — planning and applying are architecturally separate jobs, not just separate steps of one job.

**Job 3 — `terraform`.** Only on `workflow_dispatch` (`if: github.event_name == 'workflow_dispatch'`), gated behind a second, distinct GitHub Environment:

```yaml
# .github/workflows/infra.yml:131-179
  # -----------------------------------------------------------------------
  # APPLY - manual only. Gated behind the "infra-apply" GitHub Environment;
  # add required reviewers to that environment in repo settings to get a
  # real approval gate (a no-op until the environment exists / has
  # reviewers configured - see infra/README.md).
  # -----------------------------------------------------------------------
  terraform:
    name: Terraform ${{ inputs.action }}
    if: github.event_name == 'workflow_dispatch'
    needs: validate
    runs-on: ubuntu-latest
    environment: infra-apply
    defaults:
      run:
        working-directory: ${{ env.TF_WORKING_DIR }}
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/astrix-dev-github-actions-role
          aws-region: ${{ env.AWS_REGION }}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.7.0

      - name: Terraform Init
        run: terraform init

      # Plan and apply run in the same job on the same runner, so tfplan never
      # has to cross a job boundary. It is deliberately NOT uploaded as an
      # artifact: a binary plan file embeds every resolved value, including
      # SSM SecureString contents and other `sensitive = true` inputs, and a
      # workflow artifact is downloadable by anyone with read access to the
      # repo. The human-readable plan is already in this step's log output.
      - name: Terraform Plan
        id: plan
        run: |
          terraform plan -out=tfplan -no-color 2>&1 | tee plan_output.txt
          echo "Plan completed"

      - name: Terraform Apply
        if: inputs.action == 'apply'
        run: |
          terraform apply -auto-approve tfplan
          echo "✅ Infrastructure deployed!"
```

That comment above the `Terraform Plan` step is worth reading twice — it's a genuine, explicit piece of security reasoning left in the code, not something inferred after the fact, and section 5 below treats it as its own case study.

---

## 4. Request/Data Flow

Trace an actual change touching `backend/` from first keystroke to running container:

1. A developer pushes commits to a feature branch and opens a PR against `main`.
2. `pr-check.yml` runs on `pull_request` (`.github/workflows/pr-check.yml:3-5`), with three jobs: `secret-scan` runs `gitleaks/gitleaks-action@v2` over the full history (`fetch-depth: 0`) to catch a committed credential before it ever reaches `main`; `check-backend` runs `npm ci`, a type-check-and-build, `npm run test:coverage`, a Docker build of the exact production image (not pushed anywhere), and a Trivy scan of that built image gated on `CRITICAL,HIGH` findings; `check-frontend` runs lint, tests, and a build against a placeholder API URL. None of these three jobs touch AWS or need any cloud credential — they're pure merge gates. The gitleaks and Trivy mechanics specifically are `15-security-scanning-and-supply-chain.md`'s subject, not re-derived here.
3. A human reviews the PR and merges it to `main`. This merge is itself the trunk-based trigger — there is no separate "cut a release" step anywhere in this flow.
4. GitHub evaluates every workflow with a `push` trigger against the merge commit. `deploy-backend.yml`'s trigger is `push: branches: [main], paths: ['backend/**', '.github/workflows/deploy-backend.yml']` (`.github/workflows/deploy-backend.yml:3-9`) — if the merged PR's diff touched anything under `backend/` (or the workflow file itself), this fires; if it didn't, GitHub never even schedules the job.
5. The job starts, hits `environment: production` (`.github/workflows/deploy-backend.yml:30`), and — assuming required reviewers are actually configured on that Environment in repo settings — pauses. GitHub shows the run as "Waiting for approval" and, if reviewers are configured correctly, notifies them. No step below the `environment:` line has executed yet: no OIDC token has been requested, no AWS API has been called.
6. A required reviewer approves the run in the GitHub UI. Only now do the job's steps begin: `configure-aws-credentials` requests an OIDC token and exchanges it for a session under `astrix-dev-github-actions-role`, `amazon-ecr-login` uses that session to authenticate Docker to ECR, `docker build`/`docker push` produces and uploads the image tagged with both `github.sha` and `latest`, the scan-wait step polls ECR until a `CRITICAL`-findings verdict comes back (or times out non-blocking), and — only if that step exits `0` — `aws ecs update-service --force-new-deployment` and `aws ecs wait services-stable` run in sequence, the latter blocking the job until the new tasks are healthy and old ones have drained.
7. The job finishes, and — assuming steps 5 and 6 both went as designed — the change a developer pushed at step 1 is now the code actually serving requests.

The frontend path runs in complete, path-filtered isolation from all of this. `deploy-frontend.yml`'s trigger is `push: branches: [main], paths: ['client/**', '.github/workflows/deploy-frontend.yml']` (`.github/workflows/deploy-frontend.yml:3-9`) — a PR that only touches `backend/**` never causes this workflow to even be scheduled, and vice versa: a `client/**`-only PR never triggers `deploy-backend.yml`. Both workflows can be mid-run at the same time, gated independently, approved independently, and one failing has no bearing on the other's outcome. `infra.yml` sits on a third, separate axis again — it never fires on a push to `main` at all; its `plan-on-pr` job only runs on pull requests touching `infra/**`, and its `terraform` apply job only runs when someone deliberately triggers `workflow_dispatch`, choosing `apply` from the dropdown. Nothing about merging code to `main` ever runs `terraform apply` — that action requires a human to go find the workflow in GitHub's Actions tab and click "Run workflow."

---

## 5. Design Decisions & Tradeoffs

**Why path-filtered triggers instead of one monolithic deploy workflow.** `deploy-backend.yml` and `deploy-frontend.yml` are two separate files with two separate `paths:` filters rather than one workflow with an `if:` branching on which directory changed. The direct benefit is independent deploy cadence: the backend and frontend genuinely change at different rates and for different reasons in this codebase, and a backend hotfix shouldn't have to wait on (or risk being coupled to) an unrelated frontend rebuild, or vice versa. It also means a failure in one pipeline — say, the ECR scan gate blocking a backend deploy — has zero mechanical effect on the frontend's ability to ship. The real cost, visible directly in the code above, is duplication: the OIDC `permissions` block and the `configure-aws-credentials` step are byte-for-byte identical across `deploy-backend.yml`, `deploy-frontend.yml`, and `infra.yml`. If the role ARN's naming convention changes, or the region moves, or the trust policy needs a new claim, that's a multi-file, `grep`-and-fix operation rather than a single edit — a real, if modest, maintenance tax for the independence this buys.

**Why GitHub Environments as the approval-gate mechanism, rather than making every deploy `workflow_dispatch`-only.** These solve genuinely different UX problems, even though both "require a human to do something" before a deploy happens. A `workflow_dispatch`-only trigger requires a human to *remember* to go start the deploy at all — nothing happens automatically on merge, and a busy or distracted team can simply forget, leaving `main` days ahead of what's actually running. A GitHub Environment lets the workflow still fire automatically the instant a qualifying merge lands — so the *intent* to deploy is never lost or forgotten — while the environment's required-reviewers setting pauses *execution* at a specific point until a human clicks approve. It's automatic triggering and human judgment coexisting in the same run, rather than a choice between the two. The tradeoff is that this safety property is entirely dependent on configuration that lives outside the workflow file, which is exactly what the next section is about.

**The `tfplan`-artifact decision as a general lesson.** The comment sitting directly above the `Terraform Plan` step in `infra.yml`'s apply job (quoted in full in §3.4) is worth treating as a case study in its own right, independent of Terraform specifically: uploading an intermediate build artifact for later inspection or reuse is a completely reasonable, common CI convenience — except when that artifact happens to embed resolved secret values. A `tfplan` binary is not a diff; it's Terraform's fully-resolved execution plan, meaning every `sensitive = true` value that would be substituted into a real resource — an SSM `SecureString`, a database password variable, an API key passed as a `tfvars` input — is present in that file in a form Terraform itself can read back out. GitHub Actions workflow artifacts, by default, are downloadable by *anyone with read access to the repository*, not just the people who triggered or approved the run. Uploading `tfplan` as a `actions/upload-artifact` step would mean every one of those resolved secrets is now sitting in a file any repo-read collaborator can fetch, indefinitely, completely independent of whether they were ever supposed to see that particular secret. AstriX's fix is structural, not just "remember not to do that": plan and apply run in the *same job*, on the *same runner*, so the plan file never has to leave that runner's disk to be consumed by a later step — there's no job boundary for it to cross, and so no reason it would ever need to become an artifact in the first place. The generalizable lesson: before uploading any CI intermediate artifact, ask what values it actually contains once fully resolved, not what it conceptually represents — a "plan" sounds inert, but a resolved plan is not the same thing as an unresolved template.

---

## 6. Security Considerations

**OIDC federation removes stored AWS credentials from GitHub entirely.** `04-identity-and-access-management.md` covers the STS/trust-policy mechanics in depth; the fact worth restating here is narrower: at no point in any of these four workflows does an AWS access key exist as a GitHub secret. `${{ secrets.AWS_ACCOUNT_ID }}` is a plain account number, not a credential — it's used only to construct a role ARN string. The actual credential is a short-lived STS session token, requested fresh on every job run and worthless within an hour of issuance.

**What `permissions: id-token: write, contents: read` actually authorizes.** These two lines, repeated identically at `deploy-backend.yml:17-19`, `deploy-frontend.yml:15-17`, and `infra.yml:31-34`, are the minimum GitHub Actions permission grant OIDC-based AWS authentication requires, and each half does something distinct. `id-token: write` is what lets the job ask GitHub's Actions runtime to mint an OIDC token *at all* — without it, the `configure-aws-credentials` action has no token to hand AWS STS, and the `Configure AWS credentials` step fails outright before any AWS API is even reached. `contents: read` is the ordinary permission `actions/checkout` needs to pull the repository's contents onto the runner — unrelated to OIDC itself, but present because every one of these jobs needs the repo checked out to have anything to build or plan. Note what's conspicuously *not* granted: no `contents: write`, no `packages: write`, no broad default permission set — GitHub Actions' `GITHUB_TOKEN` permissions default to fairly broad unless explicitly narrowed, and this repo's workflows narrow them to exactly what each job does. (`infra.yml` additionally grants `pull-requests: write`, visible in the same block at `infra.yml:31-34` — needed because `plan-on-pr` posts a comment onto the PR via `actions/github-script`, an action that couldn't do that without it.)

**The GitHub Environment approval gate — a real control, with a real, honestly-stated dependency.** An `environment: production` (or `environment: infra-apply`) line is a genuine defense against a compromised or over-eager automation immediately shipping to production: even if an attacker fully controlled the ability to merge to `main`, or a bug caused an unintended push, the deploy job would still stop and wait rather than silently executing. But this needs to be stated with total precision, because it's a commonly misunderstood mechanism: the *workflow YAML* does not configure who the required reviewers are, and cannot fully enforce the gate on its own. `environment: production` in a workflow file only tells GitHub "this job runs under whatever rules the 'production' Environment has" — those rules (a list of required reviewers, a wait timer, branch restrictions) are configured separately, in the repository's **Settings → Environments** UI, entirely outside version control. The workflow files' own comments say this directly and without hedging — `deploy-backend.yml`'s comment reads "add required reviewers to the 'production' environment in repo settings, or this is a no-op," and `infra.yml`'s apply-job comment says the same of "infra-apply": "a no-op until the environment exists / has reviewers configured." If an Environment named `production` exists in the repo but has no required reviewers configured, `environment: production` in the YAML changes nothing observable about execution — the job runs straight through with no pause at all, and nothing in the workflow file itself would tell you that from a read-through. Confirming the gate is actually live requires checking the repo's Environment settings directly, not just reading the workflow YAML.

**`pr-check.yml`'s gitleaks and Trivy steps as a pre-merge control.** Every PR against `main` runs a gitleaks secret scan across full history and a Trivy scan of the exact Docker image that would ship, gated on `CRITICAL,HIGH` severity (`.github/workflows/pr-check.yml:16-19`, `:49-55`). This is the merge-time counterpart to the deploy-time ECR scan in `deploy-backend.yml` — two independent checkpoints for the same broad concern (shipping a vulnerable or secret-leaking image), at two different points in the pipeline. `15-security-scanning-and-supply-chain.md` covers what gitleaks and Trivy each actually detect, and how they compare to `tfsec` and ECR's native scanning, in the depth that topic deserves — here they're the merge gate that has to pass before any of the deploy workflows in this file ever get a chance to run.

---

## 7. Best Practice Check

**OIDC-federated, environment-gated GitHub Actions is a solid, current (2026) pattern, plainly.** There's no asterisk to attach here — federated short-lived credentials over stored keys, and a human-approval checkpoint on the automated path to production, are both squarely inside what a well-run team is expected to have in 2026, and AstriX has both, correctly wired at the workflow level. The dependency on Environment reviewer configuration living outside the repo is not itself a deviation from best practice — every team using GitHub Environments has that same property, since it's how the feature is designed to work — it's simply a fact worth verifying is actually configured, which section 6 covers.

**Is trunk-based deployment-on-every-merge-to-`main` still reasonable at this project's size?** Yes, and worth naming the tradeoff precisely rather than just endorsing it: removing a "cut a release" ceremony is exactly the right simplification for a small team, where the overhead of maintaining release branches, changelogs, and a separate promotion step would outweigh any coordination benefit it buys. The cost is that the approval gate on the deploy workflow becomes the *only* checkpoint standing between a merged PR and production — there's no "the release manager decided today isn't a good day to ship" pause built into the process shape itself the way a release-branch model has by construction. That's a reasonable trade at this scale as long as the approval gate is genuinely staffed and genuinely used as a real checkpoint, not rubber-stamped.

**The absence of a staging/pre-production environment is a real, honest gap worth naming.** Every deploy traced in section 4 goes directly from "PR merged to `main`" to the single Environment named `production` — there is no intermediate deploy to a staging or pre-prod environment anywhere in this pipeline for either the backend or frontend. `11-infrastructure-as-code-with-terraform.md` covers the underlying reason this is even possible to state so simply: there is currently exactly one Terraform environment (`dev`) in this repo's structure, so there is no separate staging AWS environment to deploy to even if the pipeline wanted to. This is a common, well-understood next-maturity-step gap for a project at this stage, not a surprising or unusual one — most teams this size run exactly this way, and the honest fix (a `staging` environment with its own gate, promoted to production only after real traffic or smoke tests pass there) is squarely "the next thing to build," not evidence of an oversight in how the *existing* pipeline was built.

---

## 8. Debug Drill

**Scenario:** a deploy workflow run has been sitting at "Waiting for approval" for hours, and nobody on the team seems to know why it hasn't gone through — or, in a related but distinct scenario, a workflow run shows a clean green checkmark in GitHub's UI, but the change it was supposed to ship clearly never took effect in the actual running environment.

**If the run is stuck waiting for approval:** first, check whether the "production" (or "infra-apply") Environment actually has required reviewers configured at all, in **Settings → Environments** — as section 6 covers in detail, an Environment with no reviewers configured doesn't hang waiting for approval, it runs straight through, so a run that's genuinely stuck waiting means reviewers *are* configured; the question is whether the *right* people are, and whether they were actually notified. GitHub only notifies users who are both listed as required reviewers on that specific Environment *and* have permission to approve — someone who left the team, had their access revoked, or was never actually added correctly will never see a notification, and the run will wait indefinitely with no error, because from GitHub's point of view it's working exactly as configured. Check the Environment's reviewer list against who's actually active on the team, and check whether that person's notification settings (email, GitHub mobile, Slack integration) would have actually surfaced a pending-approval request to them.

**If the run succeeded but the change clearly isn't live**, work backward through the same three questions that appear throughout this file's traced flow, because a silent no-op almost always traces to one of them. First: did the path filter actually match? `deploy-backend.yml` only fires on changes under `backend/**` (or to the workflow file itself) — a change that touches, say, a root-level config file or a shared script outside `backend/` would never trigger this workflow at all, and there'd be no run to point to as evidence anything was skipped; check the merged commit's actual file list against the `paths:` filter, not just an assumption that "I changed something in the app, so it must have deployed." Second, check for a silently-satisfied or silently-skipped `if:` condition — a job or step gated on `if: github.event_name == 'workflow_dispatch'` (as `infra.yml`'s `terraform` job is) will show as skipped, not failed, in the Actions UI if the triggering event doesn't match, and a skipped step can be easy to miss in a long green run if you're only glancing at the overall checkmark rather than expanding each job. Third, and specific to the OIDC path: if a branch was recently renamed, or the workflow's trigger was changed to run from a different ref, the trust policy's `sub` condition (covered in `04-identity-and-access-management.md`) may no longer match what GitHub is actually issuing — but this failure mode shows up as the `Configure AWS credentials` step failing outright, not as a silent success, so it's a much easier one to rule in or out: if that step is green, the OIDC exchange genuinely happened and genuinely got real AWS credentials. A "succeeded but nothing changed" outcome with a green credentials step almost always means the job ran against the wrong resource (a stale `ECS_CLUSTER`/`ECS_SERVICE` env value, a distribution lookup that matched an unexpected distribution) rather than a credentials problem at all — which is why confirming the actual `env:` values the job used, and cross-checking them against what's really deployed in AWS, is the more productive next step than re-suspecting authentication a second time.
