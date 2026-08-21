> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infrastructure](./00-master-infra-architecture.md).

# Containerization and Docker

Everything else in `docs/infra/` — the VPC, the security groups, the ECS service, the load balancer — exists to run *something*. That something is a single artifact: a Docker image built from one file, `backend/Dockerfile`. Before this curriculum can talk about how that image gets networked, scheduled, or scaled, it has to be precise about what the image actually *is* — not "a lightweight VM," which is the popular but mechanically wrong mental model, but a specific set of kernel features that Linux has had for over a decade, wrapped by tooling that makes them usable. This file starts there — with the actual kernel mechanisms — then walks through AstriX's real, 31-line Dockerfile line by line, and ends with an honest look at where that file's choices hold up against 2026 practice and where they don't.

---

## 1. The Landscape

### 1.1 What a container actually is: namespaces and cgroups

A container is not a virtual machine. A VM virtualizes hardware — a hypervisor (Xen, KVM, Hyper-V) presents each guest with its own virtual CPU, virtual memory, virtual disk, and the guest runs its own complete kernel on top of that virtual hardware. A container does none of this. Every container on a given host shares that host's one Linux kernel. What makes a container feel like an isolated machine is two independent kernel mechanisms working together: **namespaces**, which control what a process can *see*, and **cgroups**, which control what a process can *use*.

**Namespaces** partition a specific kind of global kernel resource so that a process inside a namespace sees its own private view of that resource, distinct from every other namespace on the same host. Linux has several, and each solves a narrower problem than "isolation" in the abstract:

- **PID namespace** — a process inside a new PID namespace sees itself as PID 1, and can only see (and signal) other processes inside the same namespace. This is why `ps aux` inside a running container shows a handful of processes, not the host's full process table — the container's "PID 1" is not the host's real PID 1, it's a completely separate numbering space that the kernel maintains per-namespace.
- **NET namespace** — a private set of network interfaces, routing tables, and port bindings. A process in one net namespace can bind port 8000 without colliding with a completely different process bound to port 8000 in another net namespace on the same host — this is the actual mechanism behind Docker's `-p 8080:8000` port mapping: two independent, non-conflicting network stacks, bridged by a virtual interface.
- **MNT namespace** — a private filesystem mount table. A process here can have `/` point at something entirely different from what the host's `/` points at, without `chroot`'s well-known ability to be escaped by a privileged process. This is the namespace that makes a container's filesystem look self-contained — more on how that filesystem is actually constructed in §1.2.
- **UTS namespace** — isolates hostname and NIS domain name, so a container can have its own hostname (typically its short container ID) independent of the host machine's actual hostname.
- **IPC namespace** — isolates System V IPC objects and POSIX message queues, so two containers' processes can't accidentally attach to the same shared-memory segment or semaphore just because they happen to run on the same host.
- **USER namespace** — maps UIDs/GIDs inside the namespace to a different (typically unprivileged) range of UIDs/GIDs on the host. This is what lets a process claim to be "root" (UID 0) *inside* its own namespace while actually holding a harmless, unprivileged UID on the host — a meaningful hardening layer, though one Docker does not enable by default (`userns-remap` is an opt-in daemon setting), and one AstriX's own image doesn't rely on, since its security posture (§6) comes from a different mechanism: not running as UID 0 in the first place.

Put together, a "container" is really just an ordinary Linux process, launched with `clone()` (or `unshare()`) flags that place it into a fresh PID, NET, MNT, UTS, and IPC namespace simultaneously. There is no separate container kernel, no container hypervisor, no container-specific scheduler — the host kernel schedules that process exactly like any other, and everything that makes it *feel* like a separate machine is these namespaces controlling what it can see.

**Cgroups (control groups)** solve the other half of the problem: namespaces control visibility, but nothing about a namespace stops a process from consuming every CPU core and every byte of RAM on the host. Cgroups are the kernel's resource-accounting and resource-limiting mechanism — a cgroup is a group of processes with shared, enforced limits on CPU shares, memory ceilings, block-I/O bandwidth, and more, arranged in a hierarchy the kernel itself enforces (a process that tries to allocate past its cgroup's memory limit gets OOM-killed by the kernel, not by any container-runtime-level polling). This is the direct kernel-level ancestor of every "memory" and "cpu" field in an ECS task definition, or every `--memory`/`--cpus` flag on `docker run` — those tools are just convenient front ends for writing numbers into `/sys/fs/cgroup/...`.

Docker (and every other container runtime — containerd, CRI-O, Podman) is, at its core, a userspace tool that automates the specific `clone()`/namespace/cgroup setup for you, plus the image format and layer-management tooling covered next. None of this is Docker-specific kernel magic; it's the same primitives Linux has offered since kernel namespaces matured through the 2.6.x-to-3.8 range, which is exactly why "rootless," "distroless," and orchestrator-agnostic tooling can all exist — they're all just different arrangements of the same small set of kernel features.

### 1.2 Image layers and OverlayFS

A Docker image is not one flat filesystem snapshot — it's a stack of read-only **layers**, each one the filesystem *diff* produced by exactly one Dockerfile instruction that changes the filesystem (`RUN`, `COPY`, `ADD`; instructions like `ENV` or `EXPOSE` only change image metadata and don't produce a filesystem layer at all). When a container actually runs, the container runtime uses a **union filesystem** — on Linux, almost universally **OverlayFS** — to stack every one of those read-only image layers on top of each other into a single merged view, then adds one final, thin **writable layer** on top, unique to that specific running container.

OverlayFS's own vocabulary for this is `lowerdir` (the stack of read-only image layers, potentially many), `upperdir` (the one writable layer, where any file the running process modifies actually gets written), and `merged` (the unified view a process inside the container actually sees, transparently combining both). The mechanism that makes this workable is **copy-on-write**: if a process inside the container writes to a file that only exists in a `lowerdir` layer, OverlayFS doesn't mutate that read-only layer at all (it can't — the layers are shared, content-addressed, and reused across every other image or container built from the same base) — it transparently copies that file up into `upperdir` first, then applies the write there. Delete a file that exists in a lower layer and OverlayFS records a special "whiteout" marker in `upperdir` rather than actually touching the lower layer, so the merged view correctly hides it without disturbing the shared layer underneath.

This is precisely the mechanism behind two things every Docker user has experienced without necessarily knowing why: first, that pulling a new image tag which shares most layers with one you already have locally only downloads the *new* layers, because each layer is content-addressed (identified by a hash of its own contents) and Docker simply skips fetching anything whose hash it already holds. Second, that Docker's build cache invalidates an entire layer, and every layer built after it, the moment anything about that layer's inputs changes — which is exactly the mechanism §3 and §4 below build AstriX's own `COPY package.json` ordering around.

### 1.3 Four real ways to produce a container image

With the kernel-level "what is a container" question answered, the actual engineering decision every team using containers faces is: *how do you author the image itself?* This has a genuine landscape of answers, not just Dockerfile-syntax bikeshedding.

**(a) Single-stage Dockerfile.** One `FROM`, one linear sequence of instructions, one final image. Simplest possible authoring model:

```dockerfile
# illustrative single-stage Dockerfile — not AstriX code
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
CMD ["node", "dist/index.js"]
```

**Tradeoff:** trivial to read and write, and there's exactly one build context to reason about. The real cost is that the final, shipped image contains *everything* used to produce it — the full `devDependencies` tree (test frameworks, bundlers, type-checkers, linters), the entire pre-build source tree including config files never needed at runtime, and any build tooling installed along the way. That's wasted bytes in every layer that has to be pulled on every deploy and every autoscale event, and — more importantly for §6 — it's a meaningfully larger attack surface: every dependency that shipped only to compile TypeScript is now also sitting in the production container, available to anything that manages to get code execution inside it.

**(b) Multi-stage builds — what AstriX uses.** Multiple `FROM` statements in one Dockerfile, each starting a distinct, independently-named build stage; a later stage can selectively pull specific files out of an earlier one with `COPY --from=<stage>`, and everything else about that earlier stage — its installed `devDependencies`, its intermediate build artifacts, its full source tree — is simply discarded, because Docker only ships the layers of the *final* stage in the resulting image (earlier stages exist purely as intermediate build environments and never become part of what gets pushed to a registry, though they do stay in the local build cache for reuse across builds).

```dockerfile
# illustrative shape (AstriX's real version is pasted and explained in full in §3)
FROM node:20-alpine AS builder
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:20-alpine AS production
WORKDIR /app
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
```

**Tradeoff:** this is genuinely close to "strictly better than single-stage" for compiled/transpiled languages specifically — you get to use whatever heavy build tooling you want in the `builder` stage (TypeScript compiler, bundlers, native build toolchains) without any of it surviving into the image that actually ships, at the cost of a slightly more complex file to read (you have to track which stage each instruction belongs to, and which specific paths get copied across the stage boundary).

**(c) Distroless / scratch base images.** Google's `gcr.io/distroless/*` image family (and the even more extreme `FROM scratch`, an explicitly empty base image with literally zero files) push the same idea in §1.3(b) further: instead of a full Alpine or Debian userland as the *final* stage's base — which still includes a shell, a package manager, coreutils, and whatever else the distro ships by default — a distroless final-stage base contains only the language runtime and its direct OS-level dependencies (glibc, SSL certs), nothing else. A representative Node distroless final stage looks like:

```dockerfile
# illustrative distroless final stage — not AstriX code
FROM node:20-alpine AS builder
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["dist/index.js"]
```

**Tradeoff:** this meaningfully shrinks the attack surface further than a multi-stage-with-Alpine build already does — a distroless image has no shell (`sh`/`bash`), no package manager, and no general-purpose userland utilities at all, which means a whole category of post-exploitation technique (an attacker who achieves code execution trying to `curl` out a second-stage payload, or just get an interactive shell to look around) has literally no binary available to do it with. The cost is exactly that same absence cutting the other way operationally: `docker exec -it <container> sh` — the single most common first move when debugging a misbehaving running container (see §8) — doesn't work at all, because there's no shell to exec into. Debugging a distroless container in production requires either an ephemeral debug sidecar/container attached to the same namespaces (a genuinely more advanced technique most teams haven't set up) or leaning much more heavily on structured application logs and metrics collected *before* something goes wrong, since there's no "just go poke around inside it after the fact" fallback.

**(d) Cloud Native Buildpacks.** An entirely different authoring model that removes the Dockerfile from the picture altogether. Originally developed at Heroku (the mechanism behind `git push heroku main` producing a runnable image with no Dockerfile anywhere in the repo) and later standardized as the Cloud Native Buildpacks (CNB) spec, jointly stewarded by Heroku and Pivotal/VMware under the CNCF, with Paketo Buildpacks as the most widely used open implementation today. The workflow is: point a tool like `pack build my-app` at a source directory with no Dockerfile at all, and a chain of buildpacks *detects* what kind of app it is (a `package.json` at the root signals Node; a `requirements.txt` signals Python; a `pom.xml` signals Java) and constructs a runnable OCI image automatically — dependency installation, build-tool invocation, and base-image selection all handled by the buildpack, not hand-written by the team.

```bash
# illustrative buildpacks invocation — no Dockerfile involved at all
pack build my-node-app --builder paketobuildpacks/builder-jammy-base
```

**Tradeoff:** this removes an entire category of ongoing maintenance burden — no Dockerfile to keep in sync with the app's actual runtime needs, no base-image version to track and bump by hand, since the buildpack itself absorbs that responsibility (a well-maintained buildpack ships base-image and language-runtime patches on its own schedule, applied automatically the next time an app is rebuilt with it). The cost is control: a team that needs a specific, unusual system package installed, a nonstandard multi-stage arrangement, or precise byte-for-byte control over what ends up in the final image loses direct access to the mechanism that would let them express that, and instead has to work within whatever configuration surface the specific buildpack in use exposes (environment variables, buildpack-specific config files) — which is real friction for a team whose needs sit even slightly outside a buildpack's supported paved path.

---

## 2. AstriX's Choice

AstriX uses **option (b)**: a two-stage Dockerfile, both stages based on `node:20-alpine`, with a `builder` stage that installs full dependencies and runs the TypeScript compiler, and a `production` stage that installs only production dependencies fresh and copies across nothing but the compiled `dist/` output — running, at the end, as the image's built-in unprivileged `node` user rather than root. It is not distroless (§1.3(c)) and not built via buildpacks (§1.3(d)) — both real, named alternatives this section will return to in §5.

---

## 3. AstriX Implementation

This is the entire file — all 31 lines, nothing added, nothing trimmed:

```dockerfile
# backend/Dockerfile:1-31
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json ./

RUN npm ci
COPY . .

RUN npm run build

FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./

RUN npm  ci --omit=dev

COPY --from=builder --chown=node:node /app/dist ./dist

USER node

EXPOSE 8000

CMD ["node", "dist/index.js"]
```

Walking it line by line:

**`FROM node:20-alpine AS builder` (line 1).** The base image for the first stage: the official Node.js Docker Hub image, major version 20 (an active LTS line as of this writing), on the `alpine` variant — Alpine Linux instead of the Debian-based default, chosen specifically for image size (§5 covers the real tradeoff this brings). `AS builder` names this stage so later instructions (and the second `FROM`) can refer back to it.

**`WORKDIR /app` (line 3).** Sets the working directory for every subsequent instruction in this stage to `/app`, creating it if it doesn't already exist. Every relative path from here on (`COPY package.json package-lock.json ./`, etc.) resolves against this directory, and it's also where the running process's current working directory ends up.

**`COPY package.json package-lock.json ./` and `COPY tsconfig.json ./` (lines 5–6).** This is the dependency-layer-caching pattern, and it's the single most consequential ordering decision in the whole file — covered in depth as its own topic in §4, since it's fundamentally about the OverlayFS layer-caching mechanics from §1.2. The short version: only the files a dependency install actually needs (`package.json`, `package-lock.json`) are copied first, deliberately *before* the rest of the source tree.

**`RUN npm ci` (line 8).** Installs dependencies using `npm ci` rather than `npm install`, and the difference matters specifically in a reproducible-build context like this one. `npm install` will update `package-lock.json` if it finds any dependency whose installed version doesn't exactly match what's declared in `package.json`'s semver ranges — meaning two builds of the exact same commit, run days apart, could legitimately install different transitive dependency versions if something upstream published a new patch release in between. `npm ci` refuses to do this: it requires `package.json` and `package-lock.json` to already be in agreement, installs *exactly* what the lockfile specifies with no resolution step at all, and — critically for a clean, cacheable image build — deletes `node_modules` first if it already exists, rather than trying to reconcile an existing install with the lockfile. This is exactly the property a CI/CD pipeline and a production Docker image both want: the same lockfile, built at two different times, on two different machines, produces byte-for-byte the same dependency tree.

**`COPY . .` (line 9).** Only *after* `npm ci` has already run does the rest of the source tree get copied in — the full application source, config files, everything not already excluded by `.dockerignore` (§7 covers this file's actual contents). This ordering is the second half of the caching pattern from lines 5–6, detailed in §4.

**`RUN npm run build` (line 11).** Runs the `build` script, which per `backend/package.json` is `tsc && cp ./package.json ./dist` — the TypeScript compiler emits compiled JavaScript into `dist/`, and a plain `cp` copies `package.json` alongside it (used by nothing in this Dockerfile's flow specifically, since the production stage brings its own copy of `package.json` from the repo directly, but relevant for anyone running `dist/` standalone outside this exact multi-stage build). This is the last instruction in the `builder` stage — everything produced here (a full `node_modules` including `devDependencies`, the entire pre-compiled `src/` tree, `dist/`) exists only inside this stage's layers and, per §1.3(b), none of it survives into the final image except the one directory explicitly pulled across in line 23.

**`FROM node:20-alpine AS production` (line 13).** The second, independent stage. This is a genuinely fresh image, starting from the same base as the builder but sharing none of the builder's filesystem state automatically — anything the production stage needs from the builder has to be explicitly copied across with `--from=builder`.

**`WORKDIR /app` (line 15).** Same working-directory setup, independently, for this new stage.

**`ENV NODE_ENV=production` (line 17).** Sets an environment variable baked directly into the image itself (distinct from an ECS task-definition environment variable injected at container start, covered in the secrets/config chapter) — this value is present the instant any process starts inside a container built from this image, before ECS or anything else has a chance to inject its own environment. Its most direct, verifiable effect inside this codebase: `npm ci --omit=dev` on the very next line already independently excludes `devDependencies` regardless of `NODE_ENV`, but plenty of Node libraries branch their own internal behavior (verbose logging, development-only warnings, certain performance optimizations) on reading `process.env.NODE_ENV === "production"` directly — Express itself is a well-known example, enabling view-caching and less verbose error output specifically when this value is set.

**`COPY package.json package-lock.json ./` (line 19).** The same two-file dependency manifest copy as line 5, but in this fresh, independent stage — this stage has never seen `npm ci` run before, so it needs its own manifest copy to install from.

**`RUN  npm  ci --omit=dev` (line 21, double-space in the source preserved here verbatim).** `npm ci` again, but with `--omit=dev` — install exactly what the lockfile specifies, excluding everything listed under `devDependencies` in `backend/package.json` (§5 details exactly what that excludes: the full TypeScript, Vitest, ESLint, and `mongodb-memory-server` toolchain). This is the mechanical enforcement of "the shipped image doesn't contain build/test tooling," the exact property that landscape option (a) in §1.3 gives up.

**`COPY --from=builder --chown=node:node /app/dist ./dist` (line 23).** The one line that actually crosses the stage boundary — pulling the compiled `dist/` directory (and nothing else — not `node_modules`, not `src/`, not any dev tooling) out of the `builder` stage. `--chown=node:node` sets file ownership on the copied files at copy time, to the `node` user and group that ships built into the official `node` base image (both official Debian-based and Alpine-based Node images create this user by default specifically so images like this one don't have to). Doing the ownership change as part of the `COPY` instruction itself, rather than as a separate `RUN chown -R node:node ./dist` afterward, avoids creating an extra filesystem layer purely to change ownership — `COPY --chown` sets the metadata as the layer is written, with no additional `RUN` step, and therefore no additional layer, needed.

**`USER node` (line 25).** From this instruction onward — meaning for the `CMD` that actually runs — every process in the container runs as the unprivileged `node` user rather than the default `root`. This is the single line most directly responsible for §6's security posture, and it only works cleanly here because line 23 already ensured the one directory the app actually needs to read (`dist/`) is owned by that same `node` user; had `--chown` been omitted, the `node` user would attempt to run compiled code it doesn't have read permission on.

**`EXPOSE 8000` (line 27).** Purely documentary metadata — `EXPOSE` does not publish a port, open a firewall rule, or affect what port the process inside actually binds to in any way; it's a declaration, visible in `docker inspect` and to tools like `docker run -P` (which uses `EXPOSE` to decide which ports to auto-publish, if that flag is used), of which port the image's author expects the containerized process to listen on. §5 and §6 return to this line specifically, because the actual, real running behavior of this app in AstriX's own deployed environment tells a more interesting story than this line alone suggests.

**`CMD ["node", "dist/index.js"]` (line 29).** The default command run when a container starts from this image, in the exec form (a JSON array, run directly rather than through a shell) — this is what actually invokes the compiled backend, i.e. `backend/src/index.ts` after compilation, whose `app.listen(config.PORT, ...)` call (`backend/src/index.ts:195`) is where the process genuinely binds to a port at runtime, a value read from `process.env.PORT` with a `"8000"` fallback (`backend/src/config/app.config.ts:6`).

No `ARG` or secret-bearing `ENV` instruction appears anywhere in this file — the only `ENV` present is the non-secret `NODE_ENV=production` on line 17, which is the exact, verified absence §6 builds its "no secrets baked into the image" claim on.

---

## 4. Request/Data Flow

Tracing an actual `docker build -f backend/Dockerfile backend` (the same shape of command `deploy-backend.yml` and `pr-check.yml` both run, shown in full below) layer by layer, tied directly to §1.2's OverlayFS mechanics:

1. Docker resolves `node:20-alpine` for the `builder` stage. If this exact tag's layers aren't already present locally, they're pulled from Docker Hub; if they are (a very likely case on a CI runner that's built this same Dockerfile recently, or a developer's machine), this step is instant — nothing downloads.
2. `WORKDIR /app` and the two `COPY`/`RUN npm ci` instructions each produce one new layer on top of the base. This is the crux of the caching pattern named in §3: Docker's build cache keys each layer on (a) the instruction itself and (b) a hash of whatever files that instruction reads. `COPY package.json package-lock.json ./` only invalidates when *those two files* change — editing `src/services/task.service.ts` doesn't touch either of them, so on a rebuild after a pure application-code change, Docker's cache serves this layer, and the one after it (`RUN npm ci`), straight from cache without re-executing `npm ci` at all. Had the Dockerfile instead done `COPY . .` first and run `npm ci` afterward (the naive, single-`COPY` ordering), *any* source file change — even a one-line comment edit in an unrelated controller — would invalidate the `COPY` layer, which cascades: every layer after an invalidated one must also re-run, since each layer's build context is the merged filesystem state of every layer before it. That cascade would force a full `npm ci` reinstall of the entire dependency tree on every single code change, turning what should be a several-second incremental rebuild into a multi-minute one.
3. `COPY . .` copies in everything else, then `RUN npm run build` compiles TypeScript into `dist/`. Both layers *do* invalidate on nearly every meaningful code change (which is expected and unavoidable — the whole point of this stage is compiling the code that just changed), but by this point `npm ci`'s layer has already been served from cache, so the rebuild's actual wall-clock cost is just the TypeScript compile, not a fresh `npm install` on top of it.
4. Docker moves to the second `FROM node:20-alpine AS production` — the same base image, already resolved (and, if this were a single build invocation, already fetched once for stage one and simply reused, since the layer cache is shared across stages built from the same tag).
5. The second stage's own `COPY package.json package-lock.json ./` and `RUN npm ci --omit=dev` repeat the exact same caching logic independently, in this fresh stage, producing a production-only `node_modules` with none of `devDependencies` installed at all.
6. `COPY --from=builder --chown=node:node /app/dist ./dist` is the one instruction that reaches *across* stages rather than building on the previous instruction in the same stage — it copies files out of the `builder` stage's final filesystem state (specifically the `dist/` directory produced in step 3), which is the entire mechanism by which the compiled output crosses from one stage into the other while the `builder` stage's `node_modules`, `src/`, and every dev-tool byte it pulled in gets left behind, never becoming part of any layer in the final image.
7. `USER node`, `EXPOSE 8000`, and `CMD [...]` are metadata-only instructions — none of them produce a new filesystem layer; they set image configuration (the default user, the documented port, the default command) that's recorded in the image manifest rather than as file content.

The image that results from this — specifically the `production` stage's layers, since that's the last `FROM` in the file and therefore what `docker build` actually tags — is what CI actually builds and ships. `deploy-backend.yml` runs this exact build on every push to `main` that touches `backend/**`:

```yaml
# .github/workflows/deploy-backend.yml:44-54
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
```

`pr-check.yml` builds the identical Dockerfile on every pull request, but deliberately never pushes it anywhere — it exists purely as a build-and-scan gate before merge:

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

The manual, human-operated equivalent of the first of those two is `infra/scripts/push-backend-image.sh`, used for one-off pushes outside the CI pipeline:

```bash
# infra/scripts/push-backend-image.sh:155-162
cd backend

# Build with buildkit for better caching and performance
DOCKER_BUILDKIT=1 docker build \
    --platform linux/amd64 \
    --tag "${ECR_REPOSITORY_URI}:${IMAGE_TAG}" \
    --tag "${ECR_REPOSITORY_URI}:latest" \
    --build-arg NODE_ENV=production \
    --file Dockerfile \
    .
```

Worth naming plainly, since it's a real, checkable fact about how these two files relate rather than a guess: this script passes `--build-arg NODE_ENV=production` on the command line, but `backend/Dockerfile` declares no `ARG NODE_ENV` instruction anywhere in it (its only `NODE_ENV`-related line is the unconditional `ENV NODE_ENV=production` on line 17 of the `production` stage, which isn't parameterized by anything). Docker doesn't error on an unconsumed `--build-arg` — it's silently accepted and simply has no effect, since there's no matching `ARG` for it to populate. The script's flag is therefore inert; the Dockerfile's own hardcoded `ENV` line is what actually sets the value, regardless of what the script passes. `--platform linux/amd64` is doing real, necessary work, though — pinning the build to the x86-64 architecture Fargate runs on, which matters specifically for anyone building this image on Apple Silicon (arm64) hardware, where an unpinned `docker build` would otherwise produce an arm64 image that fails to run on Fargate entirely.

Either way this image gets built — CI or this manual script — the resulting tagged image is what gets pushed to ECR, referenced by an ECS task definition's `image` field, and pulled by a Fargate task when it launches. That next stage — how ECR stores and scans the image, how the ECS task definition references a specific tag or digest, how Fargate actually pulls and starts it — is deliberately out of scope here; it's the subject of the registry and compute-orchestration chapters elsewhere in this module. This file's job ends at "here is the artifact `docker build` produces, and why it's built in this specific shape."

---

## 5. Design Decisions & Tradeoffs

**Alpine over Debian-slim.** `node:20-alpine` is built on Alpine Linux, which uses `musl` as its C standard library instead of `glibc` — the C library nearly every other mainstream Linux distribution, including Debian (and therefore `node:20-slim`), uses. Alpine's own minimalism (no unnecessary package manager cruft, `musl` itself being a meaningfully smaller and simpler implementation than `glibc`) is what makes `node:20-alpine` roughly a fifth the size of `node:20` and noticeably smaller than `node:20-slim` too — a real, meaningful win for pull time on every deploy and every autoscale event, and for the base attack surface discussed in §6. The genuine, honest cost of this choice is `musl`/`glibc` incompatibility for any dependency that ships **native, compiled bindings** — an npm package with a C/C++ addon (anything using `node-gyp`, prebuilt binary downloads keyed to `glibc`, or `node-addon-api`) has to either compile cleanly against `musl` from source at install time, or ship a `musl`-specific prebuilt binary; a package that only ships `glibc`-linked prebuilt binaries and doesn't fall back to compiling from source on Alpine will fail to install or fail at runtime with a linking error. Checking `backend/package.json`'s actual `dependencies` for this risk rather than asserting it in the abstract: **`bcrypt`** is exactly this kind of package — it depends on `node-gyp` and compiles a native addon at install time. This is a real, non-hypothetical instance of the tradeoff Alpine introduces, not a theoretical concern: `bcrypt`'s own build tooling does support compiling against `musl` (Alpine ships the build toolchain `node-gyp` needs, and `bcrypt`'s native module has long supported Alpine-based Docker builds), and given that `npm ci` inside this exact Dockerfile has evidently been working (this is the image the app actually ships in), it's compiling successfully here — but it's the one dependency in this codebase where "does this actually work on Alpine" isn't an automatic yes the way it is for every pure-JavaScript dependency, and it's worth knowing to check first if a *future* native dependency gets added and the build starts failing in a way that never reproduces on a Debian-based dev machine. `mongodb-memory-server`, the other dependency in this codebase that touches native binaries (it downloads a real `mongod` binary for tests), is a `devDependency` only — excluded entirely from the production stage's `npm ci --omit=dev`, so it carries none of this risk into the shipped image.

**Multi-stage over distroless or buildpacks, for this project's size and team.** Distroless (§1.3(c)) would shrink the attack surface further than Alpine already does, and would be a reasonable next step to seriously evaluate — but its debugging cost (no shell to `exec` into, per §1.3(c) and §8) is a real, felt cost for a small team without existing sidecar-debugging tooling in place, and for a single first-party backend service (not a widely-distributed public image where minimizing supply-chain surface matters to many downstream consumers), the marginal security win doesn't currently outweigh the operational cost of losing `docker exec -it ... sh` as a debugging tool. Buildpacks (§1.3(d)) solve a different problem than the one AstriX has — the maintenance burden they remove (hand-tracking base-image and language-runtime updates) is real, but AstriX's Dockerfile is a stable, rarely-touched 31 lines, not a churning liability, and buildpacks would trade a small file the team already fully understands and controls for a build tool with its own configuration surface and its own learning curve, for a benefit (less Dockerfile maintenance) that isn't currently a felt pain point. Multi-stage strikes the actual balance AstriX needs today: nearly all of distroless's size and dependency-isolation benefit over a naive single-stage build, full debuggability preserved, and zero new tooling to adopt.

**The COPY-order caching pattern, restated as a design decision rather than a mechanical fact.** §3 and §4 already establish *what* the two-step `COPY package.json ... / RUN npm ci / COPY . .` pattern does; it's worth naming explicitly as a deliberate choice, not an accident of how the Dockerfile happened to get written; the same pattern, absent, would still produce a correct, working image — it would just be meaningfully slower to rebuild on every single code change, since (per §4) the entire dependency tree would reinstall from scratch every time.

---

## 6. Security Considerations

**Non-root `USER node`.** Covered mechanically in §3 — from line 25 onward, the container's actual running process has the same UID the `node` user gets built-in to the base image, not UID 0. The concrete benefit: if an attacker achieves arbitrary code execution inside this container (a supply-chain-compromised dependency, a deserialization bug, anything), the blast radius of what that code can do *inside* the container is bounded by what an unprivileged user can do — no writing to files owned by other users, no listening on privileged (<1024) ports, and, if a container-escape vulnerability in the runtime itself were ever exploited, materially reduced odds of that escape landing as root on the underlying host, since escape techniques frequently depend on the escaping process already holding root inside its namespace.

**No secrets baked into the image at build time.** Verified directly against the pasted Dockerfile in §3, not assumed: there is exactly one `ENV` instruction in the entire file (`ENV NODE_ENV=production`, line 17), and zero `ARG` instructions. No JWT signing secret, no database connection string, no OAuth client secret, no API key appears anywhere in this file. This matters specifically because anything baked into an image via `ENV` or a build-time `ARG` becomes a permanent, extractable part of every layer of that image — inspectable by anyone who can pull it, via `docker history`, `docker inspect`, or simply unpacking the image's layer tarballs directly, regardless of whether the running container ever prints that value anywhere. AstriX's actual secrets (JWT secrets, the Mongo URI, the Resend API key, Google OAuth credentials — all read via `getEnv(...)` in `backend/src/config/app.config.ts`) are injected as real process environment variables at ECS task *start* time, sourced from Parameter Store, not written into this image at build time at all — the same image artifact is therefore safe to store in ECR, scan, and even (hypothetically) make public, without leaking a single credential, because none live inside it.

**Scanning happens downstream, not in this file.** This Dockerfile produces the artifact; it doesn't scan it. `pr-check.yml` runs Trivy against every build on every pull request, failing the check on any `CRITICAL`/`HIGH` finding with a known fix (`ignore-unfixed: true`, §4); `deploy-backend.yml` separately waits on ECR's own native image scanning and blocks the ECS rollout on any `CRITICAL` finding. Both are real, wired-up gates on the exact image this file builds, but the full mechanics of each (how Trivy's database updates, what ECR's scanning actually checks, what "ignore unfixed" really means for triage) belong to the dedicated scanning-and-supply-chain chapter later in this module — this file's contribution is naming that the gate exists and pointing at exactly which CI steps implement it.

**Base-image supply-chain trust — and an honest gap.** `node:20-alpine` (§3, line 1 and line 13) is an official Docker Hub image, maintained by the Docker Official Images program in collaboration with the Node.js project itself — a meaningfully more trustworthy provenance than an arbitrary, unverified third-party image, and reasonable to build on as a starting point. The real gap, checked directly against the Dockerfile rather than assumed: both `FROM` lines pin only the mutable tag `20-alpine`, not a specific patch version (`20.11.1-alpine3.19`, say) and not an immutable content digest (`node@sha256:...`). A floating tag like `20-alpine` gets its underlying content silently replaced whenever the Node project or Alpine ships a new patch release under that same tag — which is desirable for automatically picking up security patches without any Dockerfile change, but means two builds of the exact identical Dockerfile, run on two different days, are not actually guaranteed to produce bit-identical images: the base layer itself can differ. This is a real, plainly-stated tradeoff rather than an oversight to be shamed — floating major-version tags are an extremely common, broadly reasonable default for exactly this "get patches for free" reason — but it does mean this Dockerfile alone provides no cryptographic guarantee that the base layer used to build today's production image is the same one used to build last month's, and a fully reproducible, supply-chain-hardened pipeline would pin to a digest and update it deliberately (ideally via an automated dependency-update tool) rather than floating.

**Attack surface reduction, restated as the throughline.** Every choice covered so far in this section is really one principle applied at a different layer: a smaller image, with fewer installed packages, running as an unprivileged user, with no embedded secrets, scanned before it ships, is strictly less there for an attacker to work with than the naive alternative at every one of those points. None of these decisions individually eliminates risk — a non-root user with a real container-escape vulnerability is still a risk; a scanned image can still ship a zero-day with no known fix yet — but each one independently shrinks what's actually available to exploit if something upstream does go wrong, which is the realistic, layered goal, not a single silver-bullet control.

---

## 7. Best Practice Check

**`node:20-alpine` as a 2026 choice.** Node.js 20 is an LTS release; as of this writing it remains within its supported LTS lifecycle, and choosing an LTS major version rather than tracking Node's latest odd-numbered (non-LTS) release is exactly the right default for a production service that values stability over bleeding-edge features. This part of AstriX's choice is squarely current practice, not dated.

**Unpinned `:20-alpine` — a real drift risk, stated plainly.** As detailed in §6, neither `FROM` line pins a digest or even a specific patch version. Current (2026) best practice for a production-grade pipeline increasingly favors digest-pinning specifically *paired with* an automated update mechanism (Dependabot or Renovate configured to open a PR whenever the pinned digest has a new patch available) — getting the reproducibility benefit of an immutable reference without giving up the "we still get security patches promptly" benefit a floating tag provides implicitly. AstriX's current Dockerfile has the second half of that bargain (patches flow in automatically via the floating tag) but not the first (no way to know, after the fact, exactly which base-image content built a given historical image) — a real, fixable gap rather than a dangerous one, since the floating-tag approach is still a broadly common, defensible default across the industry, just not the more rigorous end of current practice.

**`.dockerignore` — checked directly, and it exists.** It would be easy to assume a missing `.dockerignore` here without checking; it is not missing. `backend/.dockerignore` is a real, present 19-line file:

```
# backend/.dockerignore:1-19
node_modules
npm-debug.log

.env
.env.*
!.env.example

.git
.gitignore

coverage
dist
tests

*.md
.dockerignore
Dockerfile

terraform.tfstate
```

This does real, verifiable work on every `docker build` invocation: without it, the full build context sent to the Docker daemon (which happens before a single Dockerfile instruction runs, over the same mechanism a `.gitignore`-style exclude list controls) would include `node_modules` (megabytes to hundreds of megabytes of a tree that's about to be reinstalled fresh anyway inside the container per §3), the entire `.git` history, any local `.env` file holding real developer secrets, and a stale local `dist/` or `coverage/` directory from a previous local build — none of which the actual `COPY . .` on line 9 needs, and several of which (`.env`, `.git`) would be actively unsafe to have sitting in the build context that gets streamed to the Docker daemon at all, let alone something that could accidentally get `COPY`'d into an image layer by a careless future instruction. AstriX's list is well-targeted, current, and covers the real risk categories (secrets, VCS history, build artifacts, generated files) — there's nothing to flag as missing here. The one minor observation worth naming honestly: `tests` is excluded from the build context, but `backend/package.json`'s own `build` script (`tsc && cp ./package.json ./dist`) already doesn't touch the `tests/` directory at all regardless, so this specific exclusion is a (harmless, still-worthwhile) belt-and-suspenders entry rather than one preventing an otherwise-real inclusion.

**The `EXPOSE 8000` vs. actual-port drift — a real, verified mismatch.** This is worth tracing carefully rather than asserted, since `EXPOSE` (§3) is purely documentary and by itself can't cause a runtime failure. The application's actual listening port is read at runtime from `process.env.PORT`, falling back to `"8000"` only if that variable is unset (`backend/src/config/app.config.ts:6`, `backend/src/index.ts:195`). Checking how ECS actually configures that variable: `infra/environments/dev/variables.tf` declares `app_port` with a `default` of `8080`, not `8000`; `infra/environments/dev/main.tf` passes that value straight through as the ECS module's `container_port` input; and `infra/modules/ecs/main.tf` both injects `PORT=<container_port>` as a real environment variable into the running task and points the container's own health check at `http://localhost:<container_port>...` — meaning the actually-deployed dev environment runs this exact image with `PORT=8080` injected at container start, and the app genuinely listens on 8080 there, correctly matched by ECS's own health check and target-group configuration (also driven by the same `app_port`/`container_port` value, covered in the load-balancing chapter). None of this is broken — `PORT` injection at runtime correctly overrides the Dockerfile's `"8000"` fallback, and every ECS-side piece of configuration agrees with itself on 8080. What's genuinely stale is the Dockerfile's own `EXPOSE 8000` line: it's documentation that no longer describes what this image is actually configured to do in its one real deployed environment, and the ECS module's *own* `container_port` variable (`infra/modules/ecs/variables.tf`) still defaults to `8000` too — matching the Dockerfile, not the dev environment's override. Three numbers that should arguably be one fact (the port this app listens on) currently disagree across three files, reconciled only because the environment-specific override happens to be threaded correctly end-to-end at deploy time. This is exactly the kind of drift that's harmless today because the actually-exercised path is self-consistent, but would confuse the next engineer who reads only the Dockerfile (or only the ECS module's own default) and reasonably assumes it reflects reality.

---

## 8. Debug Drill

**Scenario:** A container built from this image runs fine locally and in one environment, but in another it either won't start at all, crashes immediately after starting, or behaves subtly differently — a generic, extremely common class of "works here, not there" container failure that isn't specific to any one root cause, and is worth having a fixed mental checklist for.

1. **Read the actual failure with `docker logs` (or the CDN-equivalent CloudWatch log stream) before touching anything else.** A container that exits immediately after start almost always logs *something* on its way out — an uncaught exception, a failed startup precondition, a permission error — in the brief window before the process dies. Resist the urge to start changing Dockerfile instructions speculatively before reading this; the fix is usually obvious once the actual error is in front of you, and invisible if you're just guessing from the symptom ("it won't start") alone.

2. **If the failure looks like a permission error — "permission denied" writing to or reading a file — check the interaction between `USER` and file ownership directly**, since §3's `COPY --from=builder --chown=node:node` pattern is exactly the kind of thing a well-intentioned future edit can quietly break. Any new instruction added *after* `USER node` that writes a file (a log file, a cache directory, anything) will attempt that write as the unprivileged `node` user, and will fail with exactly this error if the target directory isn't owned by (or writable by) that user — the fix is either adjusting ownership at the point the directory is created (before `USER node` is set, so it still runs as root and can `chown` freely) or moving the write target to a location `node` already owns.

3. **If the failure only reproduces in one environment and not another, treat it as an environment-variable diff problem before anything else.** Per §7's `EXPOSE`/port discussion, this exact image's actual runtime port depends entirely on whatever `PORT` value gets injected at container start — an image is not what determines behavior here, the combination of image *and* the environment it's launched into is. The single fastest way to rule this class of bug in or out: `docker exec -it <container> env` (or the ECS-equivalent — reading the actual resolved environment for the specific running task) against the working and non-working environments, side by side, and diff them line by line rather than assuming they match because "it's the same image."

4. **If the container keeps restarting under repeated OOM-kills, that's a cgroup memory-limit signal (§1.1), not an application bug to chase inside the code first.** A container hitting its configured memory ceiling gets killed by the kernel's OOM mechanism at the cgroup level — the process doesn't get a chance to log a graceful error, because it's terminated abruptly from outside. The tell here is checking the container/task's exit code and status directly (an ECS task, for instance, will show a distinct stopped-reason for an out-of-memory kill, separate from an ordinary non-zero application exit) rather than assuming any log line will explain it, since by definition the process may not have gotten to log anything about its own death.

5. **If none of the above explains it, and a shell is available inside the image (true for this Alpine-based build — false for a hypothetical future distroless migration, §1.3(c)), get inside the actual failing container and look directly** — `docker exec -it <container> sh` (Alpine ships `sh`, specifically BusyBox's `ash`, not `bash`, which occasionally trips up a first attempt at `docker exec -it <container> bash`, since bash simply isn't installed on Alpine by default) to check the real, current filesystem state, actually-resolved environment variables, and actually-running process list from inside the container's own namespaces, rather than continuing to reason about it only from the outside.
