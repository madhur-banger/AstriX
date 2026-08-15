# Routing & Code Splitting

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Frontend](./00-master-frontend-architecture.md).

A single-page app has no server deciding what HTML to send back for `/workspace/abc123/tasks` — the browser loads one document, and from then on every "page" the user sees is JavaScript deciding what to render for a given URL. Routing is the layer that makes that decision, and it turns out to be a much bigger design surface than it first looks: it has to answer *which component renders for this path*, *is this user even allowed to see it*, *what shared chrome (nav, sidebar, header) wraps it*, and, increasingly, *how much JavaScript does the browser have to download before any of this can happen at all*. This file covers all four, using AstriX's real route tree as the running example — and, because "a pipeline that decides what handles this request, in what order, gated by what" is a shape you've likely already met, the backend's version of the same idea (its [middleware pipeline](../backend/03-middleware-and-request-pipeline.md)) is a genuinely useful mental model to keep in the back of your head throughout.

---

## 1. The Landscape

Before looking at how AstriX does it, it's worth surveying how the industry actually solves "given a URL, what renders?" — because the four approaches below are not equally good, they're differently shaped, optimized for different constraints, and knowing all four means you can walk into an unfamiliar frontend codebase — Next.js, Remix, a legacy jQuery app, anything — and immediately recognize which one you're looking at.

### (a) Config/JSX-based routing — `react-router-dom`, Vue Router, Angular's `RouterModule`

Routes are declared explicitly, in code, as data or as JSX — a list (or tree) of `{ path, element }` pairs that some router component walks and matches against the current URL. Nothing about the mapping from URL to component is inferred from where a file lives on disk; it's whatever the array or JSX tree says it is. This is the model `react-router-dom` (what AstriX uses) has offered since its earliest versions, and it's structurally identical to how Vue Router and Angular's router work even though the syntax differs.

```tsx
// illustrative react-router-dom v6 usage — not AstriX code
import { BrowserRouter, Routes, Route } from "react-router-dom";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/users/:id" element={<UserProfile />} />
      </Routes>
    </BrowserRouter>
  );
}
```

The tradeoff is directness versus ceremony: every route is explicit, so there's no "magic" mapping to reverse-engineer, and route metadata (which layout wraps it, which guard protects it) is just another prop on the same JSX node — but every new page requires a developer to remember to *register* it somewhere, and nothing enforces that the URL structure mirrors the codebase's folder structure. A route table with 40 entries is also, unavoidably, 40 lines a human has to scan to answer "does this route exist" — there's no filesystem shortcut for that question.

### (b) File-based / filesystem routing — Next.js (`pages/`, `app/`), Remix, SvelteKit, TanStack Router's file-based mode

The route table is *inferred* from a folder structure, at build time (or dev-server-start time). A file at `pages/users/[id].tsx` (Next.js `pages` router) or `app/users/[id]/page.tsx` (Next.js App Router) or `routes/users.$id.tsx` (Remix) automatically becomes the route `/users/:id` — no separate array of `{path, element}` to keep in sync with the filesystem, because the filesystem *is* the route table. TanStack Router — notably a router in the same ecosystem AstriX's `react-router-dom` comes from — offers this as an *alternative* mode on top of its own config-based API, which is a useful signal that "file-based" and "config-based" aren't really rival frameworks so much as rival conventions that the same library can support.

```
// Next.js App Router — illustrative folder layout, not AstriX code
app/
  layout.tsx          → wraps everything below it
  page.tsx             → route: /
  users/
    [id]/
      page.tsx          → route: /users/:id
```

The win is real: adding a page is "add a file in the right place," and the URL structure and the folder structure never drift apart because they're the same thing. Nested layouts, in particular, fall out almost for free — a `layout.tsx` at any folder depth automatically wraps every route below it, no manual JSX nesting required. The cost is that the mapping from URL to file is convention, not code you can `Cmd+click` through in the same direct way — you have to know the framework's naming rules (`[id]` for a dynamic segment, `(group)` for a non-URL-affecting grouping folder, `_layout` or `+page` variants depending on framework) to read the route table out of a `find` listing, and route-level concerns like "which routes need auth" often end up expressed as a *convention* too (a `(protected)` route group, a `loader` that redirects) rather than one array a reviewer can scan top to bottom in one file.

### (c) Hash-based routing — the `#/path` convention

Before the HTML5 History API (`pushState`/`popstate`) was reliably supported everywhere, SPAs used the URL *fragment* (`example.com/#/users/42`) to represent client-side route state, because changing `location.hash` doesn't trigger a full page navigation or a server request — the browser treats it as an in-page anchor jump, and a `hashchange` event fires that the app's own JS listens for.

```js
// illustrative hash-router — not AstriX code
window.addEventListener("hashchange", () => {
  const path = window.location.hash.slice(1); // "#/users/42" -> "/users/42"
  render(matchRoute(path));
});
```

Hash routing's defining property is still relevant today, just for a narrower reason: because the fragment never leaves the browser (it's not even sent as part of the HTTP request), a hash-routed SPA works correctly on **any** static host with zero server-side configuration — no rewrite rule needed to send every path back to `index.html`. That's precisely the problem AstriX's own CloudFront setup exists to solve for "clean" URLs (`docs/Architecture.md` §2 notes a CloudFront Function that rewrites extension-less paths to `/index.html`); a hash-routed app would never have needed that piece of infrastructure at all. The cost is uglier URLs (`/#/workspace/abc`), no meaningful server-side rendering or crawlability without extra work (a search engine, or a server generating link previews, sees only `/` — everything after `#` is invisible to it), and it reads as dated outside of narrow "must work on GitHub Pages with no config" use cases. `react-router-dom` still ships a `HashRouter` for exactly this niche, which is a useful thing to know exists even though AstriX uses `BrowserRouter`.

### (d) Index/single-route SPA — no router library, manual view-switching

The simplest option: there's no router at all. One entry component holds a piece of state — `const [view, setView] = useState("home")` — and renders different JSX conditionally based on that state's value. The browser's actual URL bar never changes; navigating is purely an in-memory state transition.

```tsx
// illustrative view-switching, no router — not AstriX code
function App() {
  const [view, setView] = useState<"home" | "settings">("home");
  return view === "home" ? <Home onNavigate={() => setView("settings")} /> : <Settings />;
}
```

This is a completely reasonable choice for a genuinely single-screen tool — a widget, an embedded dashboard, an internal admin panel with one real "page" and some tabs — where the overhead of a router (bundle size, the concept count for a new contributor) buys nothing. It falls apart the moment the app needs any of the things a URL naturally gives you for free: a link a user can bookmark or share that lands them back on the exact same screen, working browser back/forward buttons, or server-side awareness of "what page is this" (for analytics, for SSR, for a load balancer's access logs). AstriX unambiguously needs all three — a shared link to a specific task, a bookmark to a specific workspace — so this approach was never in the running for anything past its very earliest prototype stage, but it's worth naming because it's a legitimate answer to a smaller problem, not just "what beginners do before they learn better."

---

## 2. AstriX's Choice

AstriX uses **config-based routing** via `react-router-dom` v7's classic `<Routes>`/`<Route>` JSX API (not its newer data-router APIs — see §7) — three plain arrays of `{ path, element }` objects, each array representing one "zone" of the app, composed into a single `<Routes>` tree at `client/src/routes/index.tsx`. Two guard components (`ProtectedRoute`, `AuthRoute`) each wrap one of those zones so a single component gates an entire route subtree rather than every page re-checking authentication itself, two layout components (`BaseLayout`, `AppLayout`) provide the chrome each zone shares, and every page component is `lazy()`-imported so its JS ships as its own chunk, fetched only when a user actually navigates there.

---

## 3. AstriX Implementation

### 3.1 Route path constants

Every literal path string in the app is defined exactly once, here — nothing downstream hardcodes `"/sign-in"` as a string literal a second time:

```ts
// client/src/routes/common/routePaths.ts:1-28
export const isAuthRoute = (pathname: string): boolean => {
  return Object.values(AUTH_ROUTES).includes(pathname);
};

export const AUTH_ROUTES = {
  SIGN_IN: "/sign-in",
  SIGN_UP: "/sign-up",
  FORGOT_PASSWORD: "/forgot-password",
  RESET_PASSWORD: "/reset-password",
};

export const PROTECTED_ROUTES = {
  WORKSPACE: "/workspace/:workspaceId",
  TASKS: "/workspace/:workspaceId/tasks",
  MEMBERS: "/workspace/:workspaceId/members",
  SETTINGS: "/workspace/:workspaceId/settings",
  PROJECT_DETAILS: "/workspace/:workspaceId/project/:projectId",
  ACCOUNT_SETTINGS: "/workspace/:workspaceId/account/settings",
};

export const BASE_ROUTE = {
  INVITE_URL: "/invite/workspace/:inviteCode/join",
  HOME: "/",
  UNAUTHORIZED: "/unauthorized",
  VERIFY_EMAIL: "/verify-email",
  TERMS: "/terms",
  PRIVACY: "/privacy",
};
```

Three plain objects, one per zone, plus one small helper (`isAuthRoute`) that the `AuthRoute` guard uses below. Nothing here is a component or JSX — this file's only job is naming URL shapes, including the `:workspaceId` / `:projectId` / `:inviteCode` dynamic-segment syntax `react-router-dom` matches against the live URL.

### 3.2 Route-to-component tables, with `lazy()`

```tsx
// client/src/routes/common/routes.tsx:1-45
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

export const authenticationRoutePaths = [
  { path: AUTH_ROUTES.SIGN_IN, element: <SignIn /> },
  { path: AUTH_ROUTES.SIGN_UP, element: <SignUp /> },
  { path: AUTH_ROUTES.FORGOT_PASSWORD, element: <ForgotPassword /> },
  { path: AUTH_ROUTES.RESET_PASSWORD, element: <ResetPassword /> },
];

export const protectedRoutePaths = [
  { path: PROTECTED_ROUTES.WORKSPACE, element: <WorkspaceDashboard /> },
  { path: PROTECTED_ROUTES.TASKS, element: <Tasks /> },
  { path: PROTECTED_ROUTES.MEMBERS, element: <Members /> },
  { path: PROTECTED_ROUTES.SETTINGS, element: <Settings /> },
  { path: PROTECTED_ROUTES.PROJECT_DETAILS, element: <ProjectDetails /> },
  { path: PROTECTED_ROUTES.ACCOUNT_SETTINGS, element: <AccountSettings /> },
];

export const baseRoutePaths = [
  { path: BASE_ROUTE.HOME, element: <LandingPage /> },
  { path: BASE_ROUTE.INVITE_URL, element: <InviteUser /> },
  { path: BASE_ROUTE.UNAUTHORIZED, element: <Unauthorized /> },
  { path: BASE_ROUTE.VERIFY_EMAIL, element: <VerifyEmail /> },
  { path: BASE_ROUTE.TERMS, element: <TermsOfService /> },
  { path: BASE_ROUTE.PRIVACY, element: <PrivacyPolicy /> },
];
```

Every one of the sixteen page components is imported via `lazy(() => import(...))` rather than a normal top-of-file `import` — that's the entire code-splitting mechanism, covered in full in §3.5 below. Note also what's *not* here: no guard logic, no layout — this file's only job is "path string maps to which component," mirroring `routePaths.ts`'s "path string maps to which literal" job one layer down.

### 3.3 The route tree itself

```tsx
// client/src/routes/index.tsx:1-63
import { Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import ProtectedRoute from "./protected.route";
import AuthRoute from "./auth.route";
import {
  authenticationRoutePaths,
  baseRoutePaths,
  protectedRoutePaths,
} from "./common/routes";
import AppLayout from "@/layout/app.layout";
import BaseLayout from "@/layout/base.layout";
import NotFound from "@/page/errors/NotFound";
import { DashboardSkeleton } from "@/components/skeleton-loaders/dashboard-skeleton";

function AppRoutes() {
  return (
    <BrowserRouter>
      <Suspense fallback={<DashboardSkeleton />}>
        <Routes>
          <Route element={<BaseLayout />}>
            {baseRoutePaths.map((route) => (
              <Route
                key={route.path}
                path={route.path}
                element={route.element}
              />
            ))}
          </Route>

          <Route path="/" element={<AuthRoute />}>
            <Route element={<BaseLayout />}>
              {authenticationRoutePaths.map((route) => (
                <Route
                  key={route.path}
                  path={route.path}
                  element={route.element}
                />
              ))}
            </Route>
          </Route>

          {/* Protected Route */}
          <Route path="/" element={<ProtectedRoute />}>
            <Route element={<AppLayout />}>
              {protectedRoutePaths.map((route) => (
                <Route
                  key={route.path}
                  path={route.path}
                  element={route.element}
                />
              ))}
            </Route>
          </Route>
          {/* Catch-all for undefined routes */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default AppRoutes;
```

This is the file every other snippet in this chapter ultimately plugs into. Three top-level `<Route>` blocks, each wrapping one zone's array from `routes.tsx` — plus a catch-all `path="*"` last, which is what `<Routes>` falls through to when nothing above it matched (`react-router-dom` tries routes in the order they're written and stops at the first match, so `*` has to be last or it would swallow everything).

### 3.4 The two guards, side by side

`ProtectedRoute` and `AuthRoute` look almost identical at a glance — both call `useAuth()`, both render `<Outlet />` or redirect — but they guard in **opposite directions**, and conflating them is an easy mistake to make when skimming instead of reading closely.

```tsx
// client/src/routes/protected.route.tsx:1-15
import { DashboardSkeleton } from "@/components/skeleton-loaders/dashboard-skeleton";
import useAuth from "@/hooks/api/use-auth";
import { Navigate, Outlet } from "react-router-dom";
const ProtectedRoute = () => {
  const { data: authData, isLoading } = useAuth();
  const user = authData?.user;

  if (isLoading) {
    return <DashboardSkeleton />;
  }
  return user ? <Outlet /> : <Navigate to={"/sign-in"} replace />;
};

export default ProtectedRoute;
```

```tsx
// client/src/routes/auth.route.tsx:1-21
import useAuth from "@/hooks/api/use-auth";
import { Outlet, useLocation, Navigate } from "react-router-dom";
import { isAuthRoute } from "./common/routePaths";
import { DashboardSkeleton } from "@/components/skeleton-loaders/dashboard-skeleton";

const AuthRoute = () => {
  const location = useLocation();
  const { data: authData, isLoading } = useAuth();
  const user = authData?.user;

  const _isAuthRoute = isAuthRoute(location.pathname);

  if (isLoading && !_isAuthRoute) return <DashboardSkeleton />;

  if (!user) return <Outlet />;

  return <Navigate to={`workspace/${user.currentWorkspace?._id}`} replace />;
};

export default AuthRoute;
```

**`ProtectedRoute` keeps unauthenticated users OUT of the app.** It guards `/workspace/*` and everything else behind `AppLayout` — the actual product. No `user` means `<Navigate to="/sign-in" />`; a real `user` means render whatever child route matched, via `<Outlet />`. This is the guard almost every tutorial shows, because it's the intuitive direction: "you must be logged in to see this."

**`AuthRoute` keeps *already-authenticated* users OUT of the sign-in/up pages.** It guards `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password` — pages that only make sense for someone who *isn't* logged in yet. Its logic is the mirror image of `ProtectedRoute`'s: `!user` renders `<Outlet />` (show the sign-in form), and a real `user` triggers `<Navigate to={workspace/${user.currentWorkspace?._id}} />` — redirecting a user who's already authenticated straight into their workspace, so a logged-in user who manually types `/sign-in` into the address bar (or clicks a stale bookmark, or hits back after logging in) never sees a sign-in form they have no use for. Without this guard, nothing would stop an authenticated session from re-rendering the login page over the user's actual workspace.

The two components also diverge in one more subtle way, worth reading twice: `ProtectedRoute` shows the `DashboardSkeleton` fallback for *every* `isLoading` state, full stop. `AuthRoute` only shows it when `isLoading && !_isAuthRoute` — meaning on an actual `/sign-in`-shaped URL, it skips the skeleton and renders the `<Outlet />` (the sign-in form) immediately, even while the `useAuth()` query is still in flight. That's deliberate, not an oversight: the `auth.route.test.tsx` suite (§4 below) has a test asserting exactly this, with a comment calling out that it "avoids a skeleton flash on every visit to sign-in/sign-up" — a user landing on `/sign-in` almost certainly isn't logged in yet (why else would they be there), so paying a loading-skeleton flash while `useAuth()` confirms what's already the overwhelmingly likely case is a UX cost with no real benefit. `ProtectedRoute` doesn't get to make that same optimization, because the corresponding assumption ("this visitor is probably logged in") isn't nearly as safe to make for an arbitrary protected URL.

### 3.5 Layouts

Each zone's `<Route>` wraps its pages in exactly one layout, which supplies the chrome (or lack of it) that zone shares. `BaseLayout` is intentionally thin:

```tsx
// client/src/layout/base.layout.tsx:1-23
import { Outlet, useLocation } from "react-router-dom";
import ErrorBoundary from "@/components/error-boundary";

const BaseLayout = () => {
  const { pathname } = useLocation();

  return (
    <div className="flex flex-col w-full h-auto">
      <div className="w-full h-full flex items-center justify-center">
        <div className="w-full mx-auto h-auto ">
          {/* Keyed by route so a crash on one page doesn't stay
              tripped after navigating away from it. */}
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
};

export default BaseLayout;
```

`AppLayout` is where the actual product chrome — sidebar, header, workspace-scoped context — lives:

```tsx
// client/src/layout/app.layout.tsx:1-41
import { Outlet, useLocation } from "react-router-dom";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AuthProvider } from "@/context/auth-provider";
import Asidebar from "@/components/asidebar/asidebar";
import Header from "@/components/header";
import CreateWorkspaceDialog from "@/components/workspace/create-workspace-dialog";
import CreateProjectDialog from "@/components/workspace/project/create-project-dialog";
import EmailVerificationBanner from "@/components/account/email-verification-banner";
import ErrorBoundary from "@/components/error-boundary";

const AppLayout = () => {
  const { pathname } = useLocation();

  return (
    <AuthProvider>
      <SidebarProvider>
        <Asidebar />
        <SidebarInset className="overflow-x-hidden">
          <div className="w-full">
            <>
              <Header />
              <EmailVerificationBanner />
              <div className="px-3 lg:px-20 py-3">
                {/* Keyed by route so a crash on one page doesn't stay
                    tripped after navigating away from it. */}
                <ErrorBoundary key={pathname}>
                  <Outlet />
                </ErrorBoundary>
              </div>
            </>
            <CreateWorkspaceDialog />
            <CreateProjectDialog />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </AuthProvider>
  );
};

export default AppLayout;
```

`AppLayout` is also where `AuthProvider` — the workspace-scoped `hasPermission()` context covered in [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md) — first gets mounted. That placement matters: `AuthProvider` only wraps content that `ProtectedRoute` has already let through, so it can safely assume "there is a logged-in user" without re-deriving that fact itself, and public/auth-zone pages never pay for its setup.

### 3.6 Turning a route param into app-wide state

`PROTECTED_ROUTES.WORKSPACE` is `"/workspace/:workspaceId"` — `react-router-dom` parses the live URL segment into a route param, and any component rendered under that route (which, given the tree in §3.3, is every protected page) can read it back out with `useParams()`. AstriX wraps that one-liner in a dedicated hook rather than calling `useParams()` directly all over the app:

```ts
// client/src/hooks/use-workspace-id.ts:1-8
import { useParams } from "react-router-dom";

const useWorkspaceId = () => {
  const params = useParams();
  return params.workspaceId as string;
};

export default useWorkspaceId;
```

This is a small thing, but it's a pattern worth naming on its own: **the URL is a source of truth for state**, not just a way to pick a component. There's no Zustand slice or Context value holding "which workspace is currently active" — that value already lives in the URL (`/workspace/abc123/tasks`), and `useWorkspaceId()` is just a typed accessor onto it, called from wherever a component needs to scope a React Query call or a permission check to the current workspace. The `as string` cast is worth being honest about: `useParams()` types every param as `string | undefined` because React Router can't statically know a given route actually has a `:workspaceId` segment (that's determined by which `<Route>` a component happens to be rendered under, which TypeScript doesn't track), so the hook's author is asserting "any component calling this is guaranteed to be under `PROTECTED_ROUTES.WORKSPACE` or a descendant of it" — true by construction given the route tree in §3.3, but not something the type system verifies for a new caller.

---

## 4. Request/Data Flow

**Case 1 — an anonymous visitor requests `/workspace/abc123`.** `BrowserRouter` matches this against the tree in `index.tsx`: it's not a `baseRoutePaths` entry, so the first `<Route element={<BaseLayout />}>` block's children don't match; it's not an `authenticationRoutePaths` entry either. It *does* match `PROTECTED_ROUTES.WORKSPACE` under the third block, so React Router renders `<Route path="/" element={<ProtectedRoute />}>` first. `ProtectedRoute` mounts, and its `useAuth()` call fires a React Query request for `GET /user/current` (`hooks/api/use-auth.tsx:5-12`) — but `staleTime: 0` on that hook means this query is *always* considered stale on mount, so it always refetches rather than trusting a cached answer, even if `authUser` was fetched moments ago elsewhere in the app. While that request is in flight, `isLoading` is `true`, so `ProtectedRoute` renders `<DashboardSkeleton />` — the same generic fallback `<Suspense>` shows for a slow lazy chunk (§3.5, §6). The request resolves with no user (this is an anonymous visitor), `isLoading` becomes `false`, `user` is `undefined`, and `ProtectedRoute` renders `<Navigate to="/sign-in" replace />`. `replace` matters here: it swaps the current history entry rather than pushing a new one, so hitting the browser's back button after being redirected doesn't bounce the user right back to the protected URL they were just turned away from.

**Case 2 — an authenticated visitor requests `/sign-in`.** Say a user is logged in, then manually navigates to `/sign-in` (a stale bookmark, a link from an old email). This path matches an `authenticationRoutePaths` entry, so `<AuthRoute />` mounts. Since `location.pathname` is `/sign-in`, `isAuthRoute(location.pathname)` is `true` (`routePaths.ts:1-3`), so even while `useAuth()`'s request is still in flight, `AuthRoute` skips the skeleton and renders `<Outlet />` — briefly showing the sign-in form. Once `useAuth()` resolves with a real `user`, `AuthRoute` re-renders: `!user` is now `false`, so it falls through to `<Navigate to={\`workspace/${user.currentWorkspace?._id}\`} replace />`, and the sign-in form is replaced by a redirect into the user's actual workspace. This is the exact scenario `auth.route.test.tsx` exercises — its second test (`client/src/routes/__tests__/auth.route.test.tsx:42-57`) asserts the redirect lands on the *id*, not the workspace object (calling out, in its own comment, a real category of bug: forgetting the `._id` accessor would produce a URL literally containing the string `"[object Object]"`), and its third test (`:59-69`) asserts no skeleton flash happens on the way there.

**Case 3 — a logged-in user navigates from `/workspace/abc123` to `/workspace/abc123/tasks`.** Both routes are already inside the `ProtectedRoute` → `AppLayout` subtree, so neither the guard nor the layout re-mounts — React Router only swaps the matched leaf route's `element`, from `<WorkspaceDashboard />` to `<Tasks />`. `Tasks` is `lazy()`-imported (`routes.tsx:12`), so if its chunk hasn't been fetched yet (first visit to this route this session), the `<Suspense>` boundary wrapping the *entire* `<Routes>` tree in `index.tsx:18` catches the pending import and renders `<DashboardSkeleton />` again — the identical fallback used for the auth-loading cases above, because there's only one `<Suspense>` boundary for the whole app (§3.5, discussed further in §5 and §6). Once the chunk resolves, `Tasks` renders in place, `AppLayout`'s `<ErrorBoundary key={pathname}>` re-keys itself off the new `pathname`, and the sidebar/header from `AppLayout` never unmount or flash — only the routed content underneath them changes.

**Case 4 — a URL matches nothing.** `/workspace/abc123/nonexistent-page` doesn't match any entry in `baseRoutePaths`, `authenticationRoutePaths`, or `protectedRoutePaths`. React Router falls through every `<Route>` in the tree — including, notably, the guarded ones, since a guard's own path (`path="/"` for both `ProtectedRoute` and `AuthRoute`) only matches as a *parent* for its nested children, not for an arbitrary unmatched sub-path — and lands on the final `<Route path="*" element={<NotFound />} />`. Neither guard runs at all for this case; an unmatched URL never triggers an authentication check.

---

## 5. Design Decisions & Tradeoffs

**Why config-based over file-based.** AstriX's route count is modest (three zones, sixteen leaf routes total) and, more importantly, the thing that makes each zone distinct isn't really the URL shape — it's the *guard and layout combination*. A file-based router optimizes hardest for "adding a page is trivial" and "the URL structure is self-evident from the folder tree," but AstriX's actual complexity lives in "this group of routes needs `ProtectedRoute` and `AppLayout`, this other group needs `AuthRoute` and `BaseLayout`, and this third group needs neither guard." Expressing that as three explicit arrays, each visibly wrapped in its guard/layout `<Route>` in one file (§3.3), keeps the *access-control shape* of the app readable in a single screenful — exactly the property the file-based approaches trade away in exchange for effortless page-adding. At AstriX's scale, "can a reviewer see the entire security-relevant route topology in one file" wins over "is adding a page one file-system operation instead of two."

**Why one shared `AuthRoute`/`ProtectedRoute` pair instead of a check in every page.** The alternative to gating a whole subtree is gating each page individually — every lazy-loaded page component starting with its own `if (!user) return <Navigate ... />`. That would work, but it means the authentication check is duplicated sixteen times, with sixteen chances for one page to forget it (a real, easy-to-introduce security bug — see §6). Wrapping an entire zone in one `<Route path="/" element={<ProtectedRoute />}>` and nesting every protected page underneath it means the check exists in exactly one place, and a new page added to `protectedRoutePaths` in `routes.tsx` is protected automatically by virtue of *where* it's registered, not by remembering to add a check inside the new page's own component.

**Why route params instead of a store for "current workspace."** `useWorkspaceId()` (§3.6) leans on the URL itself as the source of truth for which workspace is active, rather than syncing that value into Zustand or Context on navigation. This avoids an entire class of bug where the URL and some parallel piece of state disagree (the URL says `/workspace/abc123` but a stale store value still says `xyz789` because some effect didn't fire) — there's only one place that value lives, so it can't drift from itself. The tradeoff is that any code that needs the current workspace id *must* be rendered under the routed tree (a component can't call `useWorkspaceId()` from outside a `<Route>`'s subtree, since `useParams()` only sees params from routes that are actually currently matched) — which is a real constraint, but one that happens to line up naturally with how the app is actually organized: nothing outside `AppLayout`'s protected subtree has a legitimate reason to know which workspace is active anyway.

**Why one `<Suspense>` boundary instead of many.** This is discussed in depth in §6, but the short version as a tradeoff: a single top-level boundary is far less code (one `fallback` to write and maintain, not one per route) and guarantees a consistent loading experience across the whole app. What it gives up is per-route loading precision — see §6 for the concrete UX cost.

---

## 6. Security Considerations

**Route guards are a client-side UX affordance, not a security boundary.** This is the single most important thing to understand about `ProtectedRoute` and `AuthRoute`: they are ordinary React components, running entirely inside JavaScript the browser downloaded and that a sufficiently motivated user fully controls. Nothing stops someone from opening devtools, finding the bundled `ProtectedRoute` logic, and monkey-patching around it — or, far more simply, just crafting an HTTP request to the API directly with `curl` or Postman, skipping the rendered UI (and therefore the guard) entirely. `ProtectedRoute`'s job is to make the *normal, well-behaved* path through the app feel correct — don't show a workspace UI to someone who isn't logged in, don't show a sign-in form to someone who already is — not to enforce that data actually stays private. The only thing that does that enforcement is the backend: every protected router in `backend/src/index.ts` is mounted behind `authenticate` (`app.use(\`${BASE_PATH}/workspace\`, authenticate, workspaceRoutes)`, and identically for `/user`, `/project`, `/task`, `/member` — see [`docs/backend/02-authentication-and-authorization.md`](../backend/02-authentication-and-authorization.md) for the full middleware, which round-trips to Mongo to confirm the JWT's session hasn't been revoked, not just that its signature is valid), and `roleGuard`'s per-workspace-role checks reject any *authenticated but unauthorized* action at the controller level. If a route guard were somehow bypassed client-side, every API call the resulting page tried to make would still hit `authenticate` (or, for an authenticated-but-wrong-role user, `roleGuard`) and get rejected server-side — the frontend guard being bypassed changes what renders, not what data is actually reachable. Treat every route guard in this file as "keeps honest users from ending up somewhere confusing," never as "keeps dishonest users out of anything."

**The loading-state window is a real, if narrow, flash-of-wrong-content risk.** Look again at `ProtectedRoute`: while `isLoading` is `true`, it renders `<DashboardSkeleton />` — not the protected content, and not a redirect. That's the correct behavior precisely *because* `isLoading` is checked first: a naive implementation that checked `user` before confirming the query had resolved (e.g., treating "not yet known" the same as "definitely no user") could either flash a premature redirect for a legitimate logged-in user (annoying, not dangerous) or, worse, briefly render the protected `<Outlet />` before an in-flight auth check comes back negative (a real, if very short-lived, flash-of-protected-content problem). AstriX's actual code doesn't have that bug — `isLoading` is checked before `user` in both guards — but it's exactly the kind of one-line reordering that would reintroduce it, and it's worth stating plainly: whatever renders during that loading window is, for a fraction of a second, rendered without a confirmed answer to "is this user allowed to be here," so it should never be the real protected content, only ever a neutral loading state. `staleTime: 0` on `useAuth()` (`hooks/api/use-auth.tsx:8`) means this loading window is paid on effectively every mount of a guard component, not just once per session — a deliberate freshness-over-speed tradeoff, since a stale "yes, still logged in" answer is exactly the kind of thing you don't want to cache past a token revocation.

**Lazy-loaded JS chunks are not a secrecy boundary either.** Every `lazy()`-imported page in `routes.tsx` — including, notably, the protected ones like `Tasks` or `Settings` — compiles to a separate static JS file that Vite/Rollup emits at build time and CloudFront serves from the same public S3 bucket as every other asset (`docs/Architecture.md` §2). Nothing about that file's URL or its retrievability is gated by whether the requester is authenticated; CloudFront doesn't know or care who's asking, it's a static file host. An unauthenticated visitor who knows (or guesses, or finds via the network tab of someone else's session) the chunk URL for the `Tasks` page can download and inspect that JavaScript freely — same as they always could with the app's main bundle. This is completely normal for a client-side-rendered SPA, worth stating rather than silently assuming: the *code* that renders a page is never secret, only the *data* it fetches and displays is (or should be) protected, and that protection is the backend's job as described above, not something route-level code splitting adds or removes.

---

## 7. Best Practice Check

For the routing *shape* itself — config-based, declarative `<Route>` trees with route-level guard and layout composition — AstriX is squarely aligned with how `react-router-dom` has been used since v6 (2021) forward, and this pattern (a plain array of route descriptors, mapped into JSX) remains extremely common in production React apps in 2026, especially for apps that, like AstriX, don't need server-side rendering.

Where there's a real, worth-naming gap is `react-router-dom` v7's newer **data-router APIs** — `createBrowserRouter()` plus route-level `loader`/`action` functions — which AstriX doesn't use anywhere, despite the dependency being on v7 (`client/package.json`, `^7.1.1`; also noted in `docs/Architecture.md`'s tech-stack table). The data-router model lets a route declare *what data it needs* (a `loader`) and *how it mutates data* (an `action`) as part of the route definition itself, and the router itself handles fetching that data before the route renders, deduplicating parallel requests, and (as of v7's shared API surface with the Remix runtime it absorbed) supporting pending-navigation UI without a component needing to manage its own loading state by hand. AstriX instead fetches all of its server state through React Query hooks called from inside page components (`hooks/api/*`, covered in [`04-server-state-and-data-fetching.md`](./04-server-state-and-data-fetching.md)) — which is itself a perfectly current, widely-used pattern, just a *different* one than what `loader`/`action` was designed to replace. This isn't a case of AstriX being behind: React Query's caching and invalidation model is arguably a closer fit for an app with as much cross-page shared server state (workspaces, projects, tasks referenced from multiple routes) as AstriX has, and mixing React Query with router-level loaders is a well-documented source of "two different systems both think they own this cache entry" friction that plenty of real v7 codebases deliberately avoid by picking one, as AstriX has. Fair framing: staying on the simpler `<Routes>`/`<Route>` JSX API while the same library ships a more capable alternative is a legitimate, currently-reasonable choice given AstriX's existing React-Query-centric data layer — not a dated leftover from an earlier version, since AstriX is already running the version that offers the newer API and chose not to adopt it for a coherent reason, not out of not knowing it exists.

One smaller, genuinely dated-leaning detail: the auth-zone redirect target in `AuthRoute` is built as a plain template string, `` `workspace/${user.currentWorkspace?._id}` `` (`auth.route.tsx:17`), rather than composed from the `PROTECTED_ROUTES.WORKSPACE` constant already defined in `routePaths.ts`. It works today because the two happen to agree, but it's the one spot in this file's code where a path is *not* sourced from the single constants module `routePaths.ts` establishes as the source of truth for every other route string in the app (§3.1) — worth a mental flag next time `PROTECTED_ROUTES.WORKSPACE` changes shape, since nothing would force this line to be updated in step.

---

## 8. Debug Drill

**Scenario:** A newly added protected page — say a new `/workspace/:workspaceId/reports` route — works fine for the engineer who built it, but a subset of users report either a 404 (`NotFound` renders) or an infinite redirect loop bouncing between the new page and `/sign-in`. Where do you look, and in what order?

1. **Check `routePaths.ts` against `routes.tsx` for a literal string mismatch first.** These two files are hand-kept in sync — `routePaths.ts` defines the path string, `routes.tsx` imports the same constant and pairs it with a `lazy()`-imported component. A typo in either place (`/workspace/:workspaceId/report` in one file, `/workspace/:workspaceId/reports` in the other — singular versus plural is exactly the kind of thing that slips past a quick read) means the route never actually registers under the path users are navigating to, so it falls through every `<Route>` in `index.tsx` and lands on the `path="*"` catch-all — a 404 that has nothing to do with authentication at all, even though "protected page doesn't work" makes auth the instinctive first suspect. Since this constants module is the single source every other file should be reading from (§7's flagged exception aside), confirm both files reference the *same* constant, not two independently-typed string literals.
2. **Confirm the new entry actually landed in the right array in `routes.tsx`.** `protectedRoutePaths`, `authenticationRoutePaths`, and `baseRoutePaths` are three separate arrays, and only one of them is rendered inside the `ProtectedRoute`-guarded `<Route>` block in `index.tsx`. A route object accidentally pushed into `baseRoutePaths` instead of `protectedRoutePaths` would render with no auth check at all (wrong direction of bug from what's reported, but worth ruling out); one *not* added to any array wouldn't render anywhere, which — again — surfaces as the catch-all `NotFound`, not a redirect loop.
3. **If it's specifically a redirect loop (not a 404), suspect `useAuth()`'s cache state, not the route table.** A loop between the new protected page and `/sign-in` means `ProtectedRoute` is alternating between "no user, redirect to sign-in" and something sending the browser back — which, for `/workspace/:workspaceId/reports` specifically, most plausibly means `useAuth()` is intermittently resolving with no user for some request-timing reason (a race between the access-token refresh interceptor and this query firing, or a user whose session genuinely did just expire mid-navigation) rather than a route-table bug at all. Since `staleTime: 0` (`hooks/api/use-auth.tsx:8`) means this query refetches on every mount rather than trusting a cached answer, a page that mounts/unmounts `ProtectedRoute` unusually often (nested routes re-triggering the guard, a parent component key changing) would refire `GET /user/current` unusually often too — check whether the new route's position in the tree causes `ProtectedRoute` to remount more than existing protected routes do, and check the Network tab for repeated `/user/current` calls with alternating 200/401 results rather than a single stable answer.
4. **Only after ruling out 1–3, suspect something role/permission-specific on the backend.** "Works for the engineer who built it, fails for some other users" is also consistent with those failing users legitimately lacking a role or permission the new page's *data* requires — which would show up as the page rendering (the route guard passed; the user is authenticated) but then failing loudly or silently once it tries to fetch report data and the backend's `roleGuard` rejects the call. That's not a routing bug at all — it's the RBAC layer working as intended — but it's worth explicitly ruling in or out before spending more time in `routes/`, since the reported symptom ("doesn't work for some users") is compatible with both a routing defect and correct authorization behavior being misread as a bug.

The general lesson, transferable to any router built the way AstriX's is: a route that "doesn't work for some users but not others" is rarely the guard's *logic* being wrong (the logic — check auth, render or redirect — is the same for every user) and far more often either a registration mismatch (steps 1–2, which affect *everyone* identically, so "some users" is a hint against this) or a timing/cache-state difference between users (step 3, which plausibly *does* vary per user) or a permissions difference that only looks like a routing bug from the outside (step 4).

---

**Related reading:** [`00-master-frontend-architecture.md`](./00-master-frontend-architecture.md) for the full provider tree this routing layer sits inside; [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md) for the token/guard logic `useAuth()` and `AuthProvider` build on; [`04-server-state-and-data-fetching.md`](./04-server-state-and-data-fetching.md) for how `useAuth()` itself works as a React Query hook; [`09-error-handling-loading-states-and-resilience.md`](./09-error-handling-loading-states-and-resilience.md) for the `ErrorBoundary`/skeleton patterns this file's `<Suspense>` fallback and per-layout error boundaries plug into; and [`../backend/02-authentication-and-authorization.md`](../backend/02-authentication-and-authorization.md) for the `authenticate` middleware and `roleGuard` that are the actual security boundary behind every route this file describes.
