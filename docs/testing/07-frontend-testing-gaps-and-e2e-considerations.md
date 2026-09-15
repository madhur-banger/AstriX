# Frontend Testing Gaps and E2E Considerations

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Testing](./00-master-testing-strategy.md).

Every other file in this module describes something that exists: a mocking convention, a coverage threshold, a helper function. This one describes an absence — deliberately, and without treating "absence" as a synonym for "mistake." AstriX's 22-file frontend test suite ([`06-frontend-component-and-hook-testing.md`](./06-frontend-component-and-hook-testing.md) covers what it actually does) has no browser-level end-to-end layer and no network-boundary mocking library. Both of those are real, common, well-understood pieces of a mature 2026 frontend testing setup, and neither is present here. This file names what's missing, shows the evidence for why it's missing rather than merely asserting it, traces exactly what a hypothetical E2E test would exercise that nothing in this codebase currently can, and gives an honest verdict on how much that matters for an app at AstriX's stage.

---

## 1. The Landscape

Two genuinely separate problems get bundled together under "frontend testing gaps," and it's worth untangling them before looking at AstriX specifically, because the tools that solve one don't solve the other.

**Problem one: does the app work when a real browser loads it and a real person clicks through it?** This is what browser-level end-to-end (E2E) testing answers, and three named tools dominate the conversation.

**(a) Playwright** (Microsoft) drives real browser engines — Chromium, Firefox, and WebKit — from a single API, with auto-waiting built in (it retries an assertion until an element is actually interactable rather than requiring the test author to hand-write `sleep`/polling logic), a trace viewer that records a full timeline of DOM snapshots, network calls, and console output for any failed run, and first-class support for parallel workers out of the box. It has become the dominant choice for new projects going into 2026 specifically because of that combination — one API surface for every major engine, and tooling (the trace viewer, the codegen recorder) built for debugging flaky failures rather than just producing pass/fail output.

```ts
// illustrative — not AstriX code
import { test, expect } from "@playwright/test";

test("user can log in and see their workspace", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("Correc@123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace\//);
  await expect(page.getByText("My Tasks")).toBeVisible();
});
```

**(b) Cypress** is the older of the two mainstream choices and remains widely deployed in production test suites. It was historically Chromium-only (its own bundled browser), though it has since broadened to support Firefox and Edge; its defining strength is developer experience — an interactive runner that shows the app and the test's command log side by side, live, as the test executes, which makes writing and debugging a new test noticeably more approachable than reading a trace file after the fact. Its architectural tradeoff is that test code runs inside the browser alongside the app (not as an external driver controlling the browser over a wire protocol, as Playwright and Puppeteer do), which gives it tight DOM access but has historically made true multi-tab and multi-origin scenarios awkward compared to Playwright's out-of-process model.

**(c) Puppeteer** is lower-level than either — a Node library for driving Chrome/Chromium over the DevTools Protocol, with no built-in test-runner assertions, retry semantics, or cross-browser story of its own. It's more accurately described as a browser-automation primitive than a full E2E framework; teams reach for it directly for scraping, PDF generation, or screenshot automation, and it's also the conceptual ancestor both Playwright and Cypress's Chromium automation are built on top of. Using it for E2E testing means pairing it with a separate test runner and assertion library yourself.

**Problem two, separate from all three above: how do you fake the network for a test that never opens a real browser** — a component or hook test running in Node (via jsdom, AstriX's own setup) that still needs to exercise code making an HTTP call. Two genuinely different answers exist here.

**(d) Mock Service Worker (MSW)** intercepts requests at the actual network layer — in a browser via a real Service Worker, in Node via low-level request interception — so the application's real `fetch`/`axios` code runs completely unmodified: it constructs a real request object, that request travels through whatever interceptors or client wrapper the app normally uses, and only the network response at the very edge is faked, based on declared request handlers.

```ts
// illustrative MSW handler — not AstriX code
import { http, HttpResponse } from "msw";

export const handlers = [
  http.get("/api/task/workspace/:id/all", () => {
    return HttpResponse.json({ message: "ok", tasks: [], pagination: {} });
  }),
];
```

**Tradeoffs.** Because the real HTTP client code runs, MSW-backed tests genuinely exercise interceptor logic, header construction, and error-branch handling exactly as it would run in production — the fidelity is close to a real network round trip. The cost is setup: handlers to define and maintain per endpoint (or a fallback/passthrough strategy for the rest), a Service Worker registration step for browser-based tests, and a layer of indirection a newcomer has to learn on top of whatever HTTP client the app already uses.

**(e) Direct module mocking** — replacing the API module's exports outright with `vi.mock('../lib/api')` (Vitest's equivalent of Jest's `jest.mock`) or similar — is what AstriX's suite actually does, confirmed below in §3. It's the simpler of the two options to write and reason about: no handler registry, no Service Worker, just a mocked function returning whatever the test wants. The tradeoff is the one that matters most for this file: the test never exercises the real HTTP client code at all. Nothing about interceptor logic, request serialization, header construction, or error normalization runs — the mocked function is invoked, and whatever it was told to return (or throw) comes straight back, skipping every line of the actual client.

---

## 2. AstriX's Choice

AstriX's frontend test suite has no browser-level E2E layer at all. There is no Playwright, no Cypress, no Puppeteer — confirmed by the complete absence of any `playwright.config.*` or `cypress.config.*` file, any `cypress/` or `e2e/` directory, and any corresponding package in `client/package.json`'s dependencies or devDependencies (§3 pastes the full file). And for network-boundary mocking, AstriX mocks the `lib/api.ts` and `lib/axios-client.ts` modules directly with `vi.mock`, rather than intercepting at the network layer with MSW — also confirmed by the complete absence of an `msw` package anywhere in `client/package.json`. The entire 22-file frontend suite is, as a direct consequence of both facts together, component/hook/unit-level only: nothing in it opens a real browser, and nothing in it sends a request that travels through a real (or realistically faked) network stack.

---

## 3. AstriX Implementation

### 3.1 `client/package.json`, in full — the primary evidence

```json
// client/package.json:1-82
{
  "name": "client",
  "private": true,
  "version": "0.0.0",
  "type": "module",
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
  "dependencies": {
    "@emoji-mart/data": "^1.2.1",
    "@emoji-mart/react": "^1.1.1",
    "@hookform/resolvers": "^3.9.1",
    "@radix-ui/react-avatar": "^1.1.2",
    "@radix-ui/react-checkbox": "^1.1.3",
    "@radix-ui/react-dialog": "^1.1.4",
    "@radix-ui/react-dropdown-menu": "^2.1.4",
    "@radix-ui/react-label": "^2.1.1",
    "@radix-ui/react-popover": "^1.1.4",
    "@radix-ui/react-scroll-area": "^1.2.2",
    "@radix-ui/react-select": "^2.1.4",
    "@radix-ui/react-separator": "^1.1.1",
    "@radix-ui/react-slot": "^1.1.1",
    "@radix-ui/react-tabs": "^1.1.2",
    "@radix-ui/react-toast": "^1.2.4",
    "@radix-ui/react-tooltip": "^1.1.6",
    "@tanstack/react-query": "^5.62.11",
    "@tanstack/react-table": "^8.20.6",
    "axios": "^1.7.9",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "cmdk": "^1.0.0",
    "date-fns": "^3.6.0",
    "emoji-mart": "^5.6.0",
    "immer": "^10.1.1",
    "lucide-react": "^0.469.0",
    "nuqs": "^2.2.3",
    "react": "^18.3.1",
    "react-day-picker": "^8.10.1",
    "react-dom": "^18.3.1",
    "react-hook-form": "^7.53.2",
    "react-router-dom": "^7.1.1",
    "tailwind-merge": "^2.6.0",
    "tailwindcss-animate": "^1.0.7",
    "zod": "^3.24.1",
    "zustand": "^4.5.7"
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.3",
    "@testing-library/user-event": "^14.6.7",
    "@types/node": "^22.10.2",
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "@vitejs/plugin-react": "^4.3.4",
    "@vitest/ui": "^4.1.11",
    "autoprefixer": "^10.4.20",
    "eslint": "^9.17.0",
    "eslint-config-prettier": "^10.1.8",
    "eslint-plugin-react-hooks": "^5.0.0",
    "eslint-plugin-react-refresh": "^0.4.16",
    "globals": "^15.14.0",
    "jsdom": "^29.1.1",
    "postcss": "^8.4.49",
    "prettier": "^3.9.6",
    "rollup-plugin-visualizer": "^6.0.11",
    "tailwindcss": "^3.4.17",
    "typescript": "~5.6.2",
    "typescript-eslint": "^8.18.2",
    "vite": "^6.0.5",
    "vitest": "^4.1.11"
  }
}
```

Read through the lens of this file specifically, the testing-related entries are `vitest`, `@vitest/ui`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, and `@testing-library/user-event` — six packages, all of them oriented around rendering components in a simulated DOM inside Node and asserting on the result. There is no `@playwright/test`, no `cypress`, no `puppeteer`, and no `msw` anywhere in either dependency list. That contrast — a real, if modest, testing toolchain present, with the entire E2E/network-mocking category simply not represented in it — is the clearest single piece of evidence for this file's whole argument.

A Glob search across `client/` for `playwright.config.*`, `cypress.config.*`, a `cypress/` or `e2e/` directory, anything under an `msw/` path, or a `mocks/handlers*` file returns nothing under `client/src` or at the `client/` root. The only hits for `msw` anywhere under `client/` are several files nested inside `client/node_modules/next/dist/compiled/@mswjs/` and `client/node_modules/next/experimental/testmode/playwright/` — internal implementation details bundled inside a transitive `next` package dependency, unrelated to AstriX's own code (AstriX is a Vite SPA, not a Next.js app, and `next` does not appear anywhere in `client/package.json`'s own `dependencies` or `devDependencies` above). Those files are Next.js's own bundled test-mode tooling for a framework this project doesn't use; they don't indicate MSW or Playwright usage by AstriX in any way, and if anything their presence purely inside `node_modules` internals — with zero corresponding entry in `package.json` and zero reference anywhere in `client/src` — reinforces rather than undermines the absence being documented here.

### 3.2 `check-frontend`, from `pr-check.yml` — no E2E step exists in this job

```yaml
# .github/workflows/pr-check.yml:57-84
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

Three steps do real work: lint, `npm run test` (which resolves to `vitest run` per the `scripts` block above), and a production build against a placeholder API URL. There is no fourth step that starts a preview server and points a browser-automation tool at it, no `npx playwright test`, no `cypress run`, no equivalent of the backend job's separate Docker-build-and-scan stage aimed at exercising the built artifact as a whole. The `Build` step here proves the app compiles and bundles successfully — it does not, and structurally cannot, prove the resulting bundle renders correctly or behaves correctly when a browser actually loads it, because nothing in this job ever loads it in a browser. Every one of the three jobs in this workflow (`secret-scan`, `check-backend`, `check-frontend`, all visible in the full file at `.github/workflows/pr-check.yml:1-84`) runs on every PR into `main`, and `check-frontend` is exactly and only these three steps — there is no separate `check-frontend-e2e` job or equivalent anywhere else in `.github/workflows/`.

### 3.3 How network calls are actually mocked today — `api.test.ts`, in full

```ts
// client/src/lib/__tests__/api.test.ts:1-28
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/axios-client", () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import API from "@/lib/axios-client";
import { deleteTaskMutationFn } from "@/lib/api";

describe("deleteTaskMutationFn", () => {
  it("requests the task-delete endpoint with a leading slash", async () => {
    // #given a workspace and task id
    const payload = { workspaceId: "ws1", taskId: "task1" };

    // #when deleting the task
    await deleteTaskMutationFn(payload);

    // #then the DELETE request URL has a leading slash, matching every
    // other endpoint in this file
    expect(API.delete).toHaveBeenCalledWith("/task/task1/workspace/ws1/delete");
  });
});
```

The `vi.mock("@/lib/axios-client", ...)` call at the top is the whole story: it replaces the shared axios instance's `default` export — every one of `get`/`post`/`put`/`delete`/`patch` — with a `vi.fn()` that resolves to `{ data: {} }` regardless of what URL or payload it's called with. `deleteTaskMutationFn` (the real function from `lib/api.ts`, genuinely imported and executed) then runs, but the one call it makes to `API.delete(...)` never reaches real axios code — it's intercepted by the mock before axios's own request pipeline, its interceptors, or any actual network stack ever gets involved. The assertion (`expect(API.delete).toHaveBeenCalledWith(...)`) checks that `deleteTaskMutationFn` constructed the right URL string, and nothing more; the request-and-response cycle that URL would trigger in production is never exercised at all.

`axios-client.test.ts` takes the same approach one layer deeper — it mocks the `axios` package itself (`vi.mock("axios", ...)`, `client/src/lib/__tests__/axios-client.test.ts:51-76`), capturing the callback functions passed to `instance.interceptors.request.use(...)` and `instance.interceptors.response.use(...)` so the test can invoke those callbacks directly as plain functions. That's a deliberate and reasonable design for testing interceptor *logic* in isolation — it lets the suite assert precisely how the 401-refresh-and-retry state machine behaves without needing a real server to 401 against — but it's still module-level mocking, not network-level interception: no `http.Server` is bound, no Service Worker is invoked, and no bytes travel over any socket, real or simulated, in either test file.

That same pattern extends into the component layer, one level further up the stack. `client/src/components/account/__tests__/sessions-card.test.tsx:12-16` mocks `@/lib/api` wholesale rather than mocking `axios-client.ts` underneath it:

```tsx
// client/src/components/account/__tests__/sessions-card.test.tsx:1-16
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import SessionsCard from "@/components/account/sessions-card";
import {
  getSessionsQueryFn,
  logoutAllMutationFn,
  revokeSessionMutationFn,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  getSessionsQueryFn: vi.fn(),
  revokeSessionMutationFn: vi.fn(),
  logoutAllMutationFn: vi.fn(),
}));
```

This is the same technique, applied at whichever seam is most convenient for the thing under test — `api.test.ts` mocks one layer down (`axios-client`) to test `api.ts`'s URL-building; `sessions-card.test.tsx` mocks `api.ts` itself to test the component's rendering logic without caring how the network call is shaped at all. Every one of these seams is a direct module replacement, never a network-layer interception. Nowhere in the 22-file suite does a request get constructed, sent, and answered by anything resembling a real or simulated network stack.

---

## 4. Request/Data Flow

It's worth tracing, concretely, what a hypothetical Playwright (or Cypress) test would exercise that the current suite structurally cannot — not as a criticism, but because the difference is easy to state abstractly and easy to underestimate concretely.

**The hypothetical E2E test.** Playwright launches a real Chromium (or Firefox/WebKit) process, navigates it to the *actual built* app — the output of `npm run build`, served the way production serves it, not source files run through a dev-mode transform — and drives it exactly the way a person would: type into the email field, click the sign-in button, wait for navigation. Every one of those interactions triggers the app's *real* code paths, none of them mocked: `loginMutationFn` (`client/src/lib/api.ts`) constructs a real request, the real request interceptor in `axios-client.ts` reads the real Zustand store and attaches whatever `Authorization` header the current in-memory state actually produces, the browser's real network stack sends a real HTTP request over the wire to whatever backend the test is pointed at (a real running instance, or at minimum a realistic local/staging one), a real response comes back, the real response interceptor's success or 401-refresh branch runs based on what that backend actually returned, and the real React Router navigates to a real new URL only if the real app decided to. From there the test could keep going — create a workspace, create a project, invite a member, assign a task — chaining together an actual multi-page user flow (e.g., sign up → verify email → create a workspace → create a project) exactly as a real session would experience it, with cookies, local component state, and route transitions all persisting the way they actually do in a browser tab.

**What the current suite exercises instead.** Every one of AstriX's 22 test files renders one component (or one hook) in isolation, inside jsdom — the environment `client/vite.config.ts:27` configures (`environment: "jsdom"`) and `client/src/test/setup.ts` initializes per test. This distinction is worth being precise about rather than hand-waving past: **jsdom is a DOM implementation in Node, not a browser.** It gives a test enough of the `document`/`window` API surface — `document.createElement`, `document.querySelector`, event dispatch, a DOM tree Testing Library's queries can walk — to render React components and assert on the resulting markup, but it does not run a real browser's rendering engine underneath any of that. Concretely, that means the following are structurally untested by anything in this suite, not just untested by coincidence:

- **Real layout and paint.** jsdom does not compute real CSS layout — no real box model, no real flexbox/grid resolution, no real `getBoundingClientRect()` values derived from an actual rendering pipeline. A component that's structurally correct in the DOM tree but visually broken (an overflow that clips content, a z-index stacking bug, text that overlaps an icon at a specific viewport width) is invisible to every current test, because nothing here ever paints a pixel.
- **A real Service Worker or real network stack.** There is no `fetch` traveling over an actual socket in any current test — confirmed directly by §3's evidence, every network-shaped call is a mocked function call instead. A hypothetical MSW-based test would still not be a full network stack (it intercepts before the wire), but a Playwright test against a real backend goes the rest of the way: real TCP, real TLS if applicable, a real response serialized and parsed exactly as production does it.
- **Real cross-page navigation via the actual router hitting the actual network.** React Router's client-side navigation is exercised in a handful of route-guard tests (`client/src/routes/__tests__/`), but always with `getCurrentUserQueryFn` and friends mocked — a route guard deciding to redirect based on a *mocked* auth-check response is a different claim than a route guard deciding to redirect based on a *real* `/user/current` round trip against a real backend, with real latency and real failure modes (a timeout, a dropped connection, a slow cold-start) in the mix.
- **Real cookie/session behavior across page loads.** jsdom's cookie jar is a simplified in-memory approximation of the real Document/Cookie Store API — it does not enforce `HttpOnly` write restrictions from script the way a real browser does, does not replicate a real browser's exact `SameSite` cross-navigation attachment rules, and critically, nothing in the current suite ever performs an actual page reload (a genuinely fresh document load, the way F5 or a new tab does it) to observe whether the refresh-token cookie AstriX's auth design depends on (per [`06-authentication-and-authorization-ui.md`](../frontend/06-authentication-and-authorization-ui.md) in the frontend module) actually survives and actually re-authenticates a real browser tab the way the design assumes it will.

None of this is a flaw in the component tests themselves — a component test answering "does `SessionsCard` render two sessions when `getSessionsQueryFn` resolves with two sessions" is a well-posed, useful, correctly-scoped question, and every file in the suite answers a question shaped like that one competently. The gap is that no test in the suite answers the different, also-useful question a browser-level E2E test is built to answer: does the actual built bundle, loaded in an actual browser, talking to an actual backend, actually work.

---

## 5. Design Decisions & Tradeoffs

There's no commit message, ADR, or code comment anywhere in this codebase explaining *why* E2E and MSW were never added — which means the honest answer has to hold two readings simultaneously rather than picking one and asserting it as fact. It reads much more like a resource/scope tradeoff than a considered rejection: a small team, building a task-management SaaS from the ground up, reasonably spends its limited testing effort on the layer that's cheapest to write and fastest to run first — and RTL component tests genuinely are cheaper on both axes than a Playwright suite, which needs a running (or realistically stubbed) backend, browser binaries in CI, and materially longer per-test wall-clock time. Twenty-two component/hook tests, each running in milliseconds inside jsdom with everything mocked, is a defensible first slice of a testing investment for a project still establishing its surface area and its contributor base. It's equally possible, and not contradicted by anything in the repository, that E2E and MSW were simply never prioritized rather than actively weighed and set aside — the honest position is that the evidence available doesn't distinguish between "deliberately deferred" and "not yet gotten to," and this file isn't going to manufacture a rationale that isn't demonstrably there.

What's not in doubt, regardless of which reading is closer to true, is the real cost of the gap as it stands today: **no test currently proves that the frontend and backend actually agree on a request/response shape end to end.** This connects directly to a separate, already-documented gap: [`docs/frontend/07-api-layer-and-http-client.md`](../frontend/07-api-layer-and-http-client.md) establishes in its own §7 that AstriX's frontend hand-maintains `types/api.type.ts` independently of the backend's `swagger-jsdoc`-generated OpenAPI spec, kept in sync by developer discipline alone rather than anything a build or CI step verifies. A browser E2E layer, or a lighter-weight contract-testing layer sitting between the two (a Pact-style consumer/provider contract test, or simply a Playwright smoke test that asserts a real response actually parses into the shape a component expects), is one of the few mechanisms that would actually catch drift between what the backend now returns and what the frontend still assumes it returns — and AstriX currently has neither. A backend field rename, today, compiles cleanly on the frontend (TypeScript is trusting a hand-written annotation, not verifying it against a live response) and would only be discovered by a user encountering broken data in production, not by any automated check in this repository.

---

## 6. Security Considerations

Two categories of behavior specifically depend on a real browser to verify at all, and neither is currently exercised by anything in this suite.

**Real cookie behavior — `httpOnly`, `SameSite`, and `Secure` flags — can only be verified against a real browser's cookie jar.** [`docs/frontend/06-authentication-and-authorization-ui.md`](../frontend/06-authentication-and-authorization-ui.md) documents AstriX's actual design in detail: the access token lives only in an in-memory Zustand store, while the refresh token lives exclusively in an `HttpOnly` cookie set by the backend, with `sameSite: "lax"` doing real, specifically-reasoned-through CSRF mitigation work (that file's §5's CSRF analysis walks through exactly which cross-site request shapes a `lax` cookie is and isn't attached to). All of that is a claim about how a *real browser's* cookie handling behaves — `HttpOnly`'s enforcement that `document.cookie` can't read the value, `SameSite=Lax`'s specific cross-navigation attachment rules, `Secure`'s requirement that the cookie only travel over HTTPS. jsdom's cookie implementation is a simplified approximation of the Document/Cookie Store API, not a byte-for-byte reimplementation of a real browser engine's cookie jar — it does not claim to replicate every nuance of Chromium's or Firefox's actual `SameSite`/`Secure` enforcement. AstriX's frontend test suite never performs a real page reload against a real backend and real cookie jar to confirm the refresh flow the `AuthProvider`/axios-refresh-interceptor logic depends on actually survives that reload the way the design assumes — `axios-client.test.ts` verifies the *interceptor's own logic* (§3.3 above) by invoking its callback directly with a hand-built `AxiosError`, which is a legitimate and useful thing to test, but it is a different claim from "this actually works end to end in a real browser tab," and nothing in the current suite makes that second, stronger claim.

**CSRF-adjacent and cross-origin behavior generally can only be meaningfully tested in a real browser context, not jsdom.** The specific CSRF reasoning [`06-authentication-and-authorization-ui.md`](../frontend/06-authentication-and-authorization-ui.md) walks through — which request shapes a `SameSite=Lax` cookie is withheld from, how a cross-origin `fetch()` from an attacker-controlled page behaves against AstriX's `withCredentials: true` axios configuration, how the backend's CORS origin allowlist interacts with credentialed cross-origin requests — describes behavior that is, by definition, implemented and enforced by the browser itself, not by anything AstriX's own JavaScript does. jsdom does not implement a full same-origin-policy/CORS enforcement model the way a real browser engine does; a test running inside it cannot meaningfully simulate "what does an actual cross-origin attacker page experience when it tries to hit this API with credentials," because the enforcement being tested lives below the layer jsdom reimplements. This isn't a gap unique to AstriX — it's a structural property of jsdom-based testing generally — but it means the CSRF and CORS reasoning in the frontend auth documentation is exactly that: sound reasoning about how browsers are specified to behave, verified by inspection and by the backend's own CORS-configuration tests (which do exercise real HTTP against a real Express app via `supertest`, per this module's file 03), but not verified end-to-end from the browser side by anything currently in `client/src/**/__tests__/`.

---

## 7. Best Practice Check

For an app of AstriX's apparent size and maturity — a task-management SaaS with real authentication, real role-based access control, and genuinely multi-page user flows (sign-up, email verification, workspace creation, project and task management, member invitation) — a mature 2026 engineering organization would typically expect **at least a small smoke-test-level Playwright suite** covering the two or three most business-critical user journeys: login (including the token-refresh path, since that's where the highest-consequence, hardest-to-unit-test logic lives), and one core CRUD flow (creating a project and a task inside it, say). This doesn't mean full E2E coverage of every screen — that's rarely practical even for teams with dedicated QA engineering, and would be a disproportionate investment for a project this size — but a handful of smoke tests that boot the real built app against a real (or realistically seeded) backend and click through the flows that would be most damaging to ship broken is a genuinely common, genuinely achievable bar. Calling its absence here a real, honest gap rather than pretending 22 component tests substitute for it is the accurate assessment, not a harsh one — this codebase's own component-test layer is competent and thorough at what it does; browser-level E2E is simply a different question that layer was never built to answer.

Separately, and more immediately actionable: **adopting MSW to intercept network calls in the existing component-test layer** is a lower-effort, higher-leverage improvement than standing up a whole new E2E framework, and it's worth naming as the more practical next step of the two. It wouldn't add a new testing tier — the tests would still run in jsdom, still be fast, still require no real backend — but it would replace `vi.mock("@/lib/axios-client", ...)` and `vi.mock("@/lib/api", ...)` with request handlers that let the *real* `axios-client.ts` interceptor logic, the *real* `api.ts` URL-building, and the *real* axios request/response pipeline run on every existing test, closing exactly the "the mock bypasses the real client code" gap named throughout this file, without touching CI infrastructure, browser binaries, or a second test runner at all.

---

## 8. Debug Drill

**Scenario.** A component test mocks `@/lib/api` directly — the same pattern as `sessions-card.test.tsx` in §3.3 — and passes cleanly in CI. Weeks later, the actual deployed app breaks in production for a specific class of user: anyone whose access token expires mid-session gets silently logged out on their very next action instead of being transparently refreshed, even though `axios-client.test.ts`'s own concurrent-401 test (§3.3, and detailed further in the frontend API-layer chapter) is green in the same CI run. Root cause, once found: the real `axios-client.ts` response interceptor's token-refresh branch has an off-by-one bug — it fails to distinguish a request whose `_retry` flag was set by a *previous, already-resolved* refresh cycle from one that's genuinely mid-refresh right now, so a legitimate second 401 on the same request path is wrongly treated as "already retried, give up" instead of triggering its own refresh attempt.

**Where do you look first?**

1. **Confirm the failure is real and reproducible outside the mock, first.** Because every component test that touches this flow mocks `@/lib/api` (or `@/lib/axios-client`) directly, none of them ever invoke the real interceptor code as part of rendering a component — so "the component test is green" carries zero evidence about the interceptor's actual behavior. The first move is to stop trusting the component-test suite's green status for this specific question and go straight to reproducing the bug by hand: open the deployed app, force an access token into an expired state (or simply wait out the real expiry window), trigger a request, and watch the network tab for what the interceptor actually does with the resulting 401.

2. **Read `axios-client.test.ts`'s coverage of this exact branch closely, then ask what it *doesn't* cover.** The existing test (§3.3, and walked through in the frontend API-layer chapter's §4) proves the single-flight refresh mechanism handles two *simultaneous* 401s correctly — one refresh call, both requests queued and retried. It does not have a test for *two 401s in sequence*, where the second one arrives after the first refresh cycle has already completed and reset `isRefreshing` to `false`. That's precisely the shape of the bug in this scenario, and its absence from the existing suite (every `it(...)` block in that file is either a single 401 or two concurrent ones) is the concrete gap, not a mystery to go hunting for blind.

3. **This is exactly the category of bug a mocked-module test structurally cannot catch, and the category a network-boundary tool would.** A component test that mocks `@/lib/api` never runs a single line of `axios-client.ts`'s interceptor code, so no amount of additional component tests written the current way would have caught this — the bug lives entirely inside the one file every mock in the suite routes around. Two different tools would have: **an MSW-backed test** that lets the real interceptor run against a sequence of scripted 401-then-200 responses, driving the actual state machine through two sequential refresh cycles instead of asserting against a mock; or **a browser-level Playwright test** that genuinely lets an access token expire mid-session against a real (or realistically time-manipulated) backend and asserts the user's next action succeeds transparently rather than bouncing them to `/sign-in`. Either is a category of test not present in this suite today (§1–§2 above), and either is exactly the kind of gap this file exists to name without pretending the 22 tests that do exist were ever trying to answer this particular question.
