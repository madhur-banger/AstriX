# Build Tooling & Bundle Optimization

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Frontend](./00-master-frontend-architecture.md).

Every other file in this module has been about what runs *in the browser* — components, routes, state, forms. This file is about the step before any of that exists: turning a folder of TypeScript and JSX source files that no browser can execute directly into a set of plain `.js`, `.css`, and `.html` files that any static file host can serve. That transformation — commonly just called "the build" — is a genuinely large piece of engineering in its own right, with its own landscape of competing tools, its own failure modes, and its own security surface, and it's easy to treat as an invisible implementation detail right up until it breaks in a way that only shows up in production. This file covers how AstriX's build actually works mechanically: Vite as both dev server and production bundler, the `@` import alias and the two independent places it has to be configured, how route-level `lazy()` calls (already introduced from the routing angle in [`02-routing-and-code-splitting.md`](./02-routing-and-code-splitting.md)) turn into literal separate files on disk, how `VITE_`-prefixed environment variables get baked into those files at build time, and the opt-in tooling AstriX has for inspecting what actually ends up in the shipped bundle.

---

## 1. The Landscape

"How do you turn a tree of modern JS/TS/JSX source files into something a browser can run, and how do you make the edit-save-see-the-change loop fast while you're writing it" is a problem every non-trivial frontend project has to solve, and the tooling that solves it has gone through a real, well-documented generational shift. Four tools are worth knowing by name, not as a history lesson but because recognizing which one an unfamiliar codebase uses tells you immediately what its dev-server behavior, config shape, and plugin ecosystem will look like.

### (a) Webpack — the long-time dominant bundler

Webpack, first released in 2012, is the tool most engineers who learned React any time between roughly 2015 and 2021 cut their teeth on. Its model is: build a complete dependency graph starting from one or more entry points, run every file through a chain of *loaders* (transforms — Babel for JSX/modern syntax, `css-loader`/`style-loader` for stylesheets, `file-loader` for images), and emit one or more fully-bundled output files. Nothing is served to the browser until this entire graph has been walked and bundled at least once.

```js
// illustrative webpack.config.js — not AstriX code
module.exports = {
  entry: "./src/index.js",
  output: { filename: "bundle.js", path: __dirname + "/dist" },
  module: {
    rules: [
      { test: /\.jsx?$/, use: "babel-loader", exclude: /node_modules/ },
      { test: /\.css$/, use: ["style-loader", "css-loader"] },
    ],
  },
};
```

Webpack's genuine strength is its plugin ecosystem and configurability — after more than a decade of production use, there is a Webpack loader or plugin for nearly anything (module federation for micro-frontends, arbitrary asset pipelines, custom code-splitting heuristics), and every major meta-framework's older tooling (older Next.js, older Create React App, Angular CLI under the hood) was built on it. Its well-known cost is dev-server iteration speed: because the traditional Webpack dev server still has to bundle the *entire* module graph reachable from the entry point before serving anything (dev-mode "fast" rebuilds via `webpack-dev-server`'s HMR narrow the *rebuild* after the first load, but that first cold start, and any full-graph invalidation, scale with app size) — a large app with thousands of modules can mean multi-second-to-tens-of-seconds cold starts and rebuilds, which compounds across a working day into real lost time. Webpack 5 improved this considerably (persistent caching, better tree-shaking), but the fundamental "bundle first, serve second" architecture is still there.

### (b) esbuild and Turbopack — compiled bundlers built for raw speed

esbuild (Go, first released 2020) and Turbopack (Rust, built by Vercel, shipped as Next.js's newer bundler) both attack the same problem from the same angle: JavaScript-based bundlers/transpilers (Webpack, Babel, Terser) are fundamentally limited by running on a single-threaded, garbage-collected VM, so rewriting the hot path — parsing, transforming, bundling, minifying — in a compiled, natively-parallel language yields order-of-magnitude speedups for the same work.

```js
// illustrative esbuild programmatic API — not AstriX code
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.tsx"],
  bundle: true,
  outfile: "dist/bundle.js",
  minify: true,
});
```

esbuild is frequently *not* the end-user-facing tool itself but the engine underneath something else — Vite uses esbuild internally for two specific jobs (dependency pre-bundling and, in dev, transpiling individual TS/JSX files), which matters directly to how AstriX's own tooling works, covered below. Turbopack is Vercel's newer, Rust-based answer specifically aimed at Next.js's dev and build pipeline, with an incremental, function-level caching model (recompute only what actually changed, at a finer grain than "this file changed, retranspile this file") — it's been rolling out as Next.js's default bundler for both `next dev` and `next build` across recent Next.js major versions. The tradeoff for both tools is ecosystem maturity relative to Webpack: fewer, though rapidly growing, third-party plugins, and (for Turbopack specifically) tight coupling to the Next.js framework rather than being a general-purpose bundler a non-Next.js project would reach for directly.

### (c) Vite — native-ESM dev server, Rollup for production (what AstriX uses)

Vite (French for "fast", first released 2020, largely driven by the Vue.js team but framework-agnostic) rejects the "bundle everything, then serve" model outright for development. Modern browsers support ES modules natively — `<script type="module">`, native `import`/`export` — so instead of pre-bundling the whole app, Vite's dev server serves source files directly over native ESM, transforming each file on demand, only when the browser actually requests it, using esbuild for the TS/JSX-to-JS transform because esbuild is fast enough to do this per-file on every request without a perceptible delay. This is the mechanical reason Vite's dev-server cold start is close to instant regardless of app size: there is no upfront full-bundle step to wait through at all — the server just starts and waits for the browser to ask for files, transforming them lazily as requested.

```ts
// illustrative minimal vite.config.ts — not AstriX's actual config, shown in full in §3
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({ plugins: [react()] });
```

For production, Vite switches strategy entirely and hands the job to Rollup, a mature, tree-shaking-focused bundler — because native ESM-over-HTTP, while fine for a dev server on localhost, would mean the production app makes an unacceptable number of individual network requests (one per module) if shipped as-is; a real production build still wants a small number of well-chunked, minified, cache-friendly output files. This dev/build split — instant native-ESM serving while you're iterating, a real bundler for what actually ships — is Vite's defining idea, and it's the whole reason "Vite is fast in dev" and "Vite produces a good production bundle" are two separate, both-true claims resting on two different underlying engines (esbuild in dev, Rollup for `vite build`).

### (d) Create React App (CRA) — the deprecated baseline

Create React App, released by Facebook/Meta in 2016, was for years *the* default answer to "how do I start a new React project" — `npx create-react-app my-app` gave you a zero-config Webpack + Babel setup with sensible defaults, hidden entirely behind `react-scripts start`/`build`/`test`/`eject`. Its config was intentionally not exposed; the only escape hatch was `eject`, an irreversible one-way operation that dumped the full generated Webpack config into your project for you to maintain by hand from that point on.

```json
// illustrative CRA-era package.json scripts — not AstriX code
{
  "scripts": {
    "start": "react-scripts start",
    "build": "react-scripts build",
    "test": "react-scripts test",
    "eject": "react-scripts eject"
  }
}
```

CRA is worth naming specifically and explicitly, not as a strawman, but because it's still what a meaningful fraction of older tutorials, Stack Overflow answers, and bootcamp curricula show — and it should no longer be anyone's default choice for a new project. The React team itself stopped recommending it: the official React documentation no longer lists CRA among its suggested ways to start a new app, and the `create-react-app` package has carried a deprecation notice for some time now. The practical reasons line up with everything said about Webpack above, compounded by CRA's own added layer of being effectively unmaintained relative to the pace of the rest of the ecosystem — dev-server rebuild times that scale poorly with app size, a Webpack version pinned by `react-scripts` rather than upgradable independently, and a config surface you either accept entirely as-is or abandon completely via the irreversible `eject`. If you open an unfamiliar React codebase in 2026 and see `react-scripts` in `package.json`, that's a strong, immediate signal you're looking at either a genuinely old project or one that hasn't been re-evaluated against current tooling — not a neutral, still-current choice the way finding Webpack directly (hand-configured, not via CRA) still can be for a team with specific plugin needs.

---

## 2. AstriX's Choice

AstriX uses **Vite** for both development and production: `vite` as the dev server (`npm run dev`), and `vite build` — which under the hood hands off to Rollup — for the production bundle (`npm run build`, itself preceded by a separate TypeScript type-check step covered in §3.3). Nothing about AstriX's setup is CRA-adjacent, hand-rolled Webpack, or Turbopack (Turbopack is Next.js-specific tooling and AstriX has no Next.js dependency at all — no SSR, no meta-framework, per [`00-master-frontend-architecture.md`](./00-master-frontend-architecture.md)). On top of Vite's own defaults, AstriX adds exactly three pieces of custom build configuration: a single `@` path alias, an opt-in bundle-visualizer plugin gated behind an environment variable, and a Vitest test configuration folded into the same config file.

---

## 3. AstriX Implementation

### 3.1 The whole of `vite.config.ts`

```ts
// client/vite.config.ts:1-31
import path from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Only emits stats.html when explicitly requested (`npm run build:analyze`)
    ...(process.env.ANALYZE
      ? [
          visualizer({
            filename: "dist/stats.html",
            gzipSize: true,
            open: true,
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
```

This is the entire file — 31 lines, no more, no less — and every line is doing real work worth naming individually.

**The import on line 2 is not from `"vite"`.** It's `defineConfig` from `"vitest/config"` — a re-export that Vitest ships specifically so a project can define one config object that satisfies both Vite's own config shape *and* Vitest's `test` key (seen at the bottom of the file) in the same file, with full type-checking on both halves. This is why AstriX doesn't need a separate `vitest.config.ts`: the same file that configures the dev server and the production build also configures the test runner, because Vitest itself is built on Vite's transform pipeline (it uses the same on-demand esbuild transforms Vite's dev server uses, rather than a separate transpilation step) — one config surface for "how do I turn source into runnable code," reused identically whether that code is running in a browser via `vite dev`, being bundled via `vite build`, or being executed in a test environment via `vitest`.

**`react()` (line 9)** is `@vitejs/plugin-react`, and it's what actually makes JSX and React Fast Refresh (React's component-preserving hot-reload) work — Vite's own core doesn't know anything about JSX syntax or React specifically; this plugin adds the esbuild-based JSX transform and wires up the Fast Refresh runtime.

**The conditional spread on lines 10–19** is the entire mechanism behind the opt-in bundle-analysis tooling this file's task specifically calls out, covered in depth in §3.5 below.

**`resolve.alias` (lines 21–25)** is half of the `@` path-alias story, covered in §3.2.

**The `test` block (lines 26–30)** configures Vitest to run in a simulated DOM (`jsdom`) rather than Node's default environment (necessary for any test that renders a React component and expects `document`/`window` to exist), points at a shared setup file, and disables CSS processing during tests (`css: false`) since test assertions care about rendered DOM structure and text content, not computed styles — processing every imported stylesheet on every test run would be pure overhead with no payoff for what the test suite actually checks. This block is outside this file's core scope (frontend testing patterns belong to `docs/testing/`, per [`00-master-frontend-architecture.md`](./00-master-frontend-architecture.md)'s note that testing is taught once, for both sides, in one place) but it's worth seeing here because it's proof of the same "one config, several consumers" point made above.

### 3.2 The `@` alias — configured twice, in two unrelated tools

The `@/...` import syntax used throughout AstriX's frontend (`import useAuth from "@/hooks/api/use-auth"`, seen in nearly every file this curriculum has quoted) is not a language feature — plain JavaScript/TypeScript has no built-in concept of a `@` alias. It's a convention two *separate* tools have each been told, independently, to resolve the same way. Get this right in only one of them and you get a real, specific, easy-to-hit failure mode: the app either won't build, or it will build and run fine while your editor shows red squiggly lines everywhere, or the reverse.

**Tool one: Vite's own module resolver**, for anything Vite itself has to resolve — every `import` statement the dev server serves over native ESM, and every `import` Rollup has to trace to build the production bundle:

```ts
// client/vite.config.ts:21-25
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
```

`path.resolve(__dirname, "./src")` turns into an absolute filesystem path at config-load time, so `@/hooks/api/use-auth` resolves to `<repo>/client/src/hooks/api/use-auth`. Without this, neither `npm run dev` nor `npm run build` would have any idea what `@` means — every `@/...` import in the codebase would fail to resolve, and the app simply wouldn't run at all, in dev or in the build.

**Tool two: the TypeScript compiler's own module resolution**, used by `tsc` (the standalone type-checker, run via `tsc -b` in the `build` script, §3.3) and by every editor's TypeScript language server (which is what actually produces red squigglies, "go to definition," and autocomplete):

```json
// client/tsconfig.app.json:1-30
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,

    /* Bundler mode */
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",

    /* Linting */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

`compilerOptions.paths` (lines 25–27) is TypeScript's own, completely independent alias mechanism — it tells the type-checker "when you see an import starting with `@/`, look for the rest of the path under `./src/`." Crucially, **`paths` by itself does nothing to actually resolve modules at runtime** — TypeScript's own documentation is explicit that `paths` only affects type-checking and editor tooling; it doesn't rewrite import paths in emitted output (and AstriX's config takes this further: `noEmit: true` on line 15 means `tsc` never emits any JS at all here — see §3.3). If `vite.config.ts`'s `resolve.alias` didn't exist, TypeScript alone declaring `@/*` would make the *editor* happy (imports would resolve, autocomplete would work, `tsc -b` would pass) while the actual running app — built by Vite/Rollup, which know nothing about `tsconfig.json`'s `paths` field — would crash on every `@/...` import at runtime. The reverse mismatch is just as real: delete `paths` from `tsconfig.app.json` but leave `vite.config.ts`'s alias in place, and the app runs perfectly in the browser (Vite resolves it) while every editor and `tsc -b` reports "cannot find module" on every single `@/...` import — a build that works and a codebase that looks, to any type-aware tool, completely broken. AstriX's two configs agree, which is why this mismatch isn't something you'll observe today — but it's exactly the kind of drift that a future refactor (renaming `src/` to `app/`, say) could silently reintroduce if only one of the two files gets updated.

One more detail worth being precise about: `moduleResolution: "bundler"` (line 11) is itself a comparatively recent TypeScript option, and its presence here isn't incidental to this alias discussion — it's TypeScript explicitly telling its own resolver to mimic how a modern bundler (Vite/esbuild/Rollup) resolves imports, rather than emulating classic Node.js CommonJS resolution rules. That's what lets `allowImportingTsExtensions` (line 12) coexist with `noEmit` (line 15): since TypeScript here is a pure checker that never produces the files that actually ship, it can afford to understand import specifiers the way the *real* bundler resolves them, including things like extensionless imports and the alias declared in `paths`, without needing its own resolution algorithm to be runtime-correct in the traditional Node sense.

The root `tsconfig.json` — what `tsc -b` actually reads first — is mostly a thin project-references pointer, but repeats the same `paths` entry:

```json
// client/tsconfig.json:1-13
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ],
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

`"files": []` plus `"references"` is TypeScript's *project references* / composite-build mode: this root config builds nothing itself and instead delegates to two child projects (`tsconfig.app.json` for `src/`, `tsconfig.node.json` for Node-context config files like `vite.config.ts` itself, which runs under Node, not in the browser, and therefore needs different `lib`/`module` settings than app code does). The `paths` entry duplicated here is what lets an editor resolve `@/...` imports correctly when it loads the *root* config as the entry point for the whole workspace, rather than jumping straight to `tsconfig.app.json`.

### 3.3 `tsc -b && vite build` — why type-checking is a separate step

```json
// client/package.json:6-17
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "build:analyze": "tsc -b && ANALYZE=true vite build",
    "lint": "eslint .",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ui": "vitest --ui",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
```

`dev` runs bare `vite` — just the dev server, no type-checking step at all. `build` is a two-command chain joined with `&&`: `tsc -b` first, then `vite build`, the second only running if the first exits successfully (shell `&&` semantics — a non-zero exit from `tsc -b` stops the chain before `vite build` ever starts). This two-step shape is not an accident or redundancy; it's addressing a specific, easy-to-miss fact about how Vite (and esbuild, which does Vite's actual TS transform work) handles TypeScript: **Vite/esbuild strip TypeScript types, they do not check them.** esbuild's TS support is a syntax transform — it recognizes `: string`, `interface`, `as SomeType`, and erases these constructs to produce plain JavaScript, at the speed that makes Vite's near-instant dev server possible in the first place — but it never asks "is this code actually type-correct?" A file with a real type error (calling a function with the wrong argument type, accessing a property that doesn't exist) will transpile just fine through esbuild and run in the browser, type error and all, silently.

That's precisely why `tsconfig.app.json` sets `noEmit: true` (line 15, §3.2): this config's `tsc` invocation is never meant to produce the JS that ships — Vite/esbuild already do that job, faster. `tsc -b`'s only job in AstriX's pipeline is to be a pure gate: walk the full project (via the reference graph in the root `tsconfig.json`), type-check every file against `strict` mode plus the extra linting-adjacent checks also visible in `tsconfig.app.json` (`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`), and exit non-zero the instant it finds a real type error — which, thanks to `&&`, means `vite build` never even starts, and no broken bundle gets produced at all. `npm run dev`, by contrast, skips this gate entirely: a developer can have an in-progress, type-broken file open and still see it render live in the browser via the dev server, because dev-mode iteration speed matters more than blocking on every transient type error while someone's mid-edit — the gate exists specifically at the point where a real artifact is about to be produced and shipped, not on every keystroke.

`build:analyze` is the same two-step chain, with one difference: `ANALYZE=true` is set as an environment variable for that one invocation of `vite build`, which is exactly the flag `vite.config.ts` checks on line 11 (`process.env.ANALYZE`) to conditionally include the `visualizer` plugin — covered next.

### 3.4 `VITE_`-prefixed environment variables — build-time, not runtime

```
// client/.env.example:1
VITE_API_BASE_URL="http://localhost:8000/api"
```

This is the entirety of `client/.env.example` — one variable. It's used in exactly one place in the codebase:

```ts
// client/src/lib/base-url.ts:1
export const baseURL = import.meta.env.VITE_API_BASE_URL;
```

Vite has a hard, deliberate rule about environment variables: only variables whose name starts with `VITE_` are exposed to client code at all, and they're exposed via `import.meta.env.VITE_*`, never via `process.env` (there is no `process` global in code that runs in the browser — Vite doesn't polyfill one for this purpose). Any environment variable present at build time *without* the `VITE_` prefix — say a plain `API_SECRET` sitting in the shell environment during `npm run build` — is invisible to `import.meta.env` entirely; Vite filters it out specifically so that arbitrary CI/shell environment variables (which might legitimately contain secrets meant for other tooling) don't accidentally leak into client code just because they happened to be set when the build ran. The prefix isn't a style convention AstriX chose — it's Vite's own safety mechanism, and understanding it precisely is what §6 below builds on.

The mechanical part that trips people up coming from a server-rendered or container-based background: this is not a runtime lookup. `import.meta.env.VITE_API_BASE_URL` doesn't ask "what's this variable's value right now, in this browser tab, on this visitor's machine" the way `process.env.SOME_VAR` asks the OS "what's this variable's value in the current process" on a running server. Vite performs a **static, textual replacement** at build time — every occurrence of `import.meta.env.VITE_API_BASE_URL` in the source is literally substituted with the string value that variable held during the `vite build` invocation, baked directly into the emitted JavaScript, before that file is ever uploaded anywhere or opened in anyone's browser. By the time a visitor's browser downloads and executes that file, there's no environment variable being read at all anymore — just a hardcoded string that used to be a variable reference.

Contrast this directly with how the backend handles configuration, since the two could not be more different despite looking superficially similar in the source code:

```ts
// backend/src/config/app.config.ts:1-7
import { getEnv } from "../utils/get-env";

type NodeEnv = "development" | "production" | "test";

const NODE_ENV = getEnv<NodeEnv>("NODE_ENV", "development");
const PORT = getEnv("PORT", "8000");
const BASE_PATH = getEnv("BASE_PATH", "/api");
```

`getEnv` (full treatment in [`../backend/00-master-backend-architecture.md`](../backend/00-master-backend-architecture.md)) reads `process.env` when the Node process actually starts — which, per [`../Architecture.md`](../Architecture.md) §2, is when the ECS task launches, with values injected from SSM Parameter Store into the container's environment at that moment. Change a backend environment variable in SSM, redeploy (or even just restart) the ECS task, and the *same, unchanged Docker image* picks up the new value the next time it boots, because the value is read fresh from the process environment every time the process starts. There is no equivalent move on the frontend. Because `VITE_API_BASE_URL`'s value is textually frozen into the static `.js` files the moment `vite build` runs, changing it requires producing an entirely new build — a full `tsc -b && vite build` — and then replacing the old static assets in S3 with the new ones. **Restarting a running frontend "process" isn't a meaningful concept, because there is no running process** — the deployed artifact is just files on a CDN, and the only way to change what's baked into them is to rebuild and redeploy. This is one of the most important, transferable mental-model differences for anyone moving from backend/container-based config to a static-SPA deploy model: "just change the env var and restart" is a backend move that has no frontend equivalent.

AstriX's own deploy pipeline is the concrete evidence for exactly this flow, and it's worth reading as a single, real, end-to-end trace of "where does `VITE_API_BASE_URL`'s value actually come from in production":

```yaml
# .github/workflows/deploy-frontend.yml:54-75
      - name: Get API URL from SSM
        id: ssm
        run: |
          API_URL=$(aws ssm get-parameter --name "/astrix/dev/VITE_API_BASE_URL" --query "Parameter.Value" --output text)
          echo "api_url=$API_URL" >> $GITHUB_OUTPUT

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
```

Notice this is the *same* SSM Parameter Store backing the backend's own secrets ([`../Architecture.md`](../Architecture.md) §2), reused here for a fundamentally different delivery mechanism — the backend's ECS task definition injects SSM values into `process.env` at container start (a *runtime* mechanism, orchestrated by AWS), while here a GitHub Actions step reads the same kind of SSM parameter and sets it as a plain step-scoped environment variable (`env:` on the `Build` step, lines 74–75) that only exists for the duration of that one `npm run build` invocation. Vite's static replacement then does the rest — by the time `dist/` exists on disk, `VITE_API_BASE_URL` as an environment variable is gone; what remains is the literal URL string, hardcoded into whichever `.js` file references `import.meta.env.VITE_API_BASE_URL`. Two completely different config-delivery mechanisms, sharing a parameter store purely as a convenient source of truth, not as evidence they work the same way.

### 3.5 Route-level `lazy()` — the build-output mechanics

[`02-routing-and-code-splitting.md`](./02-routing-and-code-splitting.md) already covers *why* every page in AstriX's route tables is wrapped in `lazy()` and how `<Suspense>` handles the loading state while a chunk is in flight — that's routing logic, not build tooling, and it isn't repeated here. What that file doesn't get into, and what belongs squarely in this one, is what `lazy()` actually does to the files Rollup produces:

```tsx
// client/src/routes/common/routes.tsx:1-19
import { lazy } from "react";
import { AUTH_ROUTES, BASE_ROUTE, PROTECTED_ROUTES } from "./routePaths";

const SignIn = lazy(() => import("@/page/auth/Sign-in"));
const SignUp = lazy(() => import("@/page/auth/Sign-up"));
const ForgotPassword = lazy(() => import("@/page/auth/ForgotPassword"));
const ResetPassword = lazy(() => import("@/page/auth/ResetPassword"));
const WorkspaceDashboard = lazy(() => import("@/page/workspace/Dashboard"));
const Members = lazy(() => import("@/page/workspace/Members"));
const ProjectDetails = lazy(() => import("@/page/workspace/ProjectDetails"));
const Settings = lazy(() => import("@/page/workspace/Settings"));
const Tasks = lazy(() => import("@/page/workspace/Tasks"));
const AccountSettings = lazy(() => import("@/page/account/AccountSettings"));
const InviteUser = lazy(() => import("@/page/invite/InviteUser"));
const LandingPage = lazy(() => import("@/page/home/landingPage"));
const Unauthorized = lazy(() => import("@/page/errors/Unauthorized"));
const VerifyEmail = lazy(() => import("@/page/auth/VerifyEmail"));
const TermsOfService = lazy(() => import("@/page/legal/TermsOfService"));
const PrivacyPolicy = lazy(() => import("@/page/legal/PrivacyPolicy"));
```

`React.lazy()` itself is a thin wrapper around a *dynamic import* — `import("@/page/auth/Sign-in")` as a function call, rather than a static `import SignIn from "@/page/auth/Sign-in"` at the top of the file. That syntactic difference is the entire mechanism this section is about: a static `import` is something a bundler resolves and inlines into whatever chunk the importing file ends up in, at build time, unconditionally. A dynamic `import()` call is a *signal* to the bundler — both Rollup (production) and Vite's dev-time ESM graph (development) — that this module should **not** be eagerly included in the parent's chunk, but instead built as its own, separate, independently-loadable output file, fetched over the network only at the moment the `import()` call actually executes.

For `vite build` specifically, this is Rollup's own well-documented code-splitting behavior: Rollup statically analyzes the whole module graph, and every distinct dynamic-`import()` target becomes the entry point for its own output chunk, emitted as a separate file under `dist/assets/`, each one content-hashed into its filename (Vite's default output naming convention is `<chunk-name>-<content-hash>.js`) so that a change to one page's code produces a new filename for *that* chunk only — the browser (or CloudFront, per the invalidation discussion in §4) can then cache every *other* unchanged chunk indefinitely, because its filename, and therefore its cache key, hasn't moved. Concretely: the sixteen `lazy()` calls above mean sixteen separate page components each become the root of their own chunk (plus whatever additional shared chunks Rollup's own deduplication decides to factor out for code multiple pages import in common), rather than all sixteen pages' code living inside one monolithic `main.js` that every single visitor has to download in full before seeing anything — a visitor who only ever looks at their own workspace's task board never has their browser fetch the JS for `TermsOfService` or `PrivacyPolicy` at all, unless they actually navigate there.

It's worth being explicit that this chunking behavior is not something AstriX's `vite.config.ts` configures at all — there is no `build.rollupOptions.output.manualChunks` entry, no custom splitting strategy in the file shown in §3.1. Route-level code splitting here is entirely a side effect of *how the page components are imported* in `routes.tsx`, not a build-config decision — which is worth naming as a design tradeoff in its own right (§5).

### 3.6 Opt-in bundle analysis — `rollup-plugin-visualizer`

The last piece of custom configuration in `vite.config.ts` is the conditional plugin block from §3.1, repeated here for focus:

```ts
// client/vite.config.ts:10-19
    // Only emits stats.html when explicitly requested (`npm run build:analyze`)
    ...(process.env.ANALYZE
      ? [
          visualizer({
            filename: "dist/stats.html",
            gzipSize: true,
            open: true,
          }),
        ]
      : []),
```

`rollup-plugin-visualizer` is a Rollup plugin (usable directly from Vite's config because Vite's production build *is* Rollup, and Vite plugins can be either Vite-specific or plain Rollup plugins) that, after the production build finishes, generates `dist/stats.html` — a treemap visualization where every rectangle is one module in the final bundle, sized proportionally to how many bytes of the shipped output it accounts for (`gzipSize: true` means the sizing reflects post-compression bytes, which is a far more honest measure of real download cost than raw source size). Opening that file in a browser (`open: true` does this automatically) answers the question "what is actually taking up space in what I'm shipping to users" at a glance — is it one specific dependency that turned out much heavier than expected, is a chunk that should have been small pulling in something it shouldn't, is code-splitting actually working the way §3.5 describes or did two supposedly-separate chunks somehow end up bundled together.

The conditional spread (`...(process.env.ANALYZE ? [...] : [])`) is a plain JavaScript idiom for "include this plugin only if `ANALYZE` is set" — spreading an empty array contributes nothing to the `plugins` array, spreading a one-element array contributes exactly that plugin. Gating it behind an environment variable rather than always running the visualizer is a deliberate cost/benefit call: generating the treemap adds real time and memory to every build (walking the entire final module graph and rendering an HTML visualization of it isn't free), and that cost buys nothing on the overwhelming majority of builds, where nobody is about to look at `stats.html` at all. Paying that cost on every single CI deploy build, for a payoff only realized on the rare occasion someone is actively investigating bundle size, would be pure waste — so it's wired to only activate via the dedicated `build:analyze` script (`tsc -b && ANALYZE=true vite build`, §3.3), which a developer runs by hand, locally, specifically when they want the answer to "what's actually in this thing."

---

## 4. Request/Data Flow

**Flow A — `npm run dev`.** The developer runs `vite` (no `tsc -b` gate, §3.3). The dev server starts near-instantly — there's no upfront bundling step to wait through, so startup time is essentially flat regardless of how many files `client/src/` contains. The browser requests `index.html`, which references `/src/main.tsx` as a native `<script type="module">`. The browser then requests that module directly; Vite intercepts the request, runs it through esbuild's on-the-fly TS/JSX transform (stripping types, compiling JSX to `React.createElement` calls), and serves back plain JS — then the browser reads that file's own `import` statements and issues *further* requests for each one, and Vite repeats the same on-demand transform for each, recursively, only ever touching the files actually reachable from what's currently rendered. First-party dependencies from `node_modules` (React, React Query, Zustand, everything in `client/package.json`'s `dependencies`) go through a separate step called dependency pre-bundling — Vite uses esbuild once, up front, to convert these into single, pre-optimized ESM files cached in `node_modules/.vite`, both because many packages still ship as CommonJS (which doesn't work with native browser `import` without conversion) and because a library split across dozens of internal files would otherwise mean dozens of separate HTTP requests just to load one dependency. Editing a file and saving triggers Vite's HMR (hot module replacement): a WebSocket connection between the dev server and the browser pushes just the changed module, and React's Fast Refresh (via the `react()` plugin, §3.1) swaps it into the already-running app in place, preserving component state where possible, rather than a full page reload.

**Flow B — `npm run build`, traced through to a real deploy.** `tsc -b` runs first (§3.3), walking the full type graph across `tsconfig.app.json` and `tsconfig.node.json` via the root `tsconfig.json`'s project references. Any real type error stops the chain here — `vite build` never runs, no artifact is produced, and (in CI, per [`../Architecture.md`](../Architecture.md) §5's `pr-check.yml`) the PR check fails before anything is ever deployed. If type-checking passes, `vite build` runs: Rollup builds the full module graph starting from `index.html`/`main.tsx`, applies tree-shaking (statically determining which exports are actually used anywhere and discarding the rest — a mature capability of Rollup specifically, part of why Vite delegates production bundling to it rather than reusing esbuild's own, less thorough bundling mode for this step), splits the graph into chunks at every dynamic-`import()` boundary (§3.5), minifies the result, and emits everything into `client/dist/`. In CI, this whole two-step build happens inside `deploy-frontend.yml`:

```yaml
# .github/workflows/deploy-frontend.yml:77-87
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

`aws s3 sync dist/ s3://$S3_BUCKET/ --delete` uploads every file Rollup just emitted and — because of `--delete` — removes anything in the bucket that *isn't* in the new `dist/` output, so old, orphaned chunk files from a previous build (remember, filenames are content-hashed, so a changed chunk gets an entirely new filename rather than overwriting the old one) don't accumulate forever in the bucket. The final step invalidates CloudFront's cache for every path (`--paths "/*"`), which matters precisely because CDNs exist to avoid re-fetching from the origin (S3) on every request — without this invalidation, CloudFront could keep serving a cached copy of `index.html` (and the old, now content-hash-mismatched chunk references inside it) for however long its TTL allows, even though the new files are already sitting in S3. This three-step sequence — build, sync, invalidate — is the mechanical tail end of the exact deploy flow [`../Architecture.md`](../Architecture.md) §5 already names at a higher level; this file's contribution is showing precisely which commands run and why each one is necessary given how Vite/Rollup name and emit their output.

---

## 5. Design Decisions & Tradeoffs

**Why Vite over Webpack, CRA, or Turbopack, specifically for AstriX.** AstriX is a pure client-side-rendered SPA with no server-rendering requirement and no meta-framework dependency (§2) — exactly the shape of project Vite's dev/build split was designed around. Turbopack isn't really a competing option here at all outside a Next.js context, since adopting it would mean adopting Next.js itself, a far larger architectural change with no clear payoff for an app that doesn't need SSR. Webpack remains a legitimate, powerful choice for teams that need its specific plugin ecosystem (module federation for a micro-frontend architecture, in particular, is still more mature on Webpack than anywhere else) — but AstriX has no such requirement, and paying Webpack's slower dev-iteration cost for capabilities the app never uses would be a bad trade. CRA was never seriously in the running for a project started with current tooling in mind; it's included in §1 specifically as the "what not to reach for by default" baseline, not a real alternative AstriX weighed and rejected.

**Why gate the visualizer instead of always running it.** As covered in §3.6, `rollup-plugin-visualizer` adds real build time for a payoff only realized when someone's actively debugging bundle size. Running it on every CI build (including the majority where nobody's about to look at the output) would slow down every single deploy for no benefit on those runs — the `ANALYZE` env-var gate means the cost is paid exactly when the value is actually wanted, by the person who wants it, and never otherwise.

**Why two separate alias declarations instead of one shared source of truth.** §3.2's Vite/TypeScript alias duplication is a real, acknowledged cost — two files that must agree, with no structural guarantee that they do beyond a human keeping them in sync. The ecosystem does offer an escape from this: a plugin like `vite-tsconfig-paths` reads `tsconfig.json`'s `paths` at Vite-config-load time and auto-derives `resolve.alias` from it, collapsing the two declarations into one source of truth. AstriX doesn't use it — the plain, duplicated-but-explicit version in `vite.config.ts` and `tsconfig.app.json` is what's actually in the repo. For a single alias (`@` → `src`) that's unlikely to change shape, the duplication cost is genuinely small and the config stays legible without an extra dependency; the tradeoff would look different for a project with many aliases or one that changes its folder structure often, where the sync burden compounds.

**Why route-level splitting via `lazy()` rather than an explicit chunking strategy in `vite.config.ts`.** As noted in §3.5, AstriX's entire code-splitting story rides on *where* `lazy()` is used in application code, not on any `build.rollupOptions.output.manualChunks` configuration. This keeps the splitting boundary intuitive and colocated with the thing it affects — a new page gets its own chunk automatically the moment it's added to `routes.tsx` via `lazy()`, no build-config change required — at the cost of not controlling *vendor* chunking explicitly (see §7 for whether that's a real gap at AstriX's current scale).

---

## 6. Security Considerations

**Everything with a `VITE_` prefix ships in the public bundle, full stop.** This is the single most important thing to internalize from §3.4, restated forcefully because getting it wrong is a real, common, and serious class of mistake: Vite statically inlines every `VITE_`-prefixed variable's value directly into the JavaScript files it emits, and those files are served, unauthenticated, to anyone who loads the app — readable by opening browser devtools' Sources tab, by viewing the page source, by simply downloading the `.js` file directly with `curl`. There is no build-time/runtime distinction that protects a `VITE_`-prefixed secret the way an environment variable read by a server process at runtime is protected (that process's environment is never sent to the client) — a `VITE_`-prefixed API key, database credential, or any other value meant to stay server-side is, the moment it's given that prefix, no longer a secret at all; it's public data, exactly as public as the rest of the bundle. **Nothing with real access implications — an API key that grants write access, a signing secret, a third-party credential — should ever be given a `VITE_` prefix.** The prefix is Vite's *opt-in* mechanism for exposing values to the client; treat adding it to any variable name as equivalent to committing that value's plaintext to a public file, because that's mechanically what happens.

Checked against this standard, AstriX's actual `.env.example` is clean: the one variable it declares, `VITE_API_BASE_URL`, is an API base URL — a value that's unavoidably visible to anyone using the app anyway, since every single network request the browser makes is plainly visible in that same browser's Network tab regardless of whether it's baked into the bundle or not. There's nothing questionable in it; this is exactly the category of value the `VITE_` prefix exists for. The honest caveat is that this is a snapshot of current, correct discipline, not a structural guarantee — nothing in AstriX's tooling stops a future contributor from naming a new variable `VITE_STRIPE_SECRET_KEY` and having Vite dutifully inline it into every visitor's browser; the prefix convention is a safety mechanism against *accidental* exposure of non-`VITE_` shell variables, not a review gate against someone deliberately (if mistakenly) prefixing something that shouldn't be public. That's a discipline/code-review concern, not a tooling gap Vite itself could plausibly close, since the whole point of the prefix is that *some* values are meant to be public.

**Source maps.** `vite.config.ts` (§3.1, full file) contains no `build.sourcemap` key at all. Vite's own documented default for that setting is `false` — meaning AstriX's production build does **not** emit source maps unless someone explicitly opts in. This matters because a source map is a file that maps minified, bundled production JS back to original source — with one shipped alongside the production bundle, anyone could reconstruct the app's original TypeScript/JSX source, complete with original file paths, variable names, and component structure, dramatically lowering the effort required to reverse-engineer business logic, understand internal architecture, or hunt for client-side bugs to exploit. AstriX not shipping source maps by default means the deployed bundle is minified-only — still fully inspectable by a sufficiently motivated person (minification obscures, it doesn't encrypt; nothing about a minified bundle is cryptographically hidden), but meaningfully more tedious to work through than a fully source-mapped one would be. Worth being precise about what this is and isn't: it's friction, not a security boundary — the real security boundary for anything that actually matters (data access, authorization) is the backend's `authenticate`/`roleGuard` layer, exactly as [`02-routing-and-code-splitting.md`](./02-routing-and-code-splitting.md) §6 already establishes for route guards. No client-side JavaScript, minified or not, source-mapped or not, should ever be the thing standing between an attacker and something that actually matters.

**Could `dist/stats.html` leak internal architecture if accidentally deployed?** A generated `stats.html` (§3.6) is, by design, a fairly detailed map of the app's dependency structure — every module in the bundle, its size, and by extension its presence at all — which is more internal detail than most teams would want casually public, even if none of it is a "secret" in the credentials sense. Checking the actual gitignore configuration: both the repo root's `.gitignore` and `client/.gitignore` exclude `dist/` outright, so a locally-generated `stats.html` is never committed to source control. More importantly for the *deployed* bundle specifically: `deploy-frontend.yml`'s `Build` step runs `npm run build` (§4), not `npm run build:analyze` — meaning `ANALYZE` is never set during an actual CI deploy, the conditional plugin block in `vite.config.ts` never includes `visualizer`, and `stats.html` is never generated in the `dist/` folder that gets `s3 sync`'d to the world in the first place. Under the current pipeline, this protection is real but worth naming honestly as *incidental* rather than structural: nothing in `deploy-frontend.yml`'s `s3 sync dist/ ...` step explicitly excludes `stats.html` by name — the only reason it can't leak today is that the deploy workflow happens to invoke the plain `build` script rather than `build:analyze`. If a future change to that workflow (someone reasonably wanting to "check bundle size on every deploy," or a careless copy-paste from a local debugging session) swapped in `build:analyze`, `stats.html` would start shipping to production S3/CloudFront with nothing in the current pipeline catching it — a genuinely plausible, low-severity but real future misconfiguration worth flagging rather than assuming away.

---

## 7. Best Practice Check

For the core tooling choice — Vite as both dev server and production bundler for a client-rendered React SPA with no SSR requirement — AstriX is squarely on the current, actively-recommended path in 2026. This is close to an uncontroversial call to make plainly, precisely because the contrast is so stark: Create React App is the tool most engineers still associate with "starting a new React app," and it's exactly the choice the React team itself no longer recommends (§1(d)) — CRA's continued presence in tutorials and bootcamps is a lagging signal, not a live endorsement. Vite occupies the space CRA used to, for good, evidence-backed reasons (near-instant dev-server cold starts regardless of app size, a real production bundler underneath rather than a black box), and AstriX's adoption of it, plus the `tsc -b && vite build` type-check-then-bundle two-step (§3.3), reflects genuinely current practice rather than a dated-but-still-reasonable holdover.

Checking `vite.config.ts` honestly against further production-hardening options a more aggressively optimized setup might add, rather than assuming gaps exist:

- **Manual chunk-splitting beyond route-level `lazy()`.** There's no `build.rollupOptions.output.manualChunks` in AstriX's config (§3.5, §5) — meaning Rollup's default heuristics decide how shared dependencies get grouped across chunks, rather than an explicit strategy like "put React/React-DOM in their own long-lived vendor chunk, separate from app code, so it's cached independently of app-code churn." This is a real, nameable lever AstriX doesn't pull — but it's genuinely optional at AstriX's current scale, not a gap: the app's total page count (sixteen routes) and dependency footprint are modest, route-level splitting already captures the dominant win (nobody downloads `TermsOfService`'s code to view their task board), and manual vendor-chunk tuning tends to earn its complexity on apps with either a much larger shared-dependency surface or measured evidence (from exactly the `stats.html` tooling in §3.6) that Rollup's defaults are producing a specific, sub-optimal split. Nothing here suggests that evidence exists yet for AstriX.
- **`build.sourcemap`.** Left unset, which means Vite's secure-by-default behavior (no source maps shipped) is already what's in effect (§6) — this is the *correct* choice for a production build, not a missing setting to flag as a gap.
- **Build-time compression** (a plugin like `vite-plugin-compression` to pre-generate `.gz`/`.br` assets at build time). AstriX's `vite.config.ts` has no such plugin. Whether this constitutes a real gap depends on whether CloudFront and S3 are configured to compress responses on the fly based on the client's `Accept-Encoding` header — a question that sits in the infra layer this file doesn't have primary source access to (`docs/infra/` hasn't been written yet as of this file), so the honest position is to name the absence of a build-time compression plugin as a fact, without asserting it's a real deployed gap one way or the other.

Taken together, the honest verdict is that `vite.config.ts` is **minimal but sufficient** for what AstriX currently is, not a config with unaddressed gaps dressed up as fine. The one real, actionable lever left on the table — manual vendor chunking — is a "reach for this when the numbers justify it" optimization, and the tooling to get those numbers (`build:analyze`, §3.6) is already wired up and ready the moment someone wants to make that case.

---

## 8. Debug Drill

**Scenario:** A developer adds a new build-time environment variable — say `VITE_FEATURE_FLAG_URL` — for some new client-side feature. `npm run dev` picks it up immediately and works exactly as expected locally. The change gets merged, `deploy-frontend.yml` runs and reports success, but the deployed app still behaves as if the variable is unset — even after waiting, even after a second redeploy. Where do you look, and in what order?

1. **Confirm the variable actually has the `VITE_` prefix, and that the code reads it via `import.meta.env`, not `process.env`.** This is the single most common version of this bug, and it's worth ruling in or out first because it explains a "works locally, broken in prod" symptom on its own without needing any infrastructure investigation at all. Two sub-cases, both real: (a) the variable was named without the prefix (`FEATURE_FLAG_URL` instead of `VITE_FEATURE_FLAG_URL`) — per §3.4, Vite silently excludes anything not prefixed `VITE_` from `import.meta.env`, so `import.meta.env.FEATURE_FLAG_URL` would simply be `undefined`, both locally and in production, with no error thrown anywhere; if it "worked locally," check whether the developer actually named it correctly in their own local `.env` but the production wiring (SSM parameter name, or the corresponding step in `deploy-frontend.yml`) uses a different, mismatched name. (b) The code reads `process.env.VITE_FEATURE_FLAG_URL` instead of `import.meta.env.VITE_FEATURE_FLAG_URL` — client-side code has no `process` global at all in a Vite-built app (§3.4), so this would typically throw a `ReferenceError` in the browser console rather than silently reading `undefined`, but depending on bundler behavior and any polyfills present it can also just silently resolve to `undefined`. Check the actual import site against `client/src/lib/base-url.ts:1`'s pattern as the known-working reference.
2. **Confirm the value actually reaches the CI build step, not just the SSM parameter store.** Per §3.4's traced example, a new `VITE_`-prefixed variable being correctly stored in SSM does **nothing** on its own — `deploy-frontend.yml` has no generic "read every SSM parameter matching `VITE_*` and inject it" logic. Each variable is individually, explicitly wired: a dedicated `Get X from SSM` step (mirroring `.github/workflows/deploy-frontend.yml:54-58`'s `Get API URL from SSM` step) that reads one specific named parameter, followed by that step's output being explicitly listed under the `Build` step's `env:` block (mirroring lines 71-75). A new environment variable added only to SSM, with no corresponding new step and no corresponding new `env:` entry added to the workflow file itself, is invisible to the build no matter how correctly it's stored — `vite build` simply never sees it in its process environment, so there's nothing for Vite's static replacement (§3.4) to inline in the first place. Check the actual `deploy-frontend.yml` diff from the PR that "added" this variable — if the workflow file itself wasn't touched, this is almost certainly the cause.
3. **Confirm the new build actually reached S3, and that CloudFront isn't serving a stale cached copy.** If steps 1–2 check out — the variable is correctly prefixed, correctly read in code, and correctly wired through SSM into the `Build` step's environment — the remaining suspect is the delivery path traced in §4: `aws s3 sync dist/ s3://$S3_BUCKET/ --delete` followed by a CloudFront invalidation (`.github/workflows/deploy-frontend.yml:77-87`). Check the GitHub Actions run logs directly for both of those steps completing successfully, not just the workflow's overall green checkmark — a `sync` that partially failed, or an invalidation call that errored after the sync succeeded, would leave new files sitting correctly in S3 while CloudFront continues serving an old, cached `index.html` (and the old JS chunks it references) until its default TTL naturally expires on its own. This is distinguishable from the first two causes by inspecting the actual deployed asset directly — fetch the live JS file that should contain the inlined variable and check whether the *new* value is textually present in that file's contents at all. If it is present in the file but the app still doesn't behave as if it's set, the bug isn't build/deploy-related at all anymore — it's purely a CDN cache-staleness question, and the fix is confirming CloudFront's invalidation actually completed (checking response headers like `x-cache` for `Hit from cloudfront` versus a fresher response, or triggering a manual invalidation) rather than touching the build pipeline again. If the new value is genuinely absent from the deployed file's contents, the problem is upstream of CloudFront entirely, and steps 1–2 deserve a second, more careful look.

The general, transferable lesson: a "new env var doesn't take effect in production" report on a static-SPA deploy model almost always decomposes into exactly these three independent failure points — the variable never got exposed to client code at all (a Vite-side naming/API mistake), the variable never reached the build process in the first place (a CI-wiring mistake, specific to however that pipeline sources its config), or the variable reached a correctly-built artifact that simply hasn't reached the browser yet (a caching/propagation delay, not a config bug at all) — and distinguishing between them is a matter of checking each layer's actual, observable evidence (the file's literal contents, the CI logs, the response headers) rather than guessing which layer is at fault from the symptom alone.

---

**Related reading:** [`00-master-frontend-architecture.md`](./00-master-frontend-architecture.md) for the tech-stack table this file's tooling choices are drawn from; [`02-routing-and-code-splitting.md`](./02-routing-and-code-splitting.md) for the routing-logic side of the `lazy()`/`Suspense` pattern this file covers only from the build-output angle; [`../Architecture.md`](../Architecture.md) §5 for the full deploy-flow diagram this file's §3.4 and §4 trace in mechanical detail; and [`../backend/00-master-backend-architecture.md`](../backend/00-master-backend-architecture.md) for the backend's runtime, `process.env`-at-container-start configuration model this file's §3.4 contrasts directly against.
