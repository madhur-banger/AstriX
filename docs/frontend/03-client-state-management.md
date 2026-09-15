# Client State Management

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Frontend](./00-master-frontend-architecture.md).

Every non-trivial frontend eventually needs somewhere to put state that isn't a prop, isn't cached from a server, and needs to be visible to components that aren't related to each other in the render tree. In AstriX that "somewhere" is a single Zustand store holding exactly one thing: an in-memory snapshot of who's currently logged in and what token proves it. That's a narrow job, but it's a job every real frontend has to solve one way or another, and the way it gets solved says a lot about how seriously a codebase takes security and re-render performance at the same time. This chapter surveys the landscape of ways to solve "share state across components" in a React app, then walks through AstriX's actual implementation — every line of it — and what it costs and buys.

---

## 1. The Landscape

"Client state" here means state that lives entirely in the browser and has no server-side source of truth to sync against — UI toggles, form drafts, feature flags, and, in AstriX's case, an access token and a lightweight user object. This is a different problem from *server state* (data that originated from an API and must stay in sync with it, cached, invalidated, refetched — that's [`04-server-state-and-data-fetching.md`](./04-server-state-and-data-fetching.md)'s territory). Conflating the two is one of the most common React architecture mistakes: reaching for a global store to hold data that a server-state library would cache, dedupe, and invalidate for free. This file is scoped to the narrower problem — state React itself doesn't know about and no server owns.

Four real, load-bearing approaches solve this problem across the industry, and they sit on a spectrum from "no library, no ceremony" to "state as independently addressable atoms."

### (a) Prop drilling / lifting state up

This is React's own default answer, and it's not a strawman — it's usually the *correct* first move, because it costs nothing (no dependency, no new concept) and keeps data flow traceable by just reading the component tree. State lives in the nearest common ancestor of the components that need it, and gets threaded down as props.

```tsx
// No library at all — just React's normal data flow
function Dashboard() {
  const [selectedTab, setSelectedTab] = useState("overview");
  return (
    <>
      <TabBar selected={selectedTab} onSelect={setSelectedTab} />
      <TabContent tab={selectedTab} />
    </>
  );
}
```

The honest tradeoff: it works cleanly for two or three levels of nesting, and it degrades badly past that. Every intermediate component that doesn't itself care about `selectedTab` still has to accept and forward it as a prop, just to get it to a descendant that does — the classic "prop drilling" pain. It also doesn't solve the *sibling-to-sibling* or *far-apart-in-the-tree* case at all without hoisting state up to a shared ancestor that may otherwise have nothing to do with either consumer, which can force awkward, unrelated components to live in the same file or module just to share a `useState` call.

### (b) React Context + `useReducer`

Built directly into React — no dependency, no new mental model beyond `createContext`/`useContext`, and pairing it with `useReducer` gives you a Redux-shaped `dispatch({ type, payload })` API without installing Redux.

```tsx
// No library — React's own Context + useReducer
const AuthContext = createContext<{ user: User | null; dispatch: Dispatch<Action> } | null>(null);

function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, { user: null });
  return (
    <AuthContext.Provider value={{ user: state.user, dispatch }}>
      {children}
    </AuthContext.Provider>
  );
}
```

This solves the "far apart in the tree" problem prop drilling can't — any descendant of the `Provider` can call `useContext(AuthContext)` regardless of how deep it is. The tradeoff that catches teams by surprise is re-render scoping: **every consumer of a Context re-renders whenever the Provider's value changes, even if the consumer only cares about one field of it.** A Context holding `{ user, workspace, theme }` re-renders every consumer on a `theme` change even if that consumer never reads `theme` — React doesn't do selector-based subscription to Context out of the box. Splitting into multiple narrower Contexts helps, but multiplies provider nesting. This is exactly the caveat AstriX's own `AuthProvider` (covered in [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md)) is scoped narrowly to avoid — it composes derived, read-mostly values (`hasPermission()`) rather than holding the frequently-changing access token itself.

### (c) A global store library — Redux/Redux Toolkit and Zustand

This is really two distinct points on the same axis — "one external store outside React, subscribed to selectively" — with very different amounts of ceremony.

**Redux / Redux Toolkit** is the historical default, and it's still extremely common in large, established codebases. The model is strict on purpose: state changes only through dispatched `action` objects, handled by pure `reducer` functions, with middleware (thunks, sagas) as the escape hatch for side effects.

```ts
// Redux Toolkit — action/reducer/dispatch model
import { createSlice, configureStore } from "@reduxjs/toolkit";

const authSlice = createSlice({
  name: "auth",
  initialState: { accessToken: null as string | null, user: null },
  reducers: {
    setAuth: (state, action) => {
      state.accessToken = action.payload.token; // Immer is baked into RTK's createSlice
      state.user = action.payload.user;
    },
    clearAuth: (state) => {
      state.accessToken = null;
      state.user = null;
    },
  },
});

const store = configureStore({ reducer: { auth: authSlice.reducer } });
```

RTK's value proposition is exactly that it removed most of classic Redux's boilerplate (`createSlice` bakes in Immer-based "mutate a draft" reducers and auto-generates action creators), and it earns its keep in large teams via strict, predictable, time-travel-debuggable state transitions and a mature middleware ecosystem (RTK Query, listener middleware, entity adapters). The honest cost: even "reduced" boilerplate is still a `<Provider>` wrapping the app, a store shape to design up front, and reducers/actions to write for state that might genuinely be as simple as "one token, one user object."

**Zustand** — what AstriX uses — takes the opposite bet: minimal API surface, no action-type ceremony, no required `<Provider>` wrapper at all (the store is just a hook, importable from anywhere).

```ts
// Zustand — a store is just a hook, no Provider required
import { create } from "zustand";

const useAuthStore = create<{ accessToken: string | null; setToken: (t: string) => void }>(
  (set) => ({
    accessToken: null,
    setToken: (t) => set({ accessToken: t }),
  })
);

// any component, anywhere, no wrapping needed:
const token = useAuthStore((s) => s.accessToken);
```

The tradeoff is the mirror image of Redux's: less structure means less to write, but also less enforced discipline — nothing stops a large Zustand store from becoming an unstructured grab-bag of unrelated fields and setters if a team doesn't self-impose some organizing convention (which is exactly what the "slice" pattern in §3 below is for). Zustand's selector-based subscription (`useAuthStore((s) => s.accessToken)`) is also opt-in, not automatic — call the hook with no selector and you subscribe to everything, a distinction that matters a great deal in §5 of this file.

### (d) Atomic state — Jotai / Recoil

A structurally different idea: instead of one central store object, state is modeled as many small, independent "atoms," each individually subscribable, that can be composed and derived from each other.

```ts
// Jotai — state as independent atoms, not one central object
import { atom, useAtom } from "jotai";

const accessTokenAtom = atom<string | null>(null);
const isAuthenticatedAtom = atom((get) => get(accessTokenAtom) !== null); // derived atom

function Header() {
  const [isAuthenticated] = useAtom(isAuthenticatedAtom); // only re-renders on this atom's changes
}
```

This model shines for state with many small, loosely related, or dynamically-created pieces (think: per-row UI state in a large dynamic table, or per-node state in a graph editor) where a single central store would force artificial grouping. Recoil pioneered the idea for React specifically (though its long-term maintenance status has been uncertain since Meta's involvement wound down, which is a real adoption consideration in 2026); Jotai is the actively maintained, more broadly recommended atomic library today. The tradeoff: atoms compose beautifully for fine-grained, independent pieces of state, but for state that's inherently one cohesive object anyway — like "the current auth session" — splitting it into atoms (`accessTokenAtom`, `userAtom`, `isAuthCheckingAtom`, wired together with derived atoms to keep them consistent) adds indirection without buying anything a single small object wouldn't already give you for free.

None of these four is strictly "wrong" for an auth-token slice — a small Redux slice, a narrow Context, or two or three Jotai atoms could all hold the same three or four fields AstriX's store holds. The next section explains which one AstriX actually picked, and why that pick fits this specific job.

---

## 2. AstriX's Choice

AstriX uses **Zustand** — approach (c)'s minimal-ceremony end — for exactly one slice of state: an in-memory auth snapshot (`accessToken`, `user`, plus two booleans tracking the initial auth-check lifecycle). It's built with two middlewares layered on top of Zustand's `create`: `immer`, so state updates can be written as direct draft mutations instead of manual spread-merges, and `devtools`, gated to development only, so the store's actions are inspectable in the Redux DevTools browser extension without shipping that wiring to production. A hand-rolled "generated selectors" factory (`createSelectors`) sits on top of the raw store, auto-generating a `.use.<field>()` hook per state key. Deliberately absent: the `persist` middleware — this store's contents never survive a page reload, which is a security decision this file returns to in §5 and §6. There is currently exactly one "slice" (`createAuthSlice`) composed into the store; the slice pattern itself is a convention for organizing a store that might grow more domains later, not evidence that it already has.

---

## 3. AstriX Implementation

The entire client-state layer of the app is two files. Read in full below, comments included, because the comments in `store.ts` specifically document the security reasoning behind the design and are load-bearing, not incidental.

```ts
// client/src/store/store.ts:1-27
// client/src/store/store.ts
// ============================================
// ZUSTAND STORE - Updated for Secure Auth
// ============================================

import { create, StateCreator } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import createSelectors from "./selector";

/**
 * SECURITY NOTE: NO PERSISTENCE!
 *
 * We deliberately DO NOT persist the access token to localStorage/sessionStorage.
 *
 * Why?
 * 1. localStorage/sessionStorage can be accessed by JavaScript
 * 2. XSS attacks can steal tokens from storage
 * 3. Access tokens should be short-lived and refreshable
 *
 * How does this work?
 * - Access token lives in memory (Zustand state)
 * - When user refreshes page, access token is gone
 * - Frontend calls /auth/refresh to get new access token
 * - Refresh token is in httpOnly cookie (sent automatically)
 * - This is the most secure approach for SPAs!
 */
```

```ts
// client/src/store/store.ts:33-70
interface User {
  _id: string;
  email: string;
  name: string;
  profilePicture: string | null;
  currentWorkspace: {
    _id: string;
    name: string;
    owner: string;
    inviteCode: string;
  } | null;
}

type AuthState = {
  // Access token - stored in memory only
  accessToken: string | null;

  // User data - also in memory
  user: User | null;

  // Loading state for initial auth check
  isAuthChecking: boolean;

  // Whether we've done initial auth check
  isInitialized: boolean;

  // Actions
  setAccessToken: (token: string) => void;
  setUser: (user: User) => void;
  setAuth: (token: string, user: User) => void;
  clearAuth: () => void;
  setAuthChecking: (checking: boolean) => void;
  setInitialized: (initialized: boolean) => void;
};
```

```ts
// client/src/store/store.ts:76-144
const createAuthSlice: StateCreator<
  AuthState,
  [["zustand/immer", never], ["zustand/devtools", never]]
> = (set) => ({
  accessToken: null,
  user: null,
  isAuthChecking: true, // Start as true, will be set false after check
  isInitialized: false,

  setAccessToken: (token) =>
    set(
      (state) => {
        state.accessToken = token;
      },
      false,
      "setAccessToken"
    ),

  setUser: (user) =>
    set(
      (state) => {
        state.user = user;
      },
      false,
      "setUser"
    ),

  setAuth: (token, user) =>
    set(
      (state) => {
        state.accessToken = token;
        state.user = user;
        state.isAuthChecking = false;
        state.isInitialized = true;
      },
      false,
      "setAuth"
    ),

  clearAuth: () =>
    set(
      (state) => {
        state.accessToken = null;
        state.user = null;
        state.isAuthChecking = false;
        state.isInitialized = true;
      },
      false,
      "clearAuth"
    ),

  setAuthChecking: (checking) =>
    set(
      (state) => {
        state.isAuthChecking = checking;
      },
      false,
      "setAuthChecking"
    ),

  setInitialized: (initialized) =>
    set(
      (state) => {
        state.isInitialized = initialized;
      },
      false,
      "setInitialized"
    ),
});
```

```ts
// client/src/store/store.ts:150-177
type StoreType = AuthState;

export const useStoreBase = create<StoreType>()(
  devtools(
    immer((...a) => ({
      ...createAuthSlice(...a),
    })),
    {
      name: "auth-store",
      // Only enable devtools in development
      enabled: process.env.NODE_ENV === "development",
    }
  )
  // NOTE: No persist middleware! This is intentional for security.
);

export const useStore = createSelectors(useStoreBase);

// ============================================
// SELECTOR HOOKS (for convenience)
// ============================================

export const useAccessToken = () => useStore((s) => s.accessToken);
export const useUser = () => useStore((s) => s.user);
export const useIsAuthenticated = () => useStore((s) => !!s.accessToken);
export const useIsAuthChecking = () => useStore((s) => s.isAuthChecking);
export const useIsInitialized = () => useStore((s) => s.isInitialized);
```

And the generated-selectors factory it depends on, in full:

```ts
// client/src/store/selector.ts:1-21
/* eslint-disable @typescript-eslint/no-explicit-any */
import { StoreApi, UseBoundStore } from "zustand";

type WithSelectors<S> = S extends { getState: () => infer T }
  ? S & { use: { [K in keyof T]: () => T[K] } }
  : never;

export const createSelectors = <S extends UseBoundStore<StoreApi<object>>>(
  _store: S
) => {
  const store = _store as WithSelectors<typeof _store>;
  store.use = {};
  for (const k of Object.keys(store.getState())) {
    (store.use as any)[k] = () => store((s) => s[k as keyof typeof s]);
  }

  return store;
};

export default createSelectors;
```

### Middleware composition, precisely

`create<StoreType>()(devtools(immer((...a) => ({ ...createAuthSlice(...a) })), { name, enabled }))` reads inside-out, and it's worth being exact about what each layer contributes, because the order in the source (`devtools` wrapping `immer`) is Zustand's own documented convention, not an arbitrary choice:

- **`immer` (innermost, closest to the slice)** intercepts the `set` function your slice code calls. Ordinarily, Zustand's raw `set` expects a full or partial *next state object* — `set({ accessToken: token })` — which means any update touching more than one field has to be hand-written as an object spread: `set((state) => ({ ...state, accessToken: token, user: null }))`. The `immer` middleware replaces that contract: `set` now accepts a **recipe function that receives a mutable draft**, and you write `state.accessToken = token` directly, as if it were an ordinary mutable object. Under the hood, Immer's `produce()` records those mutations against the draft and derives a new, structurally-shared immutable state object from them — so the state update Zustand and React actually see is still immutable (new object identity on the fields that changed, same identity on the fields that didn't, which is what makes selector-based re-render skipping in §5 work at all), even though the code that produced it reads like ordinary mutation. Every action in `createAuthSlice` (`setAccessToken`, `setUser`, `setAuth`, `clearAuth`, ...) leans on exactly this — `state.accessToken = token;` inside the `set()` callback is a draft mutation, not a real one.
- **`devtools` (outermost)** wraps whatever `set` it's given — here, immer's already-wrapped `set` — and adds one more layer: every call records a labeled action into the Redux DevTools browser extension before the state change actually lands. That's what the third argument to `set(...)` in every action is for — the string `"setAccessToken"`, `"setAuth"`, `"clearAuth"`, and so on. Immer's `set` signature is `(recipe, replace?, actionName?)`; it passes that third argument straight through to whatever `set` it wraps, so by the time the call reaches `devtools`, `devtools` has a human-readable label to attach to the diff it logs. Without that argument, every action in the DevTools timeline would show up as an anonymous, unlabeled `"anonymous"` mutation, which is still functional but far less useful for debugging a specific flow (`clearAuth` firing when you expected `setAccessToken`, say). `devtools` is composed as the *outer* wrapper specifically so it can observe the state Zustand actually ends up with post-Immer, not a pre-processed draft — if the order were flipped (`immer(devtools(...))`), Immer would be intercepting `set` calls before devtools ever saw them, and devtools' own action-labeling arguments would need to survive an extra, unintended hop through Immer's recipe-vs-object-detection logic. Zustand's own middleware documentation recommends `devtools(persist(immer(...)))` as the canonical order for exactly this reason; AstriX's `devtools(immer(...))` is that same convention minus `persist` (§5, §6).
- **`enabled: process.env.NODE_ENV === "development"`** is the gate that gives `devtools` a production off-switch. Passed straight through as one of `devtools`'s own options — see §6 for what happens if it's ever misconfigured.
- **The `StateCreator<AuthState, [["zustand/immer", never], ["zustand/devtools", never]]>` type annotation on `createAuthSlice`** is not decorative. Zustand's TypeScript types track which middlewares are in play as a "mutators" tuple so that the `set` function's type inside the slice correctly reflects *what `set` actually accepts after middleware transformation* — i.e., that it takes an Immer draft-recipe (because `"zustand/immer"` is listed) rather than a plain partial-state object. Leaving this annotation off, or getting the tuple order wrong, would make `set((state) => { state.accessToken = token })` a type error, because vanilla Zustand's `set` type doesn't accept a void-returning draft mutator — only the Immer-augmented type does.

### The slice pattern

`createAuthSlice: StateCreator<AuthState, [...]>` composed into the store as `immer((...a) => ({ ...createAuthSlice(...a) }))` is Zustand's standard convention for a store that might need to hold more than one logical domain of state. The pattern is: each domain gets its own `StateCreator` function (`createAuthSlice`, and — if the store ever grew — a hypothetical `createUiSlice`, `createFeatureFlagSlice`, and so on), and the final store is assembled by spreading all of them into one combined initializer, each receiving the *same* `set`/`get`/`api` triple so any slice's actions can, if truly necessary, read or mutate another slice's fields. Worth stating plainly rather than implying: **AstriX's store has exactly one slice today.** There is no second domain currently sharing this store. The pattern is set up the way it is — a `createXSlice` function instead of just inlining the object literal directly into `create()` — so that adding a second slice later is a matter of writing a new `createYSlice` function and spreading it in alongside the first, not a restructuring of the existing store. That's a real, deliberate piece of future-proofing, not evidence of unused complexity — the alternative (inlining the state object directly, then restructuring into slices only once a second domain actually shows up) would force a riskier refactor of already-working auth code at the exact moment a second domain is being added, instead of an additive change.

### The generated-selectors factory

Zustand's baseline API lets a component subscribe to the *whole* store (`const state = useStoreBase()`, which re-renders that component on *any* field changing) or to a single derived value via a manually-written selector (`const token = useStoreBase((s) => s.accessToken)`, which only re-renders when `accessToken`'s value changes). The second form is what you actually want for most reads, but writing `useStoreBase((s) => s.accessToken)` by hand at every call site is repetitive, and it's easy to forget and just call `useStoreBase()` out of convenience — silently opting back into whole-store subscription without meaning to.

`createSelectors` (`client/src/store/selector.ts:8-18`) closes that gap by generating the narrow selector for you, once, for every field the store has: it iterates `Object.keys(store.getState())` and, for each key `k`, defines `store.use[k]` as `() => store((s) => s[k])` — i.e., a ready-made hook that subscribes to exactly that one field. `useStore.use.accessToken()` is functionally identical to hand-writing `useStore((s) => s.accessToken)`, just without having to write the selector function at the call site, and without the risk of someone reaching for the zero-argument, whole-store form by default. This is a real, if small, engineering payoff: it makes the *narrow* subscription the path of least typing, rather than the whole-store subscription being the path of least typing — which matters a great deal once you see, in §5, that AstriX's own call sites don't consistently take advantage of it.

---

## 4. Request/Data Flow

Tracing this store's actual lifecycle end to end, using real call sites found by grepping the codebase for every place that touches `useStore`/`useStoreBase` outside the store's own definition — not a hypothetical usage pattern.

**1. App boot, before any auth state exists.** `isAuthChecking: true` and `isInitialized: false` are the store's initial values (`client/src/store/store.ts:82-83`). Nothing in `store.ts` itself performs the initial `/user/current` check that resolves these flags — that boot-time auth check lives in `AuthProvider`/route-guard code, covered in [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md); this file's job is only what happens to the store once that check's result arrives.

**2. A successful sign-in writes to the store.** `Sign-in.tsx` destructures `setAuth` off the *unselected* store hook and calls it from a React Query mutation's `onSuccess`:

```tsx
// client/src/page/auth/Sign-in.tsx:61
  const { setAuth } = useStoreBase();
```

```tsx
// client/src/page/auth/Sign-in.tsx:80-81 (excerpt, inside mutate()'s onSuccess)
        // Set both token and user in store
        setAuth(data.access_token, data.user);
```

Calling `setAuth` runs the action shown in §3: one `set()` call updates `accessToken`, `user`, `isAuthChecking`, and `isInitialized` together, atomically, as a single Immer-produced state transition — not four separate `set` calls that could each trigger their own subscriber notification.

**3. Every subsequent outgoing request reads the token back out — from outside React entirely.** The axios request interceptor is not a component and cannot call a hook; it reads the store's current value imperatively:

```ts
// client/src/lib/axios-client.ts:39-46
API.interceptors.request.use((config) => {
  const accessToken = useStoreBase.getState().accessToken;
  if (accessToken) {
    config.headers["Authorization"] = "Bearer " + accessToken;
  }
  return config;
});
```

`useStoreBase.getState()` is Zustand's escape hatch for exactly this situation: any store created by `create()` exposes `.getState()` as a plain function on the hook itself, callable from anywhere — a module-level interceptor, a non-React utility, an event handler outside a component — returning a synchronous snapshot of the current state with no subscription attached. This is the only way this specific read *could* work: `useStore.use.accessToken()` is a React hook, and hooks can only be called from inside a React component's render or another hook — an axios interceptor is neither.

**4. On a 401, the response interceptor writes back to the store the same way — imperatively, via `getState()`, never via the hook:**

```ts
// client/src/lib/axios-client.ts:107-111 (excerpt, inside the refresh success path)
      const { access_token } = response.data;
      useStoreBase.getState().setAccessToken(access_token);
      processQueue(null, access_token);
```

**5. Logging out reads `clearAuth` two different ways at two different real call sites** — worth showing both, because the contrast is instructive. Inside a component, `logout-dialog.tsx` calls the *hook* form (subscribing the component to the store, even though this particular component only ever calls the action and never reads a value from it):

```tsx
// client/src/components/asidebar/logout-dialog.tsx:16,26
import { useStore } from "@/store/store";
// ...
  // Use clearAuth instead of clearAccessToken (clears both token and user)
  const { clearAuth } = useStore();
```

Whereas a mutation callback in `delete-account-card.tsx` — running inside a callback, not a component render — reaches for `getState()` instead, the same pattern the axios interceptors use:

```tsx
// client/src/components/account/delete-account-card.tsx:42-44 (excerpt, inside mutate()'s onSuccess)
        onSuccess: () => {
          queryClient.clear();
          useStoreBase.getState().clearAuth();
```

**6. `sessions-card.tsx` reads a value out of the store, and it does so by destructuring the whole-store hook rather than a generated per-field selector:**

```tsx
// client/src/components/account/sessions-card.tsx:17,25-29
import { useStoreBase } from "@/store/store";
// ...
  const { accessToken, clearAuth } = useStoreBase();

  const currentSessionId = useMemo(
    () => getSessionIdFromAccessToken(accessToken),
    [accessToken]
  );
```

Calling `useStoreBase()` with no selector argument subscribes this component to *every* field in the store, not just `accessToken` — functionally the same as `useStore()` with no selector, since `useStore` is the exact same underlying hook with a `.use` property attached, not a different hook. Neither this call site nor any of the others found by grepping the codebase uses the generated `.use.<field>()` selectors, or the standalone convenience hooks (`useAccessToken`, `useUser`, `useIsAuthenticated`, `useIsAuthChecking`, `useIsInitialized`) defined at the bottom of `store.ts`. A repository-wide search for every one of those five export names and for `useStore.use` turns up zero call sites outside `store.ts` itself. This is a real, honest gap — not a hypothetical one — and it's significant enough to shape both §7 and §8 below.

---

## 5. Design Decisions & Tradeoffs

**Why Zustand over Redux/RTK, for this job specifically.** The state this store holds — an access token, a user snapshot, two booleans — has no need for Redux's strict action/reducer separation, no need for time-travel debugging of a complex state machine, and no need for the middleware ecosystem (sagas, RTK Query, entity adapters) Redux is built to support at scale. A `<Provider>` wrapping the whole app is also unnecessary overhead for a slice this narrow — Zustand's store-as-a-hook model means `store.ts` is import-and-use from anywhere, including the axios interceptor module in §4, which is not inside the React tree at all and couldn't reach a Context- or Redux-`Provider`-scoped value without extra plumbing. That last point is close to a hard requirement, not a stylistic preference: whatever solution AstriX picked had to be readable from a plain module-level function outside any component, and Zustand's `getState()` escape hatch is precisely built for that.

**Why not Context + `useReducer`.** It would have worked functionally, but it reintroduces the re-render-scoping problem from §1(b): a Context holding `{ accessToken, user, isAuthChecking, isInitialized }` re-renders every consumer on *any* field changing, unless the Context is itself split into multiple narrower providers — at which point you've hand-built a worse version of what Zustand's selector subscriptions give you automatically. It also can't be read from outside the component tree at all (no Context equivalent of `getState()`), which would have forced the axios interceptors in §4 to use some other mechanism entirely — a module-level mutable variable kept in sync via a `useEffect`, most likely, which is strictly more code and a strictly weaker guarantee of staying in sync than reading the store directly.

**Why not atomic state (Jotai/Recoil).** Four fields that change together, as a cohesive unit (`setAuth` sets all four in one atomic transition) is the opposite of the case atomic libraries are built for — many small, independently-changing, possibly dynamically-created pieces of state. Splitting `accessToken`/`user`/`isAuthChecking`/`isInitialized` into four separate atoms would add derived-atom wiring to keep them consistent (an `isAuthenticatedAtom` derived from `accessTokenAtom`, for instance) without removing any real complexity this single small object already handles cleanly.

**Why `immer` specifically.** Without it, every multi-field update in `createAuthSlice` — `setAuth` and `clearAuth` both touch four fields at once — would have to be written as a manual spread: `set((state) => ({ ...state, accessToken: token, user, isAuthChecking: false, isInitialized: true }))`. That's not just more verbose; it's a real correctness risk, because a manual spread silently drops any field the author forgets to re-list if the `AuthState` shape grows later (a fifth field added to the type but not to every existing spread call site compiles fine and just loses that field on every update). Immer's draft-mutation form (`state.accessToken = token`) can't have that failure mode — every field not explicitly touched by the recipe function is structurally preserved by `produce()`, not by the author remembering to re-list it.

**Why `devtools` is gated to development.** `enabled: process.env.NODE_ENV === "development"` means the Redux DevTools browser extension only receives this store's action stream and state snapshots when the app is built and running in development mode. See §6 for exactly what that buys and what depends on the gate being configured correctly.

**Why no `persist` — the UX cost of the security choice.** `persist` middleware, had it been added, would buy exactly one thing: state surviving a hard reload or a new tab, by mirroring the store to `localStorage`/`sessionStorage` (or IndexedDB, via a custom storage adapter) on every write and rehydrating from it on load. AstriX explicitly does not add it to this slice, and the comment block at the top of `store.ts` states the reasoning directly: the access token would otherwise sit in `localStorage`/`sessionStorage`, both of which are plain, synchronous, script-readable browser APIs — accessible to *any* JavaScript running on the page, including injected JavaScript from a successful XSS attack. The UX cost of skipping `persist` is real and immediate: every hard reload of the page loses `accessToken` from memory (the store resets to its initial `accessToken: null`), and the app has to re-derive "am I logged in" from scratch by hitting `/auth/refresh` (using the httpOnly refresh cookie the browser still holds, which JavaScript can't read or exfiltrate) — the exact flow traced in [`docs/Architecture.md`](../Architecture.md) §3.4 and §4, and covered from the auth-flow side in [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md). AstriX chose to pay a re-authentication round trip on every hard reload in exchange for the access token never being a value an XSS payload could read after the fact, from storage, without even needing to be running at the exact moment the user was on the page.

---

## 6. Security Considerations

**What "no `persist`" actually protects against, precisely.** It's important to be exact here rather than overstating the win: removing `persist` does not make an XSS vulnerability on this app harmless. If an attacker successfully injects and runs JavaScript on a page where AstriX's store is live, that script runs with the same privileges as the app's own code — it can call `useStoreBase.getState().accessToken` (or, more realistically, just read `window`-scoped references or hook into the running app) and read the current token out of memory, exactly as legitimately as the axios interceptor does. In-memory JavaScript state is not invisible to script running in the same page; nothing about Zustand makes it so. What removing `persist` *does* buy is narrower and still real: it removes the token as a **standing, replayable target**. A token sitting in `localStorage` is readable by any script that runs on the page *at any point during that token's lifetime* — including a payload that only executes once, briefly, logs the value somewhere, and is gone; the stolen value keeps working until it naturally expires or is revoked, entirely independent of whether the original XSS session is still active. A token that only ever exists in memory is only exposed to a script that's running *at the exact moment* the token is live in the store — there's no separate, at-rest copy for a *later* or *different* script execution to go find. The attack surface shrinks from "any XSS, ever, for this token's lifetime" to "an XSS payload live at the same time the token is held in memory" — meaningfully smaller, but not a synonym for "immune to token theft via XSS."

**`devtools` and the Redux DevTools browser extension.** In a development build, `enabled: process.env.NODE_ENV === "development"` evaluates to `true`, and every action dispatched through this store — including `setAuth`, which carries the access token and full user object as its payload — becomes visible in the Redux DevTools extension's action/state inspector, for any extension with permission to read that page's DevTools connection. In practice this is a contained, low-severity exposure in AstriX's actual setup: it requires a developer's own browser, the extension installed, and a development build running locally or on a non-production environment — not something a remote attacker can reach. The real question this section has to answer honestly is the one the task calls for: **what would happen if that gate were misconfigured in a production build?** Two realistic misconfiguration paths matter. First, if `NODE_ENV` were ever not set to `"production"` in the actual production build/runtime environment — a bundler misconfiguration, a missing environment variable in the deploy pipeline, a Docker image built without the expected build-time flag — the `enabled` check would silently evaluate to `true` in production, and every real user's access token and user object would stream into the Redux DevTools extension's connection on any production visitor's machine that happens to have the extension installed. That's a genuine, if narrow, exposure (it still requires the visitor to have the extension installed and paying attention), and it's the kind of gap that's invisible in normal testing precisely because development environments are where you'd expect and want it enabled. Second, even correctly gated, the `devtools` middleware call itself and its associated bundle code still ship in the production JavaScript bundle regardless of whether `enabled` is `true` or `false` at runtime — `enabled: false` prevents the extension connection from being established, but does not tree-shake the `devtools()` wrapper or the `zustand/middleware` import out of the build. That's a minor bundle-size cost, not a security exposure on its own, but worth naming precisely rather than conflating "gated off at runtime" with "absent from the shipped code."

**What this store does *not* need to defend against.** Because there's no `persist` and no serialization to a storage API, this store carries no injection surface of its own (nothing here parses attacker-controlled input the way, say, a JSON-parsed `localStorage` value read back on boot might if it had been tampered with directly in browser storage). The store's entire trust boundary is upstream of it — whatever the backend returns from `/auth/login`, `/auth/refresh`, and `/user/current` is written into this store as-is; this file's job ends at "hold the value in memory, expose it to the right places," not at validating it.

---

## 7. Best Practice Check

**Zustand for this exact job is a current, widely-adopted 2026 choice, not a dated one.** For "a small amount of cross-cutting client state, without Redux's ceremony," Zustand (or an equivalent minimal store — Jotai used as a single-atom store is a close cousin) is squarely mainstream practice today, not a fringe or legacy pick. The `create` + `immer` + `devtools` combination specifically matches Zustand's own documented, recommended middleware composition — this isn't a bespoke pattern AstriX invented, it's the pattern the library's own docs point teams toward for exactly this situation (draft-style updates, dev-tool visibility, no unnecessary persistence). The in-memory-only, `persist`-free access-token pattern is also squarely current guidance for SPA auth in 2026 — "don't put bearer tokens in `localStorage`" has been consistent security guidance for years now, and pairing an in-memory access token with an httpOnly refresh cookie (as AstriX does) is one of the two commonly recommended patterns for SPA token storage, the other being fully cookie-based sessions with no client-visible token at all.

**Where the actual gap is, checked against the real code rather than assumed.** Two claims are worth checking precisely rather than asserting from habit:

- *"No persisted 'remember me' option"* — true, and worth stating plainly as a real, if likely intentional, absence: there is no code path anywhere in `store.ts` or its callers that offers a user a choice between "stay signed in across reloads" and "don't" — the `persist`-free design is unconditional for every user, every session, with no opt-in escape hatch. That's a defensible default for a workspace-management tool handling potentially sensitive project data, but it is a product-level tradeoff (a user who wants to skip re-authenticating after every hard reload has no way to ask for that) as much as a technical one, and it's worth naming as a deliberate absence rather than an oversight.
- *"No explicit reset-on-logout audit beyond `clearAuth()`"* — checked directly against the actual `clearAuth` action rather than assumed: `clearAuth` resets all four fields this store owns (`accessToken: null`, `user: null`, `isAuthChecking: false`, `isInitialized: true`) in one atomic update. Given that this store owns exactly those four fields and no others, `clearAuth` is, in fact, a complete reset of everything this particular store holds — there's no fifth field it leaves behind. Whether a *logout* is comprehensive in the broader sense (clearing React Query's cache, redirecting, invalidating the server-side session) is a cross-cutting concern spanning multiple files and layers — `logout-dialog.tsx` in §4 shows `queryClient.clear()` and `clearAuth()` called together, deliberately, exactly because Zustand's `clearAuth()` alone was never meant to reach into React Query's cache — and that fuller picture belongs to [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md), not to this file's narrower scope of "what does this one store do."

**The real, concrete gap this chapter did find: the selector layer is built but unused.** `createSelectors` and the five standalone convenience hooks at the bottom of `store.ts` exist specifically to make narrow, single-field subscription the default, easy path (§3). But every real call site found in §4 — `Sign-in.tsx`, `logout-dialog.tsx`, `sessions-card.tsx` — calls the whole-store hook (`useStoreBase()` or `useStore()` with no selector) instead of `useStore.use.accessToken()` or the exported `useAccessToken()`. For a store this small (four fields, most components only touching one or two of them), the practical re-render cost today is low — this isn't a store with dozens of independent, frequently-changing fields where whole-store subscription would visibly hurt. But it is a real, checkable gap between the pattern the codebase built and the pattern the codebase actually uses, and it's exactly the kind of thing that becomes a real performance problem quietly, the moment this store's field count grows (§3's slice pattern is explicitly set up to allow that growth) without the subscription discipline growing alongside it.

---

## 8. Debug Drill

**Scenario:** a component using this store re-renders far more often than its author expects — say, a sidebar item that only displays the user's name re-renders on every single Zustand action fired anywhere in the app, including ones that have nothing to do with the user object.

Work through it in this order — the reasoning generalizes to any Zustand-style store, not just this one:

1. **Check what the component actually subscribed to.** Open the component and find its store call. `const { user } = useStoreBase()` (or `useStore()` with no selector) subscribes to *every* field in the store — Zustand's default `useSyncExternalStore`-based subscription re-renders the component on *any* state change unless a selector function narrows what it's watching. This is the single most common cause of this exact symptom, and it's a real pattern already present in this codebase (§4, §7) — `sessions-card.tsx`'s `const { accessToken, clearAuth } = useStoreBase()` is destructuring, not selecting, and will re-render on an unrelated `setAuthChecking` call exactly as readily as on an `accessToken` change. The fix is a narrow selector: `useStoreBase((s) => s.user)`, or, since this codebase already has the machinery for it, `useStore.use.user()`.
2. **If a selector is already in use, check what it returns.** A selector that returns a *new object or array reference* on every call — `useStoreBase((s) => ({ token: s.accessToken, name: s.user?.name }))`, building a fresh object literal inline — defeats Zustand's default reference-equality check just as thoroughly as no selector at all, because the returned object is a different reference every time regardless of whether the underlying fields changed. Zustand's default equality function is `Object.is`; a selector needs to return a stable, primitive, or memoized value (or the store needs a custom equality function passed as a second argument) for the "only re-render if this specific value changed" guarantee to actually hold.
3. **Confirm you're looking at a subscribed read, not a stale closure.** The opposite-looking bug — "a write from one place doesn't seem to reach a read somewhere else" — usually traces to the same root cause from the other direction: a value read once via `useStoreBase.getState()` inside a component's render body or a `useEffect` with an empty dependency array captures a *snapshot*, not a live subscription — it will never update again no matter how many times the store changes, because `getState()` doesn't establish a subscription at all, by design. That's exactly correct and necessary for the axios interceptors (§4) and for one-off imperative reads inside event handlers, because a module-level interceptor genuinely has no "current render" to re-run — but it's a bug the moment it shows up inside a component that's supposed to reflect the store's *current* value on screen. The fix there is the opposite of step 1's: swap the imperative `getState()` read for the reactive hook form, `useStoreBase((s) => s.accessToken)` or `useStore.use.accessToken()`.
4. **If it's specifically the axios interceptors that seem out of sync, remember why they're structurally different from every component.** `client/src/lib/axios-client.ts:41` and its counterparts in the response interceptor (`client/src/lib/axios-client.ts:110,120`) call `useStoreBase.getState()` on purpose, not as an oversight to "fix" into a hook call — an axios interceptor function is registered once, at module load, and invoked by axios itself on every request/response, entirely outside any React render cycle. It has no component instance to re-render and cannot legally call a hook (`useStore.use.accessToken()` would violate the Rules of Hooks the moment axios invoked it outside a render). `getState()` is the only mechanism that can answer "what is the token *right now*" from that context, and because it's called fresh on every single interceptor invocation (not cached in a closure at module-load time), it's already correctly "live" in the sense that matters — each request reads the token as of the moment that specific request goes out, which is the actual correctness requirement here, not "must re-render when the token changes" (there's no render to trigger).
5. **Last resort, if none of the above explains it: check the DevTools action log itself** (development builds only, per §6) — the third argument to every `set()` call in `createAuthSlice` labels the action (`"setAccessToken"`, `"clearAuth"`, etc.), so the Redux DevTools timeline will show you exactly which action is firing and how often, which narrows "re-renders too often" down to "this specific action is being dispatched more often than expected" — at which point the investigation moves to whatever's calling that action, not to the store itself.

---

Related reading: [`00-master-frontend-architecture.md`](./00-master-frontend-architecture.md) for how this store's slice fits into AstriX's three-way state split alongside React Query and Context; [`04-server-state-and-data-fetching.md`](./04-server-state-and-data-fetching.md) for the state this store deliberately does *not* try to hold; [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md) for the full client-side auth flow this store is one piece of, including the boot-time auth check and `AuthProvider`; and [`07-api-layer-and-http-client.md`](./07-api-layer-and-http-client.md) for the axios instance whose interceptors read and write this store directly, outside React.
