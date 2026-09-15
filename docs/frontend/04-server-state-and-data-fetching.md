# Server State & Data Fetching

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Frontend](./00-master-frontend-architecture.md).

Almost everything interesting a browser app shows on screen didn't originate in the browser — it lives in a database somewhere, arrives over the network, can go stale the instant it arrives, and can be mutated by someone else entirely (another tab, another user, a cron job) while your component is still mounted looking at it. That's a fundamentally different kind of state from a dropdown's open/closed flag or a form field's current text — the master frontend file already draws this line explicitly in its three-way state model (`docs/frontend/00-master-frontend-architecture.md` §3): Zustand owns client/UI state, React Context owns narrow derived state, and **TanStack React Query owns everything that originated on the server** — the current user, the active workspace, its projects, tasks, and members. This file is that third bucket's chapter: what "server state" means as a category distinct from ordinary component state, the real menu of libraries and patterns the industry uses to manage it, and exactly how AstriX's own `QueryProvider` root config and `hooks/api/*.tsx` hook-per-concern pattern make the caching, deduplication, and invalidation decisions they make.

---

## 1. The Landscape

Before touching AstriX's code, it's worth being precise about what makes "server state" hard, because every library covered below is solving the same handful of problems, just with different defaults and different amounts of code you have to write yourself.

A piece of server-originated data that a component displays has to answer questions a piece of local `useState` never has to:
- **Is it still fresh**, or has something changed on the server since it was fetched?
- **Is anyone else already fetching this exact thing right now** (two components mounting the same data in the same render pass), and if so, can the two requests be collapsed into one?
- **What happens while it's loading**, and separately, **what happens if it fails** — and does a failure get retried, and if so, how many times, with what backoff?
- **When does it get thrown away**, and when a mutation changes the underlying data, how does every other place on screen showing a stale copy of it find out?

None of those questions have a "just write it in a `useState`" answer that scales past a handful of components. Four real, named approaches the industry actually uses:

### 1.1 Manual `useEffect` + `fetch`/axios with local `useState`

This is the pre-library default — no dependency beyond the HTTP client itself, and still extremely common, especially in codebases that predate the current generation of data-fetching libraries or in small apps where a team hasn't yet felt the pain that justifies adding one:

```tsx
function ProjectList({ workspaceId }: { workspaceId: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    fetch(`/api/workspace/${workspaceId}/projects`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setProjects(data.projects);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // ...render projects / isLoading / error
}
```

Nothing here is wrong exactly — it's honest, readable code, and for a single fetch on a single page it works fine. The trouble starts the moment the app grows past that: this component and a sibling component both mounting with the same `workspaceId` fire two independent, un-deduplicated network requests for identical data. Navigate away and back, and the whole fetch replays from an empty-array loading state even though the data hasn't changed — there is no cache at all, just component-local memory that dies with the component. The `cancelled` flag above is a hand-rolled defense against a genuinely nasty race condition: if `workspaceId` changes quickly (fast navigation) before the first fetch resolves, without that guard the *first* request's stale response can land after the second one and overwrite fresher data with older data — a bug class experienced engineers have all independently reinvented a fix for, usually inconsistently across a codebase, because nothing enforces it. None of loading-state coordination across simultaneous fetchers, background refetch-on-focus, retry-on-network-blip, or "some other component already has this data warm, skip the network call" comes for free — every one of those is either hand-rolled per call site or, more often in practice, just never implemented at all until a bug report forces the issue.

### 1.2 SWR

[SWR](https://swr.vercel.app/) (Vercel's data-fetching library, named for the HTTP cache-control directive *stale-while-revalidate*) was built to solve exactly the caching/deduplication gap above with the smallest possible API surface — one hook, keyed by a string or array, returning cached data instantly on a re-render while a background revalidation keeps it fresh:

```tsx
import useSWR from "swr";

function ProjectList({ workspaceId }: { workspaceId: string }) {
  const { data, error, isLoading } = useSWR(
    `/workspace/${workspaceId}/projects`,
    fetcher
  );
  // ...render
}
```

SWR's model is deliberately opinionated toward "always show something, keep it fresh in the background": by default it revalidates on window focus, on network reconnect, and at a configurable interval, with in-memory deduplication so two components requesting the same key inside a short window collapse into one network call. It's a genuine, comparably-popular alternative to React Query — similar surface area, similar mental model (key-based cache, `mutate()` to manually update or invalidate) — and for apps that don't need much beyond "fetch, cache, keep fresh," it's often *less* code than React Query for the same result, since it ships fewer configuration knobs. The tradeoff is exactly that: fewer knobs. Fine-grained per-query control over retry predicates, complex mutation lifecycles (`onMutate`/`onError`/`onSettled` rollback chains), and the query-key-as-dependency-array ergonomics React Query offers for deeply nested, parameterized cache entries are comparatively less developed in SWR — doable, but with a smaller, less battle-tested toolbox around it. Teams pick SWR when the app's data-fetching needs stay simple and the smaller bundle/API surface is worth more than the extra configurability.

### 1.3 TanStack React Query

[TanStack Query](https://tanstack.com/query) (formerly React Query) takes the same core idea — a cache keyed by a serializable key, background revalidation, request deduplication — and builds a considerably larger toolbox around it: configurable `staleTime` and `gcTime` per query, a full mutation lifecycle with optimistic-update helpers, `keepPreviousData`/`placeholderData` for pagination UX, dependent queries via `enabled`, infinite/paginated query helpers, and framework-agnostic core with bindings for React, Vue, Svelte, and Solid. This is what AstriX uses:

```tsx
import { useQuery } from "@tanstack/react-query";

function useProjects(workspaceId: string) {
  return useQuery({
    queryKey: ["projects", workspaceId],
    queryFn: () => fetchProjects(workspaceId),
  });
}
```

The tradeoff for that larger toolbox is exactly what you'd expect: more concepts to learn (the `staleTime` vs. `gcTime` distinction trips up nearly everyone the first time), more configuration surface per query, and a heavier bundle than SWR's minimal core. In exchange, teams get a data-fetching layer expressive enough to model genuinely complex server-state scenarios — paginated lists that shouldn't flash a loading spinner between pages, mutations with rollback-on-error, and (the piece AstriX leans on hardest, see §3) per-query control over exactly when a cache entry is allowed to go stale versus never refetch on its own until something explicitly invalidates it.

### 1.4 RTK Query

[RTK Query](https://redux-toolkit.org/rtk-query/overview) is Redux Toolkit's built-in data-fetching and caching layer — relevant specifically for a team already committed to Redux for client state, since RTK Query generates a Redux slice (reducers, actions, selectors) from an API definition rather than bolting a separate cache on top of a separate client-state store:

```tsx
import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

export const api = createApi({
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  tagTypes: ["Project"],
  endpoints: (builder) => ({
    getProjects: builder.query<Project[], string>({
      query: (workspaceId) => `/workspace/${workspaceId}/projects`,
      providesTags: ["Project"],
    }),
  }),
});

export const { useGetProjectsQuery } = api;
```

RTK Query's caching model uses a tag-based invalidation system (`providesTags`/`invalidatesTags`) instead of React Query's hierarchical array keys — a mutation declares which tags it invalidates, and every query that provided one of those tags refetches automatically. That's genuinely convenient once a team is fluent in it, and it means server state and client state share one store and one set of Redux DevTools timeline entries, which is a real operational win for a team that already lives in Redux daily. The tradeoff is the inverse of that convenience: adopting RTK Query as a *new* dependency purely for its data-fetching layer means adopting Redux's conceptual model (actions, slices, the store) for a problem React Query or SWR solve without asking a team to buy into a global store architecture at all. For a codebase that isn't already on Redux — which is AstriX's case, since its client state lives in Zustand (`docs/frontend/03-client-state-management.md`) — pulling in RTK Query would mean introducing an entire second state-management paradigm (Redux) solely to get its query layer, which is a much larger footprint than adding a focused server-state library that composes with whatever client-state tool is already in place.

---

## 2. AstriX's Choice

AstriX uses **TanStack React Query v5**, mounted once at the app root and configured with a small, deliberate set of global defaults (`client/src/context/query-provider.tsx`), consumed through a **hook-per-server-state-concern pattern**: every distinct piece of server data — the current user, a workspace, a paginated project list, a workspace's member roster — gets its own thin wrapper hook under `client/src/hooks/api/`, each making its own explicit choice about `staleTime`, retry behavior, and (where pagination is involved) `keepPreviousData`, rather than one generic `useServerData(url)` hook shared across every use case. Reads go through `useQuery`; every corresponding write goes through `useMutation`, followed by an explicit `queryClient.invalidateQueries()` call naming exactly which cached reads that write just made stale. There is no automatic tag-based invalidation the way RTK Query offers — every invalidation in this codebase is a deliberate, hand-written call naming a query key, which is a direct consequence of not using RTK Query's tag system and instead relying on React Query's array-key hierarchy directly.

---

## 3. AstriX Implementation

### 3.1 The root `QueryClient` — global defaults

```tsx
// client/src/context/query-provider.tsx:1-26
import { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

interface Props {
  children: ReactNode;
}

export default function QueryProvider({ children }: Props) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (failureCount < 2 && error?.message === "Network Error") {
            return true;
          }
          return false;
        },
        retryDelay: 0,
      },
    },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
```

Three deliberate departures from React Query's own defaults, all worth naming explicitly because each one is a real, considered decision rather than an oversight:

- **`refetchOnWindowFocus: false`.** React Query's default is `true` — tabbing back into a browser tab triggers a background refetch of every currently-mounted query. AstriX turns this off globally. This matters a lot in a multi-tab workflow tool: a user with a workspace open in three tabs while alt-tabbing to Slack and back would otherwise trigger a refetch storm across every mounted query in every tab, every single time focus returns — for an app whose data genuinely doesn't need second-by-second freshness on every focus event. Section 5 walks through what AstriX trades away to get this.
- **A custom `retry` predicate**, not a `retry: true/false/number` shorthand. The function receives `failureCount` and the thrown `error`, and only returns `true` — meaning "retry this" — when `failureCount < 2` *and* `error?.message === "Network Error"`. That second condition is the load-bearing one: it means a failed request retries automatically only when the failure looks like a transient network blip (the string axios throws when a request never got a response at all — no network, DNS failure, CORS preflight failure), never for an HTTP error response that *did* come back from the server (a 401, a 404, a 500 with a JSON error body). Section 5 connects this directly to `use-auth.tsx`'s own comment about why that distinction matters for authentication specifically.
- **`retryDelay: 0`.** React Query's default retry delay backs off exponentially between attempts (roughly `min(1000 * 2 ** attempt, 30000)` ms). AstriX retries immediately, with no delay at all. Combined with the two-attempt cap above, the practical effect is: a genuine network blip gets two immediate retries with no user-visible delay, and anything else — including a slow but eventually-successful connection — gets none of React Query's usual exponential backoff cushioning.

### 3.2 Read hooks — four real examples, four different `staleTime` choices

**`useAuth` — "am I logged in," checked constantly:**

```tsx
// client/src/hooks/api/use-auth.tsx:1-16
import { getCurrentUserQueryFn } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

const useAuth = () => {
  const query = useQuery({
    queryKey: ["authUser"],
    queryFn: getCurrentUserQueryFn,
    staleTime: 0,
    // Retries are left to QueryProvider's global predicate, which only retries
    // network errors. A 401 here means "logged out", not a transient failure,
    // so retrying it just multiplies refresh round trips on every page load.
  });
  return query;
};

export default useAuth;
```

**`useGetProjectInWorkspace` — a paginated list, cached until something says otherwise:**

```tsx
// client/src/hooks/api/use-get-projects.tsx:1-26
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AllProjectPayloadType } from "../../types/api.type";
import { getProjectsInWorkspaceQueryFn } from "@/lib/api";

const useGetProjectInWorkspace = ({
  workspaceId,
  pageSize,
  pageNumber,
  skip = false,
}: AllProjectPayloadType) => {
  const query = useQuery({
    queryKey: ["allProjects", workspaceId, pageNumber, pageSize],
    queryFn: () =>
      getProjectsInWorkspaceQueryFn({
        workspaceId,
        pageSize,
        pageNumber,
      }),
    staleTime: Infinity,
    placeholderData: skip ? undefined : keepPreviousData,
    enabled: !skip,
  });
  return query;
};

export default useGetProjectInWorkspace;
```

**`useGetWorkspaceQuery` — a single workspace, revalidated eagerly, with its own local retry count:**

```tsx
// client/src/hooks/api/use-get-workspace.tsx:1-17
import { getWorkspaceByIdQueryFn } from "@/lib/api";
import { CustomError } from "@/types/custom-error.type";
import { WorkspaceByIdResponseType } from "@/types/api.type";
import { useQuery } from "@tanstack/react-query";

const useGetWorkspaceQuery = (workspaceId: string) => {
  const query = useQuery<WorkspaceByIdResponseType, CustomError>({
    queryKey: ["workspace", workspaceId],
    queryFn: () => getWorkspaceByIdQueryFn(workspaceId),
    staleTime: 0,
    retry: 2,
    enabled: !!workspaceId,
  });
  return query;
};

export default useGetWorkspaceQuery;
```

Notice this hook overrides the global `retry` predicate with a plain `retry: 2` — React Query's per-query options always win over `QueryProvider`'s `defaultOptions`, so this specific query retries any failure (not just `"Network Error"` ones) up to twice, unlike everything else in the app that silently inherits the global network-error-only predicate.

**`useGetWorkspaceMembers` — the smallest of the four, and the simplest `staleTime: Infinity` case:**

```tsx
// client/src/hooks/api/use-get-workspace-members.tsx:1-13
import { getMembersInWorkspaceQueryFn } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

const useGetWorkspaceMembers = (workspaceId: string) => {
  const query = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () => getMembersInWorkspaceQueryFn(workspaceId),
    staleTime: Infinity,
  });
  return query;
};

export default useGetWorkspaceMembers;
```

### 3.3 Mutations — the write side, with explicit invalidation

The four hooks above are all reads. AstriX's mutations live directly in the components that trigger them (not in `hooks/api/`), each pairing a `useMutation` call with a `queryClient.invalidateQueries()` call in its `onSuccess` handler, naming exactly which cached reads the write just invalidated. Two real examples, chosen because they demonstrate two different invalidation-key granularities (walked through in §5):

**Creating a project** — invalidates a *broader* key than the read hook's own query key:

```tsx
// client/src/components/workspace/project/create-project-form.tsx:24-96 (excerpt — imports, the mutation hook, and the submit handler; JSX form markup omitted)
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createProjectMutationFn } from "@/lib/api";
import { toast } from "@/hooks/use-toast";

export default function CreateProjectForm({
  onClose,
}: {
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();

  const [emoji, setEmoji] = useState("📊");

  const { mutate, isPending } = useMutation({
    mutationFn: createProjectMutationFn,
  });

  // ...form schema/useForm setup omitted

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    if (isPending) return;
    const payload = {
      workspaceId,
      data: {
        emoji,
        ...values,
      },
    };
    mutate(payload, {
      onSuccess: (data) => {
        const project = data.project;
        queryClient.invalidateQueries({
          queryKey: ["allProjects", workspaceId],
        });

        toast({
          title: "Success",
          description: "Project created successfully",
          variant: "success",
        });

        navigate(`/workspace/${workspaceId}/project/${project._id}`);
        setTimeout(() => onClose(), 500);
      },
      onError: (error) => {
        toast({
          title: "Error",
          description: error.message,
          variant: "destructive",
        });
      },
    });
  };
  // ...JSX form omitted
}
```

**Changing a member's role, and removing a member** — invalidates a key that matches the read hook's query key *exactly*:

```tsx
// client/src/components/workspace/member/all-members.tsx:29-114 (excerpt — imports, both mutation hooks, and both handlers; JSX list/dropdown markup omitted)
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  changeWorkspaceMemberRoleMutationFn,
  removeWorkspaceMemberMutationFn,
} from "@/lib/api";

const AllMembers = () => {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();

  const { data, isPending } = useGetWorkspaceMembers(workspaceId);
  const members = data?.members || [];
  const roles = data?.roles || [];

  const { mutate, isPending: isLoading } = useMutation({
    mutationFn: changeWorkspaceMemberRoleMutationFn,
  });

  const removeMutation = useMutation({
    mutationFn: removeWorkspaceMemberMutationFn,
  });

  const handleSelect = (roleId: string, memberId: string) => {
    if (!roleId || !memberId) return;
    const payload = { workspaceId, data: { roleId, memberId } };
    mutate(payload, {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: ["members", workspaceId],
        });
        toast({
          title: "Success",
          description: "Member's role changed successfully",
          variant: "success",
        });
      },
      onError: (error) => {
        toast({
          title: "Error",
          description: error.message,
          variant: "destructive",
        });
      },
    });
  };

  const handleRemove = () => {
    if (!context) return;
    removeMutation.mutate(
      { workspaceId, memberId: context._id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: ["members", workspaceId],
          });
          toast({ title: "Member removed" });
          onCloseDialog();
        },
        onError: (error) => {
          toast({
            title: "Error",
            description: getErrorMessage(error),
            variant: "destructive",
          });
        },
      }
    );
  };
  // ...render omitted
};
```

Both mutation hooks here follow the same shape as `create-project-form.tsx`'s: `mutationFn` alone at the `useMutation` call site, with `onSuccess`/`onError` supplied per-call at `mutate(payload, { onSuccess, onError })` rather than baked into the hook — every mutation call site in the codebase decides its own success/error handling at the point of use, rather than a shared mutation hook owning fixed side effects.

---

## 4. Request/Data Flow

Tracing an actual page load and a subsequent edit end to end, tied to the code above:

1. **App boot.** `QueryProvider` (§3.1) constructs exactly one `QueryClient` and mounts `QueryClientProvider` above the router (`client/src/main.tsx`, traced in the master frontend file's §1) — so the cache instance survives route changes; navigating away from and back to a page doesn't recreate the client or wipe what's cached.
2. **A protected page mounts.** Somewhere in the authenticated tree, `useAuth()` and `useGetWorkspaceQuery(workspaceId)` are called (directly, or via `AuthProvider`, which composes both — see `client/src/context/auth-provider.tsx`). Each `useQuery` call checks the cache for its exact `queryKey` — `["authUser"]`, `["workspace", workspaceId]`. If nothing is cached yet, `queryFn` fires immediately and the component renders in a loading state; if something is cached but its `staleTime` window has expired (both of these hooks use `staleTime: 0`, so this is true almost immediately after any prior fetch), the stale cached data renders **synchronously** while a background refetch goes out — the user sees the old value first, then a re-render once the fresh response lands, never a loading spinner for data that's already sitting in cache.
3. **The query function runs.** `getCurrentUserQueryFn` and `getWorkspaceByIdQueryFn` (`client/src/lib/api.ts`, full treatment in [`07-api-layer-and-http-client.md`](./07-api-layer-and-http-client.md)) call through the shared axios instance, which attaches the bearer token from the Zustand store via a request interceptor (`docs/Architecture.md` §3.2) before the request leaves the browser.
4. **A project list mounts further down the tree** — `useGetProjectInWorkspace({ workspaceId, pageNumber, pageSize })`. Its key is `["allProjects", workspaceId, pageNumber, pageSize]`, which includes the pagination params, so page 1 and page 2 are genuinely separate cache entries. Because `staleTime: Infinity`, once page 1's data is cached it is *never* considered stale on its own — no background refetch will ever fire for it purely from time passing or a remount. `placeholderData: keepPreviousData` (when `skip` is false) means that clicking to page 2 renders page 1's data in place while page 2's request is in flight, instead of unmounting into a loading skeleton — the UI never flashes empty between pages.
5. **A response fails.** If a query function throws — most commonly the axios response interceptor rejecting with a `CustomError` built from a non-2xx response (`docs/Architecture.md` §3.3–3.4) — `QueryProvider`'s global `retry` predicate (§3.1) decides whether to retry. For anything but a raw network failure, it does not; the query settles into its `error` state immediately, and the calling component reads `query.error` / `query.isError` to render a failure UI or fire a toast.
6. **A 401 specifically.** If the failure is a 401, axios's own response interceptor (`client/src/lib/axios-client.ts`, quoted in full in `docs/Architecture.md` §3.4) intercepts it *before* React Query's retry logic ever sees it — it attempts a silent token refresh and retries the original request once, transparently, with no visible error state at all for the calling `useQuery`. React Query's retry predicate only comes into play for a 401 that survives that refresh-and-retry cycle (i.e., the refresh itself failed), by which point the interceptor has already called `clearAuth()` and force-navigated to `/sign-in` — the query effectively never gets a chance to retry a truly-expired session, because the browser has already navigated away.
7. **A user edits something** — say, changing a teammate's role via `AllMembers` (§3.3). `mutate(payload, { onSuccess, onError })` fires `changeWorkspaceMemberRoleMutationFn`, an ordinary axios call with no cache interaction of its own. On success, the `onSuccess` callback explicitly calls `queryClient.invalidateQueries({ queryKey: ["members", workspaceId] })`.
8. **Invalidation propagates.** `invalidateQueries` marks every cached query whose key matches — exactly, or as a prefix, per React Query's partial-matching rules — as stale and, for every one of those queries that currently has an active observer (a mounted component subscribed to it), triggers an immediate background refetch. `["members", workspaceId]` matches `useGetWorkspaceMembers`'s own key exactly, so the member list currently rendered by `AllMembers` refetches and the UI reflects the new role without a manual page reload — no `staleTime` window has to expire first, because `invalidateQueries` bypasses `staleTime` entirely by design; it's an explicit signal to refetch regardless of how "fresh" the cache currently thinks it is.

---

## 5. Design Decisions & Tradeoffs

**Why React Query over SWR or RTK Query, concretely.** Weighed against §1's other three approaches, React Query is the only one that gives AstriX all three of: a client-state-store-agnostic core (unlike RTK Query, which would have meant adopting Redux for its query layer alone, when the app's actual client-state choice is Zustand — see [`03-client-state-management.md`](./03-client-state-management.md)); per-query `staleTime` control expressive enough to make the *hook-by-hook* freshness decisions detailed below (SWR's simpler API makes this possible but with a noticeably smaller surface for fine-tuning retry predicates and mutation lifecycles); and enough maturity/documentation depth that a hook-per-concern pattern across a dozen-plus call sites stays consistent without the team having to invent conventions SWR doesn't ship opinions about. What AstriX gives up by not choosing manual `useEffect`+`fetch` (§1.1) is the ability to avoid a dependency entirely — a real cost for a tiny app, essentially irrelevant for one with as many interdependent server-state reads as AstriX has.

**The `staleTime` split — `0` for identity/authorization data, `Infinity` for pageable content — is a deliberate, hook-by-hook decision, not an inconsistency.** Look at what each hook actually backs:

- `useAuth` (`staleTime: 0`) answers "who is currently logged in," and that answer is checked constantly and cheaply — every route guard evaluation, every render of `AuthProvider`, every place that needs to know if a session is still valid. A `staleTime: 0` query is considered stale the instant it lands, so any new mount (a route change that remounts a guard, a fresh page load) triggers a background revalidation rather than trusting however-old cached data. For "am I still logged in," trusting arbitrarily-old cached data is actively wrong — a session that was revoked server-side (logged out from another device, an admin action) should stop being treated as valid as soon as the app has a chance to notice, not whenever some arbitrary cache window happens to expire.
- `useGetWorkspaceQuery` also uses `staleTime: 0`, for the same reason one level down: `AuthProvider` derives `hasPermission()` from this query's embedded member/role data (§3 of the master frontend file walks the full RBAC chain), so a workspace's current member/role state needs the same "revalidate eagerly" treatment as the auth check itself — a permission check built on data cached indefinitely would be exactly as dangerous as an auth check built on stale data.
- `useGetProjectInWorkspace` and `useGetWorkspaceMembers` (`staleTime: Infinity`) back paginated/listable content that AstriX's own mutations are the only expected source of change — a project only gets created, renamed, or deleted through this app's own mutation call sites, each of which already calls `invalidateQueries` on success (§3.3, §4 step 7–8). Given that, there's no reason to *also* pay for time-based revalidation: `Infinity` means "trust this cache entry until something explicitly tells you otherwise," and the "something" is always a mutation's own invalidation call, never a clock. This buys a real UX win — navigating back to a project list that hasn't changed renders instantly from cache with zero network round trip, no loading flicker — that a `staleTime: 0` (or even a modest finite `staleTime`) policy would give up for no corresponding safety benefit, since nothing outside this app's own mutations is expected to change this data.

**The retry predicate's real job is protecting the auth flow, not just deduplicating retries generically.** `QueryProvider`'s `retry: (failureCount, error) => failureCount < 2 && error?.message === "Network Error"` (§3.1) is easy to read as boilerplate resilience config, but it's load-bearing for a specific failure mode the `use-auth.tsx` comment calls out directly: a 401 response is not a transient failure to paper over with a retry — it's the server correctly saying "this session is invalid," and every retry of a 401 costs a full extra round trip through axios's response interceptor's refresh-and-retry dance (`docs/Architecture.md` §3.4). If React Query's retry logic treated a 401 the same as a dropped connection and retried it blindly, a single expired-session page load could trigger the refresh interceptor multiple times in quick succession — multiplying load on the `/auth/refresh` endpoint and multiplying the window in which a genuinely-invalid session gets one more chance to be treated as valid, for zero benefit, since retrying an authoritative "no" from the server doesn't change the answer. Restricting retries to literally `error?.message === "Network Error"` — the specific string axios throws when a request never reaches a server at all — means the retry logic only ever fires for the class of failure retries can actually fix (a dropped wifi packet, a DNS hiccup), never for a failure the server already answered definitively.

**`retryDelay: 0` paired with a hard cap of two attempts is a UX-latency trade, not a resilience regression.** Removing React Query's default exponential backoff means a flaky connection gets its two retries back-to-back with no artificial delay, so a user staring at a spinner isn't waiting an extra 1–2+ seconds of backoff on top of the retries themselves. The cost of skipping backoff — hammering a genuinely struggling server with immediate retries instead of easing off — is capped by the fact that there are only ever two attempts total and the retry predicate already excludes anything but a client-side network failure; this isn't a policy that would ever fire dozens of times against a server that's actually returning slow-but-valid 500s, because non-network-error responses don't retry at all under this predicate.

**No repository/tag-based invalidation layer — invalidation is explicit and hand-written everywhere.** Unlike RTK Query's `providesTags`/`invalidatesTags` system (§1.4), where a mutation declares an abstract tag and every query providing that tag refetches automatically, every `invalidateQueries` call in AstriX names a literal query key by hand at the call site. What's given up is the safety net of "declare the relationship once, get automatic propagation forever" — a new mutation that should invalidate a given read has to remember to say so explicitly, and nothing in the type system currently enforces that a query key referenced in an `invalidateQueries` call actually corresponds to a real, currently-used `queryKey` anywhere in the hooks layer (a typo'd key silently invalidates nothing and fails without error). What's bought in exchange is directness: reading any mutation's `onSuccess` tells you exactly, and only, what it invalidates — no indirection through a tag registry to trace before you can answer "what refetches when this mutation succeeds."

---

## 6. Security Considerations

**Does the React Query cache actually get cleared on logout — or could a previous user's data theoretically render for a split second after a different user logs in on the same tab?** This is worth answering by checking the code directly rather than assuming either way. `clearAuth()`, the Zustand action every logout/session-invalidation path calls, only touches Zustand state — its full implementation (`client/src/store/store.ts:115-125`) resets `accessToken`, `user`, `isAuthChecking`, and `isInitialized`, and nothing else; it has no awareness of the React Query cache at all. Whether stale server-state data can survive a logout therefore depends entirely on whether the *calling* code also clears the query cache, and a grep across the codebase shows the answer is **inconsistent by design, not automatic**:

- The explicit, user-initiated logout flow does clear it. `LogoutDialog`'s mutation calls `queryClient.clear()` in *both* its `onSuccess` and `onError` branches, immediately before `clearAuth()`:

```tsx
// client/src/components/asidebar/logout-dialog.tsx:30-48 (onSuccess branch of the logout mutation)
const { mutate, isPending } = useMutation({
  mutationFn: logoutMutationFn,
  onSuccess: () => {
    // 1. Clear ALL React Query caches (not just authUser)
    queryClient.clear();

    // 2. Clear Zustand auth state (token + user)
    clearAuth();

    // 3. Show success toast
    toast({
      title: "Logged out",
      description: "You have been logged out successfully.",
    });

    // 4. Close dialog and redirect to sign-in
    setIsOpen(false);
    navigate("/sign-in", { replace: true });
  },
```

  `queryClient.clear()` (not a targeted `invalidateQueries`) wipes every cache entry in the client outright — the strongest possible guarantee for this path specifically. Account deletion (`client/src/components/account/delete-account-card.tsx`) and revoking an active session from the sessions list (`client/src/components/account/sessions-card.tsx`) follow the identical `queryClient.clear()` + `clearAuth()` pairing.
- The **involuntary** logout path — the axios response interceptor forcing a logout because a refresh attempt itself failed, or because the `/auth/refresh` call came back 401 — does **not** call `queryClient.clear()` at all:

```ts
// client/src/lib/axios-client.ts:71-76, 118-121 (the two forced-logout branches in the response interceptor)
if (originalRequest.url?.includes("/auth/refresh")) {
  useStoreBase.getState().clearAuth();
  window.location.href = "/sign-in";
  return Promise.reject(customError);
}
// ...
} catch (refreshError) {
  processQueue(refreshError, null);
  useStoreBase.getState().clearAuth();
  // ...
  window.location.href = "/sign-in";
```

  Both branches call `clearAuth()` alone. In practice this doesn't currently leak a previous session's cached data across a user swap on the same tab, but the reason is almost incidental rather than deliberate: both branches redirect with `window.location.href = "/sign-in"`, a hard browser navigation rather than an in-SPA `navigate()` call, which tears down the entire JavaScript heap — including the `QueryClient` instance itself — and `main.tsx` constructs a brand-new `QueryClient` from scratch on the next page load. The cache isn't explicitly cleared here; it's destroyed as a side effect of the page reload these two branches happen to trigger. That's worth flagging honestly as a latent fragility rather than a present bug: if either of these two call sites were ever refactored to use React Router's `navigate()` instead of a hard redirect — a change that would read as a pure UX improvement (no full page reload, no loss of any other in-memory state, a smoother transition to the sign-in screen) — the missing `queryClient.clear()` would immediately become a live gap, since nothing else in the involuntary-logout path clears the cache. A codebase that wants this guarantee to hold for a reason stronger than "we happen to always hard-navigate here" should call `queryClient.clear()` explicitly alongside `clearAuth()` in both branches, the same way the three deliberate logout paths already do.

**What a `staleTime: Infinity` cache means when permissions change on the server.** `useGetProjectInWorkspace` and `useGetWorkspaceMembers` (§3.2) are, by design, never revalidated by the passage of time — only by an explicit `invalidateQueries` call from one of this app's own mutations (§3.3, §5). That design is sound for the case it's built for (this app's own writes), but it has a real, generic blind spot worth naming plainly: **a change to the underlying data that doesn't happen through one of AstriX's own mutation call sites in the current tab is invisible to these caches for the rest of the tab's lifetime.** If a user's role is downgraded by an admin from a different browser tab, a different device, or — hypothetically — a direct database/admin-console change, the member list and project list already cached in the first tab keep showing whatever they showed before the downgrade, indefinitely, because nothing in that tab ever calls `invalidateQueries` for a change it didn't itself cause. This is a real instance of a generic distributed-caching problem — any cache with a policy of "trust until explicitly told otherwise" is only as correct as the completeness of the "explicitly told otherwise" signal, and a signal that only fires for self-initiated writes is, by construction, incomplete for externally-initiated ones. `hasPermission()` itself is comparatively better insulated from this specific risk, since it derives from `useGetWorkspaceQuery`'s `staleTime: 0` data rather than the `Infinity`-cached hooks — but "revalidates on the next mount" is still not the same as "live" (see §5): a permission downgrade that lands while a user stays on the same mounted view, with no remount and no explicit refetch triggered, can still render against a permission set that's already out of date until something causes that query to refetch. Nothing here is unique to AstriX or to React Query — it's the same tradeoff every client-side cache with a mutation-driven (rather than push-driven) invalidation model makes — but it's worth naming rather than assuming away, especially for a workspace-permissions feature where the cost of a stale "yes" is someone retaining access they should have just lost.

---

## 7. Best Practice Check

React Query remains a current, industry-standard choice for server-state management in a React SPA as of 2026 — it isn't a library a team would need to justify picking today, and nothing about AstriX's usage of it reads as dated. A few specific comparisons worth making explicit:

**Object-form `useQuery`/`useMutation` calls, consistently.** Every call site checked across `hooks/api/*.tsx` and every component-level mutation in this file uses TanStack Query v5's object-argument form — `useQuery({ queryKey, queryFn, ... })` — rather than the positional-argument form (`useQuery(key, fn, options)`) that was standard in React Query v3/v4 and was fully removed as an option in v5. A repository-wide search for the old array-first calling convention (`useQuery([...])`) turns up zero matches — every query in the codebase is already written the current way, so there's no migration debt here to flag.

**No `useSuspenseQuery`, and no Suspense integration anywhere.** TanStack Query v5 shipped a first-class `useSuspenseQuery` (and `useSuspenseInfiniteQuery`) that integrates with React's `<Suspense>` boundaries directly — the query suspends the component instead of returning an `isLoading` flag to check manually. A repository-wide search confirms AstriX uses neither: every read in `hooks/api/*.tsx` and every call site consuming them checks `isLoading`/`isPending` and `error` by hand. This is worth calling out honestly as the one place AstriX's usage is dated relative to where the library itself has moved — not broken, not even a bad choice (manual loading/error checks are still fully supported and arguably easier to reason about line-by-line), but it means AstriX isn't taking advantage of the colocated loading-boundary pattern (one `<Suspense fallback>` covering several suspending queries at once, instead of each component managing its own `isLoading` branch) that a 2026-era React Query codebase increasingly defaults to for reducing per-component loading-state boilerplate. Adopting it would be a meaningful but non-trivial refactor — every consuming component's manual `isLoading` branch would need to move up to a boundary — not a drop-in flag flip, so its absence here reads as "not yet adopted" rather than "actively avoided for a reason."

**The `staleTime`-driven, mutation-invalidated caching pattern is exactly current best practice**, not a workaround. The general 2026 guidance for React Query usage is precisely what §5 describes: default to a conservative `staleTime` for data whose correctness matters on every read (auth/identity, authorization), and use a long-or-infinite `staleTime` for data whose only expected source of change is the app's own writes, paired with disciplined, explicit invalidation at every mutation site. AstriX's split across its four read hooks matches this guidance hook-by-hook, not by accident.

**`refetchOnWindowFocus: false`, globally, is a defensible-but-debatable choice rather than a clear best or worst practice.** The library's own default leans toward `true` specifically because "the user just tabbed back in" is a strong, cheap signal that data might be stale, and most consumer apps benefit from that eagerness. Turning it off globally, as AstriX does, is a legitimate choice for a workspace tool where users commonly keep multiple tabs of the same app open — but it does mean any server-originated change that isn't caught by this tab's own mutations or by a `staleTime: 0` query's next mount will sit uncorrected until something else triggers a refetch, which is the same class of gap discussed in §6. A more targeted alternative some 2026-era codebases reach for — leaving `refetchOnWindowFocus` on globally but overriding it to `false` per-query only where the refetch cost genuinely outweighs the freshness benefit — would keep the eager-revalidation safety net for auth/permission-sensitive queries while still avoiding a refetch storm for the `Infinity`-staleTime, list-shaped queries where it doesn't matter. AstriX's current all-or-nothing global setting is a coarser version of that same idea.

---

## 8. Debug Drill

**Scenario: a user edits something — renames a project, changes a task's status, updates their profile — clicks save, the request succeeds (network tab shows a 200, no error toast), but the screen still shows the old value. A manual page refresh fixes it.** This is one of the single most common bug reports in any React Query codebase, and it's worth having a fixed mental checklist for, because the symptom is identical across at least four structurally different root causes.

1. **Is `invalidateQueries` actually being called on success, at all?** Start here — it's the single most common cause. Find the `useMutation` call behind the save action and check its `onSuccess` handler (or the `onSuccess` passed to `mutate(payload, { onSuccess })`, since this codebase supplies it per-call rather than on the hook itself — §3.3). If there's no `queryClient.invalidateQueries()` call in there at all, the mutation succeeded exactly as reported, but nothing ever told the read side its cached data is now wrong — the fix is adding the invalidation call, not investigating further.
2. **If `invalidateQueries` is being called, does its `queryKey` actually match the query key the stale-looking component is reading from?** This is the second most common cause, and it's sneakier because the code *looks* correct — there's an `invalidateQueries` call right there. The bug is a mismatch between the two keys. Concretely, in this codebase's own pattern: `useGetProjectInWorkspace`'s real key is `["allProjects", workspaceId, pageNumber, pageSize]` (§3.2), but `create-project-form.tsx`'s invalidation only names `["allProjects", workspaceId]` (§3.3) — and that still works, because React Query's key matching treats an invalidation key as a *prefix* match by default: invalidating `["allProjects", workspaceId]` correctly catches every `pageNumber`/`pageSize` variant underneath it. The bug case is the mirror image of this working example: an invalidation call that's *more specific* than the query it's trying to catch — for instance, invalidating `["allProjects", workspaceId, 1, 10]` when the component currently on screen is showing `pageNumber: 2` — matches nothing, because a longer, more specific invalidation key does not match a shorter or differently-valued query key. When chasing this bug, print or log the exact `queryKey` array the stale component's `useQuery` call is using, and the exact array the suspected mutation's `invalidateQueries` call is using, and diff them character-by-character — a value that's a number in one and a string in the other (`pageNumber` vs. `String(pageNumber)`), or a param included in one key but omitted from the other, is enough to silently break the match.
3. **Is the query's `staleTime` masking a genuinely-missing invalidation?** If a query uses `staleTime: Infinity` (or any long finite value) and there's no invalidation call anywhere in the responsible mutation's success path, the query has no way to ever learn the data changed — not on remount, not on window refocus (doubly so in this codebase, since `refetchOnWindowFocus` is off globally, §3.1/§7), not ever, until either the cache entry is evicted by `gcTime` after every observer unmounts, or the browser tab is closed and reopened. This is functionally the same root cause as item 1 (a missing invalidation), but it's worth checking separately, because a long `staleTime` is exactly what makes the bug reproducible and confusing in testing: a developer working against a query with `staleTime: 0` would likely never notice a missing invalidation, since the next remount papers over it by revalidating anyway — the bug only becomes visible, and only becomes a real user-facing problem, on the `Infinity`/long-`staleTime` queries where nothing else is going to rescue a forgotten invalidation call.
4. **Is this actually an optimistic update that never got confirmed or rolled back?** If the mutation uses React Query's optimistic-update pattern — writing directly into the cache via `queryClient.setQueryData()` inside `onMutate`, before the server has responded — check whether the corresponding `onError` rollback and `onSettled` reconciliation are both actually present and correct. A half-implemented optimistic update (the optimistic write happens, but there's no `onSettled` step that re-syncs the cache with the server's actual response, or the rollback on `onError` writes back the wrong snapshot) can look exactly like "the UI shows a stale value" even though, mechanically, it's the opposite problem — the UI is showing an *optimistic* value that was never corrected against what the server actually persisted, rather than a genuinely old cached value that was never invalidated. Distinguishing the two matters for the fix: item 1–3 are missing-invalidation bugs (the fix is calling or correcting `invalidateQueries`), while this one is a missing-reconciliation bug in an optimistic-update mutation (the fix is completing the `onError`/`onSettled` half of the pattern) — treating a reconciliation bug as if it were an invalidation-key mismatch wastes time diffing query keys that were never the actual problem.

Working through these four in order — missing invalidation, mismatched key, long-`staleTime` masking either of the first two, and a broken optimistic-update lifecycle — covers the overwhelming majority of "stale UI after a successful save" reports in any React-Query-based frontend, this codebase included.

---

**Related chapters:** [`00-master-frontend-architecture.md`](./00-master-frontend-architecture.md) for how `QueryProvider` fits into the full provider tree and the three-way state model · [`03-client-state-management.md`](./03-client-state-management.md) for the Zustand slice that `clearAuth()` belongs to · [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md) for the full `AuthProvider`/`hasPermission()`/RBAC chain that `useAuth()` and `useGetWorkspaceQuery()` feed · [`07-api-layer-and-http-client.md`](./07-api-layer-and-http-client.md) for the axios instance and `lib/api.ts` query functions every hook in this file calls into · [`09-error-handling-loading-states-and-resilience.md`](./09-error-handling-loading-states-and-resilience.md) for how a query's `error`/`isLoading` state actually surfaces as UI.
