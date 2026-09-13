# Frontend Component and Hook Testing

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Testing](./00-master-testing-strategy.md).

The [master testing file](./00-master-testing-strategy.md) already laid out the shape: AstriX's frontend has 22 test files, all Vitest running under a `jsdom` environment, no separate integration or E2E directories — everything lives as a component or hook test sitting next to the thing it tests, in a `__tests__/` folder. This file goes one level deeper: what library is actually doing the rendering and querying, why that library and not one of its well-known alternatives, what a test run mechanically does from the moment `vitest run` starts to the moment `cleanup()` fires, and what these tests can and cannot tell you about whether the app is safe to ship.

---

## 1. The Landscape

Before touching a single line of AstriX code, it's worth naming the real, competing approaches an engineer meets when testing a component-based UI, because the choice AstriX made is a choice *among* these, not the only option that exists.

**(a) Shallow rendering.** For years, Enzyme's dominant testing pattern was to render a component exactly one level deep — child components appear in the output tree as opaque placeholders (`<ChildComponent />`), never actually rendered themselves — and then assert directly against that tree or against the component's internal state and props:

```jsx
// illustrative — Enzyme-style, not AstriX code
const wrapper = shallow(<UserCard user={mockUser} />);
expect(wrapper.find("Avatar").prop("src")).toBe(mockUser.avatarUrl);
expect(wrapper.state("isExpanded")).toBe(false);
```

The appeal was isolation: a `UserCard` test couldn't fail because `Avatar` had a bug, since `Avatar` never actually rendered. The cost, in hindsight, turned out to outweigh that appeal for most teams — asserting against `wrapper.state()` or a child's props couples the test to *how* the component is implemented rather than *what* it produces, so a purely internal refactor (renaming a state variable, restructuring child composition without changing visible output) breaks tests that shouldn't have needed to know about the change. Enzyme also never gained official support for React 17/18's concurrent rendering model, and by 2026 it is widely considered a legacy choice for new React work — the React team itself now points newcomers toward React Testing Library.

**(b) React Testing Library's full-DOM, user-centric queries.** Render the *real* component tree — children included — into a real (if simulated, via `jsdom`) DOM, and query that DOM the way an actual user or a screen reader would: by role, by visible label text, by accessible name — not by internal component names, not by CSS class, not by a `data-testid` unless nothing more meaningful exists.

```jsx
// illustrative RTL pattern
render(<UserCard user={mockUser} />);
expect(screen.getByRole("img", { name: /ada's avatar/i })).toBeInTheDocument();
```

Kent C. Dodds, RTL's most visible advocate, frames the guiding principle plainly: "the more your tests resemble the way your software is used, the more confidence they can give you." The tradeoff is that RTL tests are structurally incapable of reaching into a component's internals — there is no `wrapper.state()` equivalent, by design — which is a constraint some teams find frustrating when they specifically want to unit-test an isolated piece of logic, but which is also exactly the constraint that makes an RTL test survive an implementation refactor untouched.

**(c) Snapshot testing.** Jest's `toMatchSnapshot()` (and Vitest's equivalent) renders a component once, serializes the output tree to a file, and on every subsequent run diffs the new render against that saved file — any difference fails the test until a developer explicitly re-approves the new snapshot.

```jsx
// illustrative
const { asFragment } = render(<UserCard user={mockUser} />);
expect(asFragment()).toMatchSnapshot();
```

It's cheap to write — one line, no assertions to design — which is exactly why it's notorious for what the industry calls "snapshot fatigue": a large snapshot diff shows up in a PR, a developer under time pressure skims it, sees a wall of changed markup, and runs `--updateSnapshot` without actually reading whether the change was intentional or a regression. The test technically still "passes" after that, but it has stopped doing any real verification.

**(d) Visual regression testing.** Tools like Chromatic or Percy render a component (often via Storybook) in a real browser, take an actual screenshot, and diff it pixel-by-pixel against a baseline image. This is a genuinely different tool solving a genuinely different problem than (a)–(c): DOM-structure-based tests, however written, cannot see that a CSS change broke a layout, shifted an element off-screen, or made text unreadable against its background — the DOM tree can be structurally identical while the rendered pixels are broken. Visual regression tooling catches exactly that class of bug, at the cost of needing a browser rendering pipeline, baseline image storage, and a review workflow for legitimate visual changes.

---

## 2. AstriX's Choice

AstriX uses React Testing Library exclusively across all 22 frontend test files — no Enzyme, no `toMatchSnapshot()` anywhere in the suite, no Chromatic/Percy or any other visual regression tooling — paired with `@testing-library/jest-dom` for readable DOM-state matchers (`toBeInTheDocument()`, and similar) and `@testing-library/user-event` for realistic interaction simulation, all run under Vitest configured with a `jsdom` environment. The versions pinned in `client/package.json` devDependencies are `@testing-library/react@^16.3.3`, `@testing-library/jest-dom@^6.9.1`, `@testing-library/user-event@^14.6.7`, and `vitest@^4.1.11`.

---

## 3. AstriX Implementation

### 3.1 The global test setup

Every test file in the frontend suite is preceded by this one setup file, referenced from `vite.config.ts`'s `test.setupFiles`:

```typescript
// client/src/test/setup.ts:1-9
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
```

And the `test` block in `vite.config.ts` that wires it in:

```typescript
// client/vite.config.ts:26-30
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
```

Three things worth noting up front, each revisited in §4: `environment: "jsdom"` is what makes `document`, `window`, and DOM APIs exist at all inside a Node-run test process — without it, `render()` would have nothing to mount into. `css: false` tells Vitest not to bother processing stylesheets during test runs — since RTL tests query by role/text/label rather than by visual appearance, actual computed styles are irrelevant to what these tests assert, so parsing CSS would be pure overhead. And the `afterEach` hook is global, meaning it runs after literally every single test in every file in the suite, automatically, without any individual test file having to remember to clean up after itself — see §4 for exactly what `cleanup()` and `clearAllMocks()` each do and why leaving either one out would leak state between tests.

### 3.2 A component test with RTL queries and `user-event`

`client/src/components/workspace/project/__tests__/create-project-form.test.tsx` is a full example of the pattern: real providers, a real DOM query for form controls, and simulated user interaction rather than firing a raw DOM event:

```typescript
// client/src/components/workspace/project/__tests__/create-project-form.test.tsx:1-71
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CreateProjectForm from "@/components/workspace/project/create-project-form";
import { createProjectMutationFn } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  createProjectMutationFn: vi.fn(),
}));

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom"
    );
  return { ...actual, useNavigate: () => navigateMock };
});

const renderForm = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/ws-1/projects"]}>
          <Routes>
            <Route
              path="/workspace/:workspaceId/projects"
              element={<CreateProjectForm onClose={vi.fn()} />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  };
};

// Regression test for the "allprojects"/"allProjects" query-key typo
// (PLAN.md Critical #3): the invalidation key here MUST match the shape
// use-get-projects.tsx actually queries with - ["allProjects", workspaceId]
// - or the sidebar project list silently never refreshes after a create.
describe("CreateProjectForm - project list cache invalidation", () => {
  it("invalidates the exact query key the projects list is fetched with, after a successful create", async () => {
    // #given project creation succeeds
    vi.mocked(createProjectMutationFn).mockResolvedValue({
      message: "Project created successfully",
      project: { _id: "proj-1", name: "New Project", emoji: "📊" },
    } as Awaited<ReturnType<typeof createProjectMutationFn>>);
    const { queryClient } = renderForm();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    // #when submitting the create-project form
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/project title/i), "New Project");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    // #then the projects list is invalidated with the SAME key shape
    // use-get-projects.tsx's query is registered under - a case/spelling
    // mismatch here means the sidebar list never refreshes
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["allProjects", "ws-1"] })
      )
    );
  });
});
```

A few details worth calling out precisely, because they're representative of every RTL test in the suite, not just this one. First, `screen.getByLabelText(/project title/i)` and `screen.getByRole("button", { name: /^create$/i })` are both accessibility-tree queries — the test locates elements exactly the way a screen reader or a sighted user reading the visible label would, never by a CSS selector or an internal prop. Second, `userEvent.setup()` followed by `await user.type(...)` and `await user.click(...)` is deliberately not `fireEvent.click(...)` — `user-event` simulates the realistic sequence of underlying browser events a real interaction produces (pointer, focus, and click events in the right order, with `await` because the simulated events are asynchronous), where `fireEvent` would only dispatch the single named event, skipping everything a browser actually does around it. Third, the component under test is wrapped in its *real* collaborators — `QueryClientProvider` and a `MemoryRouter`/`Routes` — rather than having them mocked away; only the true external boundaries (`@/lib/api`'s network call, and `react-router-dom`'s `useNavigate`) are mocked with `vi.mock`. That's a direct, concrete instance of the RTL philosophy from §1(b): render the real thing, mock only what actually crosses a boundary the test shouldn't pay for (a real network request).

### 3.3 A hook test with `renderHook`

`client/src/hooks/__tests__/use-permissions.test.ts` tests `usePermissions` — a hook with no JSX of its own — using RTL's `renderHook` helper rather than mounting any component:

```typescript
// client/src/hooks/__tests__/use-permissions.test.ts:1-22
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import usePermissions from "@/hooks/use-permissions";
import { Permissions, PermissionType } from "@/constant";
import { UserType, WorkspaceWithMembersType } from "@/types/api.type";

const buildUser = (overrides: Partial<UserType> = {}): UserType =>
  ({
    _id: "u1",
    name: "Ada",
    email: "ada@x.com",
    ...overrides,
  }) as UserType;
```

and the test that specifically exercises re-render behavior:

```typescript
// client/src/hooks/__tests__/use-permissions.test.ts:82-101
  it("recomputes (not stale) when the workspace argument changes, e.g. on a workspace switch", () => {
    // #given a hook initially resolved against workspace A, where the user
    // has EDIT_TASK
    const user = buildUser({ _id: "u1" });
    const workspaceA = buildWorkspace([member("u1", [Permissions.EDIT_TASK])]);
    const workspaceB = buildWorkspace([member("u1", [Permissions.VIEW_ONLY])]);

    const { result, rerender } = renderHook(
      ({ workspace }) => usePermissions(user, workspace),
      { initialProps: { workspace: workspaceA } }
    );
    expect(result.current).toEqual([Permissions.EDIT_TASK]);

    // #when the workspace argument switches to workspace B
    rerender({ workspace: workspaceB });

    // #then permissions reflect the NEW workspace's membership, not a stale
    // value held over from workspace A
    expect(result.current).toEqual([Permissions.VIEW_ONLY]);
  });
```

This file is notably `.test.ts`, not `.test.tsx` — there is no JSX anywhere in it, because `usePermissions` returns a plain array, not a rendered component. `renderHook` mounts the hook inside a minimal invisible test component RTL manages internally, exposing the hook's return value as `result.current` and giving the test a `rerender()` function to simulate the hook being called again with new arguments — here, a different `workspace` object standing in for a real workspace switch. `client/src/context/__tests__/auth-provider.test.tsx` uses the exact same `renderHook` pattern, but adds a `wrapper: AuthProvider` option so the hook under test (`useAuthContext`) is mounted inside its real Context provider rather than standalone — necessary because `useAuthContext` throws if called outside an `AuthProvider` (see `client/src/context/auth-provider.tsx`'s `useAuthContext` implementation, cited in the [frontend auth chapter](../frontend/06-authentication-and-authorization-ui.md) §3.3).

### 3.4 A structurally different test: `ErrorBoundary`'s class-component lifecycle

`client/src/components/__tests__/error-boundary.test.tsx` is worth calling out on its own, because it isn't testing hooks or user interaction at all — it's testing a React *class* component's `componentDidCatch`/`getDerivedStateFromError` error-boundary lifecycle, the one piece of the React API that still has no hook equivalent:

```typescript
// client/src/components/__tests__/error-boundary.test.tsx:1-41
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ErrorBoundary from "@/components/error-boundary";

const Bomb = () => {
  throw new Error("boom");
};

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    // #given a subtree that renders normally
    // #when it mounts inside the boundary
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>
    );

    // #then the children are shown as normal
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("shows a fallback instead of crashing when a child throws", () => {
    // #given a subtree that throws during render
    // React logs the caught error to the console by default; silence it so
    // the test output isn't noisy for an error we're deliberately causing.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // #when it mounts inside the boundary
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    // #then a fallback UI is shown instead of the app crashing
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();

    spy.mockRestore();
  });
});
```

The `Bomb` component — a fake component that unconditionally `throw`s during render — is the mechanism, not the queries or interaction. What's being verified is not "does a query find the right role" but "does React's error-boundary machinery (`getDerivedStateFromError`/`componentDidCatch` in `client/src/components/error-boundary.tsx`) actually catch a synchronous render-time exception and swap in the boundary's fallback UI instead of letting the exception propagate and crash the whole tree." The `vi.spyOn(console, "error")` is a deliberate, narrow suppression — React logs caught render errors to the console by default, and the test silences that expected noise for the one interaction it is intentionally causing, then explicitly restores the real `console.error` with `spy.mockRestore()` afterward rather than leaving it stubbed for any other test that might run in the same file. Structurally this is still an RTL test — `render()`, `screen.getByText()`, the same query philosophy as everywhere else — but the *thing being exercised* (a lifecycle method rather than user-facing markup or a hook's return value) is genuinely different from §3.2 and §3.3, which is why it's worth naming as its own pattern rather than folding it into either.

---

## 4. Request/Data Flow

Tracing what actually happens, start to finish, when one of these test files runs — using `with-permission.test.tsx` as the concrete example, since it touches providers, mocking, and RTL queries together:

1. **`jsdom` stands up a fake DOM.** Because `vite.config.ts`'s `test.environment` is `"jsdom"` (`client/vite.config.ts:27`), Vitest runs the test file inside a simulated browser environment — `document`, `window`, and DOM node classes all exist as `jsdom`'s JS implementation of them, even though the process is plain Node. Nothing in the test file has to opt into this; it's a property of the whole run.
2. **The setup file runs first, once per file.** `client/src/test/setup.ts` executes before any test in the file, importing `@testing-library/jest-dom/vitest` — this is what makes `expect(...).toBeInTheDocument()` and jest-dom's other matchers available to every assertion in the suite, globally, without each test file re-importing them.
3. **The test file's own imports pull in the component under test and its mocked collaborators.** In `with-permission.test.tsx`, that means importing `withPermission` itself, and calling `vi.mock` on `@/context/auth-provider`, `@/hooks/use-workspace-id`, and `react-router-dom` (`client/src/hoc/__tests__/with-permission.test.tsx:14-24`) — each of Vitest's hoisted mocks replaces the real module before the component's own imports resolve, so by the time `withPermission(Inner, Permissions.EDIT_TASK)` is called, `useAuthContext()` inside it returns whatever `mockAuthContext` the individual test has set, not a real `AuthProvider`. Contrast this with `auth-provider.test.tsx`, which mocks *lower*-level dependencies (`useAuth`, `useGetWorkspaceQuery`, `usePermissions`) but mounts the *real* `AuthProvider` as `renderHook`'s `wrapper` — the choice of which layer to mock and which to render for real is made per test file, based on which layer is actually under test.
4. **RTL's `render()` mounts the component into the fake DOM.** `render(<Guarded />)` (`with-permission.test.tsx:43`) takes the JSX tree, renders it exactly as React would in a browser, and attaches the resulting DOM nodes to a container `jsdom` manages — this is the one call every component test in the suite shares.
5. **The test queries the rendered output the way a user would perceive it.** `screen.getByText("Inner content")`, `screen.queryByText("Inner content")`, `screen.getByRole("button", ...)` — role, label, and visible text, never a CSS class or an internal prop. `queryBy*` (as opposed to `getBy*`) is used specifically for the negative assertions (`.not.toBeInTheDocument()`), since `queryBy*` returns `null` instead of throwing when nothing matches, which is what a "confirm this is absent" assertion needs.
6. **Where interaction is involved, `user-event` simulates the full realistic event sequence.** As shown in §3.2, `user.click(...)` doesn't fire one synthetic `click` event — it dispatches the sequence a real browser produces for a physical click (pointer-down, mouse-down, focus, pointer-up, mouse-up, click, in order), which matters because some real components (anything listening for `onMouseDown` specifically, or focus-dependent behavior) would pass a naive single-event test while being broken for an actual user.
7. **Assertions run via `@testing-library/jest-dom` matchers.** `toBeInTheDocument()`, and the rest of jest-dom's DOM-aware matcher set, made available by the setup file's import in step 2.
8. **The global `afterEach` in `setup.ts` runs, unconditionally, after every single test.** Two things happen here, and they do genuinely different jobs:
   - `cleanup()` unmounts every component RTL rendered during that test and removes the DOM nodes it created. Without this, a second test's `render()` call would mount its component *alongside* the still-attached output of the previous test's `render()`, and a query like `screen.getByText("Inner content")` could match a leftover node from a test that already finished — a real, common source of tests that only fail when run in a particular order (or, worse, that pass while asserting on the wrong element).
   - `vi.clearAllMocks()` resets every mock function's *call history* — `.mock.calls`, `.mock.instances`, the record of "was this called, how many times, with what arguments" — so that a `beforeEach`'s `navigateMock.mockClear()`-style pattern isn't needed in every file individually (`with-permission.test.tsx:30-32` in fact still calls `navigateMock.mockClear()` itself in a local `beforeEach`, which is redundant given the global hook, but harmless). This is a real, easy-to-blur distinction worth being precise about: `clearAllMocks()` resets call history but leaves any configured mock *implementation* (`mockImplementation`, `mockReturnValue`, `mockResolvedValue`) intact. `resetAllMocks()` goes further and also clears the implementation, reverting each mock to a bare no-op function. `restoreAllMocks()` goes furthest of all, and only applies to mocks created via `vi.spyOn` on a real object/method — it restores the *original*, un-mocked implementation entirely, undoing the spy. AstriX's setup deliberately uses only `clearAllMocks()`, which is why a pattern like `create-project-form.test.tsx`'s `vi.mocked(createProjectMutationFn).mockResolvedValue(...)` (a *module-level* `vi.mock`, not a `vi.spyOn`) needs its resolved value re-specified inside each `it()` block or `beforeEach` that needs it — the mock function itself survives across tests (it's declared once, at module scope, by `vi.mock`), but nothing guarantees its configured resolved value survives, because a stricter reset was never applied globally, and a looser one wouldn't clear implementations at all. In practice, every test file in the suite that relies on a specific mock return value sets that return value inside the `it()` (or a file-local `beforeEach`) that needs it, rather than depending on a value set in a previous test still being there.

---

## 5. Design Decisions & Tradeoffs

Choosing RTL's query-by-role philosophy over the two alternatives named in §1 buys AstriX two concrete things. Against snapshot testing: every assertion in the suite has to name something specific and meaningful about user-visible behavior — a role, a label, a call the test expects to have happened — rather than accepting an opaque serialized-tree diff that a reviewer can approve without reading. There is no `toMatchSnapshot()` anywhere in the 22 files, so the "developer blindly re-approves a wall of diff" failure mode described in §1(c) structurally cannot happen here. Against shallow rendering: every RTL test in the suite renders the *real* component tree, real children included — `create-project-form.test.tsx` renders inside a real `QueryClientProvider` and a real `MemoryRouter`, not stand-ins for them — which means a test can catch an integration bug between a component and its actual children (a prop name mismatch, a context value the child expects but the parent doesn't provide) that a shallow-rendered test, with children reduced to opaque placeholders, would never see.

What's given up is worth stating plainly rather than glossing over, because the [master testing file](./00-master-testing-strategy.md) and file 07's gap analysis both return to it. RTL, by construction, only inspects the DOM's *structure* and *accessible content* — it has no concept of computed style, layout, or pixel output at all (reinforced directly by `vite.config.ts`'s `css: false`, which skips CSS processing entirely during test runs). A component that renders the correct text inside the correct `role="button"` element, but whose CSS happens to position it off-screen or render it invisible against its background, passes every RTL test in this suite without complaint — that failure mode is exactly what visual regression tooling (§1(d)) exists to catch, and AstriX has none. This is a real, honestly-scoped gap, not an oversight to paper over. Separately, full-DOM rendering is measurably slower per test than shallow rendering would be — real child components, real Context providers, and (in the form test) a real `QueryClientProvider` all have to actually execute on every `render()` call, rather than being replaced by a one-line placeholder — but at AstriX's current scale of 22 frontend test files, this has not become a practical problem; it would be a different conversation at ten or a hundred times that count.

---

## 6. Security Considerations

What a component or hook test in this suite *can* verify, and does: that a permission-gated piece of UI actually behaves the way `usePermissions`/`hasPermission` says it should. `with-permission.test.tsx`'s four cases directly assert this — a user with `EDIT_TASK` sees the wrapped component and is never redirected (`client/src/hoc/__tests__/with-permission.test.tsx:34-48`), a user missing it is redirected to `/workspace/ws-1` and never sees the wrapped content (`:50-64`), a user with no session at all is blocked the same way (`:66-79`), and a still-loading auth state shows a loading indicator instead of either outcome (`:81-95`). `error-boundary.test.tsx` verifies a second, different kind of safety property: that an unhandled render-time exception anywhere in a wrapped subtree is actually caught by `ErrorBoundary`'s `componentDidCatch`/`getDerivedStateFromError` pair and swapped for the boundary's own fallback markup (`client/src/components/error-boundary.tsx:16-22, 24-37`) rather than crashing the whole React tree — and, concretely, that the fallback shown to the user is the boundary's own generic "Something went wrong" message (`error-boundary.tsx:29`), not a raw stack trace or the original thrown error's message leaking into rendered UI.

What none of these tests can verify, structurally, is server-side enforcement. Every test file read for this chapter mocks its way past any real network boundary — `with-permission.test.tsx` mocks `@/context/auth-provider` outright rather than letting a real `useAuth()` call reach a backend (`with-permission.test.tsx:14-16`), and `create-project-form.test.tsx` mocks `@/lib/api`'s `createProjectMutationFn` directly rather than letting axios make a real HTTP request (`create-project-form.test.tsx:9-11`). No test in this suite, and no test achievable with this stack, makes a genuine HTTP call to a genuine backend and checks that the server independently refuses an action the client-side check would have permitted. That is a structural property of testing at this layer, not a gap specific to any one file — a component test's whole point is to isolate the component from the network, which is precisely what makes it fast and deterministic, and precisely what makes it blind to whether the *server* agrees with the client's permission decision. This connects directly to the point the [frontend authentication and authorization chapter](../frontend/06-authentication-and-authorization-ui.md) makes explicitly and at length (see its opening paragraph and §6): none of AstriX's client-side RBAC — `hasPermission`, `PermissionsGuard`, `withPermission` — is a security boundary. It is a UX layer that keeps a legitimate user's screen coherent; the actual enforcement lives entirely on the server. A test suite built entirely at the component/hook layer, however thorough, is constitutionally unable to verify that server-side enforcement itself — that verification has to happen in the backend module's own test layers instead, not here.

---

## 7. Best Practice Check

React Testing Library as the default for React component testing is, by 2026, close to unambiguous industry consensus — the React team itself steers newcomers toward it over Enzyme, and Enzyme's own maintenance story has been in decline since it never gained official support for React 17/18's concurrent-rendering internals. AstriX's choice in §2 is squarely the mainstream one, and the complete absence of snapshot testing and shallow rendering from the suite is, if anything, a slightly *more* disciplined position than "RTL plus some snapshots for convenience," which is a common hybrid seen elsewhere.

One place AstriX's approach diverges from what's often called out as current best practice: none of these tests use Mock Service Worker (MSW) to intercept network calls at the HTTP-layer boundary. Every network-adjacent mock found across the files read for this chapter — `vi.mock("@/lib/api", ...)` in `create-project-form.test.tsx:9-11`, `vi.mock("@/hooks/api/use-auth", ...)` and `vi.mock("@/hooks/api/use-get-workspace", ...)` in `auth-provider.test.tsx:15-34`, `vi.mock("@/context/auth-provider", ...)` in `with-permission.test.tsx:14-16` — mocks at the *module* boundary: the test tells Vitest to substitute a fake implementation of an entire imported module (an API function, a hook), and the real axios/fetch call underneath it never executes at all. MSW's approach is different in kind, not just in tooling: it intercepts at the actual network layer (a service worker in the browser, or a request interceptor in Node), letting the *real* application code — the real axios instance, the real interceptors described in the frontend auth chapter's §3.1 — run untouched all the way up to the point a request would leave the process, and only fakes the server's response. That's considered closer to production behavior specifically because it exercises code paths (request construction, header attachment, error-status handling in axios's own interceptors) that a module-level mock skips over entirely by substituting the whole module. AstriX's module-mocking approach is a legitimate, faster-to-write, and still widely-used alternative — it is not a mistake — but it is a less realistic one than MSW's network-layer interception, and it means the token-attachment and refresh-retry logic in `client/src/lib/axios-client.ts` (frontend auth chapter §3.1) is never actually exercised by any of the tests in this module. File 07's gap analysis treats this in more depth; the fact itself is noted here because it's directly visible in every mocked test file this chapter examined.

---

## 8. Debug Drill

**Scenario:** A component test that passed yesterday starts failing today with:

```
TestingLibraryElementError: Unable to find an accessible element with the role "button" and name `/submit/i`
```

A teammate's PR changed the submit button's visible label from `"Submit"` to `"Save changes"` as a copy improvement; nothing else about the component changed.

**Where to look first, and why:** The failure message itself is the first place to look — RTL's `getByRole("button", { name: /submit/i })` failing to find a match means the *accessible name* of some button in the rendered output no longer matches `/submit/i`, which is exactly what changing the button's visible text would produce, since for a plain `<button>Submit</button>`-style element, the accessible name computation (the same algorithm a screen reader uses) is derived directly from the element's text content. The fix is not to loosen the query, add a `data-testid`, or reach for `queryBy*`/`getByText` as a workaround — the fix is to update the test's query to match the new, correct label: `getByRole("button", { name: /save changes/i })`.

The reason this is worth pausing on, rather than treating as an annoying test-maintenance chore, is the core claim from §1(b): "the more your tests resemble the way your software is used, the more confidence they can give you." A real user looking for the submit button after this change would also be looking for text that says "Save changes," not "Submit" — a sighted user reading the button's label, and a screen-reader user hearing its announced accessible name, would both notice the exact same change this test just caught. If this test had instead queried by a `data-testid="submit-btn"` attribute (present in the DOM but invisible to any actual user), the label change would have passed silently, and the test would have kept "passing" while asserting nothing a real user would ever perceive as consistent — an increasingly meaningless test riding along in the suite. The `getByRole`/accessible-name failure here is RTL doing exactly its job: a change a real user or screen reader would notice broke a test that exists specifically to notice user-visible changes. That's a true positive, not a brittle one, and the correct response is to update the query to the new intended label, confirm the change was in fact intentional (not, say, a translation string that broke), and move on — not to weaken the query so the test stops noticing label changes altogether.

---

## Where to go next

- **[00 — Testing Strategy Master](./00-master-testing-strategy.md)** — the full backend/frontend comparison this file's numbers are drawn from.
- **[07 — Frontend Testing Gaps and E2E Considerations](./07-frontend-testing-gaps-and-e2e-considerations.md)** — the deeper treatment of the MSW gap named in §7, plus the missing E2E/coverage-gate story.
- **[../frontend/06-authentication-and-authorization-ui.md](../frontend/06-authentication-and-authorization-ui.md)** — the full RBAC-as-UX-not-security-boundary argument referenced in §6, and the `axios-client.ts` interceptor logic referenced in §7.
- **[../frontend/01-project-structure-and-component-patterns.md](../frontend/01-project-structure-and-component-patterns.md)** — the composition patterns (HOCs, guard components) that §3.4 and §6's `withPermission`/`PermissionsGuard` tests exercise.
