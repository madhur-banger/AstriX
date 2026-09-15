# API Layer & HTTP Client

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Frontend](./00-master-frontend-architecture.md).

Every frontend that talks to a backend over HTTP eventually needs an answer to a boring-sounding but consequential question: where does the actual `fetch`/`XMLHttpRequest` call live, and what wraps it? Get this wrong and the symptoms show up everywhere except the place you'd look first — a base URL hardcoded in forty different files, an `Authorization` header attached inconsistently depending on which developer wrote which component, a 401 from an expired token silently failing a save instead of transparently refreshing and retrying, and API response shapes that are `any` at the point they cross into the rest of the app. AstriX answers this with a deliberately small surface: one shared axios instance, one file of plain exported functions (one per endpoint), one file that resolves the base URL from the environment, and a parallel file of hand-written TypeScript types that give every one of those functions a typed return value. This chapter is about that layer specifically — not the interceptors' auth-refresh *logic*, which [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md) already owns in depth, but the architecture around it: why a single instance, why axios at all, how the function-per-endpoint shape in `api.ts` holds together at 366 lines and roughly sixty exported functions without collapsing into duplication, how the base URL gets from an AWS SSM parameter into a compiled JavaScript bundle, and how types keep the whole thing honest end to end.

---

## 1. The Landscape

Every frontend that isn't purely static has to pick an answer to "how do I call my backend," and the real options cluster into four genuinely different shapes, not just four ways to write the same thing.

### (a) Raw `fetch` with a thin hand-rolled wrapper

The zero-dependency option: the browser's built-in `fetch` API, wrapped in a small helper that adds the pieces `fetch` doesn't give you for free — a base URL, a default `Content-Type`, JSON parsing, and some shape of error normalization.

```ts
// illustrative — not AstriX code
async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.message ?? res.statusText, res.status);
  }
  return res.json();
}
```

**Tradeoffs.** No dependency to install, audit, or version-bump — `fetch` ships in every modern browser and in Node 18+, so this is genuinely zero-cost on the dependency-count axis. The cost shows up the moment you need anything beyond the happy path: `fetch` doesn't reject on a non-2xx response (that `!res.ok` check above is mandatory, and easy to forget in a one-off call that bypasses the wrapper), there's no first-class request/response interceptor concept — "attach this header to every outgoing request" or "if any response comes back 401, transparently refresh and retry" has to be hand-built as a loop or a queue around every call site, exactly the machinery axios ships with — and JSON parsing, timeout handling (`fetch` has no built-in timeout; you reach for `AbortController` and a `setTimeout` yourself), and upload/download progress all need to be reimplemented or pulled in from smaller single-purpose packages. Teams that pick this path are trading a dependency for an equivalent amount of code they now own and have to keep correct themselves.

### (b) Axios with a shared configured instance and interceptors — what AstriX uses

`axios.create({ baseURL, ...defaults })` produces one configured instance that every call site imports and reuses, with `instance.interceptors.request.use(...)` and `instance.interceptors.response.use(...)` as first-class hooks that run on every request or response that passes through that instance, no matter which function fired it.

```ts
// illustrative shape — see §3.2 for AstriX's actual instance
const api = axios.create({ baseURL: "https://api.example.com", timeout: 10000 });
api.interceptors.request.use((config) => {
  config.headers.Authorization = `Bearer ${getToken()}`;
  return config;
});
```

**Tradeoffs.** Interceptors are the entire reason teams reach for axios over `fetch` for anything beyond a handful of calls: cross-cutting request/response behavior — auth headers, auto-refresh-on-401, request/response logging, a default timeout — is written exactly once, on the instance, and every call site gets it automatically rather than by convention. Axios also normalizes some real cross-environment inconsistency `fetch` doesn't: automatic JSON serialization/parsing, a `timeout` option built in, upload/download progress events, and (historically, though the gap has narrowed release to release) more consistent behavior across older browsers than a bare `fetch` polyfill story. The cost is exactly what it looks like: one more dependency in `package.json`, a small but real bundle-size line item, and axios's own API surface (`AxiosError`, `AxiosRequestConfig`, interceptor chaining order) is one more thing a new engineer on the team has to learn, distinct from web-standard `fetch`.

### (c) A client generated from an OpenAPI/Swagger spec

Tools like `openapi-typescript-codegen` or `orval` read a backend's published OpenAPI (Swagger) document and generate fully-typed TypeScript request functions directly from it — one generated function per documented operation, with request/response types derived mechanically from the spec rather than typed by hand on the frontend.

```ts
// illustrative generated output shape (openapi-typescript-codegen style)
export class WorkspaceService {
  public static getWorkspaceById(id: string): CancelablePromise<WorkspaceByIdResponse> {
    return __request(OpenAPI, { method: "GET", url: `/workspace/${id}` });
  }
}
```

**Tradeoffs.** When the backend's spec is the ground truth, this closes the exact gap hand-maintained frontend types can't: the generated types and the generated request functions can never drift from what the backend actually documents, because they're produced from the same artifact a backend engineer already has to keep current for the spec to be useful at all. Regenerating after a backend change is typically one CLI command wired into CI. The cost is a build-time dependency on the spec being both present and *complete* — a spec with gaps generates a client with the same gaps, silently — plus a generation step in the toolchain, less control over the exact shape of the generated code (naming conventions, how errors are typed) than hand-written functions give you, and a coupling: the frontend's types are now only as good as the backend's spec authoring discipline. This is directly relevant to AstriX specifically, not just as a hypothetical: [`docs/backend/09-api-design-and-external-providers.md`](../backend/09-api-design-and-external-providers.md) establishes that the backend already wires up `swagger-jsdoc` and serves a real OpenAPI document at `/api/docs` in non-production environments — the tooling for spec generation exists on the backend side. Checked directly against `client/package.json` and every file under `client/src`: there is no `openapi-typescript-codegen`, no `orval`, no reference to `/api/docs`, and no generated-client directory anywhere in the frontend. The honest answer, not an assumption: **AstriX's frontend does not consume the backend's generated Swagger spec at all.** `api.ts` and `types/api.type.ts` are entirely hand-maintained, independently of that spec. This gap is significant enough to return to directly in §7.

### (d) A typed RPC-style client — tRPC

tRPC (and similar typed-RPC approaches) skips HTTP-shaped request functions entirely: a TypeScript backend exposes "procedures" directly, and the frontend imports the backend's own router *type* (not a generated artifact — the actual TypeScript type) to get full end-to-end type inference on every call, including argument and return types, with zero code generation step and zero manually maintained types on either side.

```ts
// illustrative tRPC client call — requires a tRPC backend, which AstriX's REST/Express API is not
const workspace = await trpc.workspace.getById.query({ id: "42" });
// `workspace` is fully typed, inferred straight from the backend's own procedure definition
```

**Tradeoffs.** This is the strongest possible typing guarantee of the four — there's no spec to keep in sync and no generation step to forget to re-run, because the frontend and backend share the actual TypeScript types via a monorepo import, so a backend signature change is a compile error on the frontend the moment both are built together. The catch is architectural, not stylistic: tRPC requires the backend to *be* a tRPC server, exposing typed procedures directly, usually consumed from the same monorepo so the type import is possible at all. It doesn't retrofit onto an existing REST API without either running tRPC as a second protocol alongside it or rewriting the backend's surface. AstriX's backend is Express with conventional REST(-ish) routes and controllers (see [`docs/backend/09-api-design-and-external-providers.md`](../backend/09-api-design-and-external-providers.md) for the full REST-vs-RPC survey on the backend side) — there is no tRPC router anywhere in `backend/src`, and adopting it would mean building a second API surface, not adjusting the frontend alone. It's named here because it's a real, current (2026) answer to this same problem in TypeScript-full-stack shops, not because it's a realistic drop-in for AstriX's actual backend.

---

## 2. AstriX's Choice

AstriX uses **option (b)**: a single, module-level axios instance (`lib/axios-client.ts`) configured once with a base URL, a timeout, and `withCredentials: true`, carrying two interceptors (an auth-header attacher and a 401-triggered refresh-and-retry handler — the refresh mechanics themselves belong to [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md)), imported by every call site in the app. On top of that instance sits `lib/api.ts`: not a class, not a repository abstraction, just plain exported `async` functions — one function per backend endpoint, grouped into comment-delimited domain sections, each one calling `API.<verb>(...)` and returning `response.data` typed via a generic imported from `types/api.type.ts`. The base URL itself is resolved from a single environment variable, `VITE_API_BASE_URL`, read through Vite's `import.meta.env` and baked into the production bundle at build time — not something the running app can change at runtime. Nothing here is generated from the backend's OpenAPI spec; every type in `api.type.ts` is hand-written and hand-kept-in-sync with what the backend actually returns.

---

## 3. AstriX Implementation

### 3.1 `base-url.ts` — the whole file

```ts
// client/src/lib/base-url.ts:1
export const baseURL = import.meta.env.VITE_API_BASE_URL;
```

One line. `import.meta.env` is Vite's replacement for Node's `process.env` in browser-targeted code — Vite statically replaces `import.meta.env.VITE_API_BASE_URL` with the literal value of that environment variable *at build time*, not at runtime. The `VITE_` prefix is not a naming convention AstriX invented; it's a Vite requirement — only environment variables prefixed `VITE_` are exposed to client-side code at all, specifically so a `.env` file full of build-only secrets (a deploy token, a database URL used only by server-side tooling) doesn't accidentally get inlined into a bundle any browser can download and read. `client/.env.example` documents the expected local value:

```
VITE_API_BASE_URL="http://localhost:8000/api"
```

### 3.2 `axios-client.ts` — the whole file, interceptors included

```ts
// client/src/lib/axios-client.ts:1-138
import { useStoreBase } from "@/store/store";
import { baseURL } from "@/lib/base-url";
import { CustomError } from "@/types/custom-error.type";
import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";

const options = {
  baseURL,
  withCredentials: true, // CRITICAL: Sends cookies with every request
  timeout: 10000,
};

const API = axios.create(options);

// ============================================
// REFRESH TOKEN STATE
// ============================================

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}> = [];

const processQueue = (error: unknown, token: string | null = null) => {
  failedQueue.forEach((promise) => {
    if (error) {
      promise.reject(error);
    } else {
      promise.resolve(token!);
    }
  });
  failedQueue = [];
};

// ============================================
// REQUEST INTERCEPTOR
// ============================================

API.interceptors.request.use((config) => {
  const accessToken = useStoreBase.getState().accessToken;
  if (accessToken) {
    config.headers["Authorization"] = "Bearer " + accessToken;
  }
  return config;
});

// ============================================
// RESPONSE INTERCEPTOR - Auto Refresh
// ============================================

API.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };

    // Build custom error
    const data = error.response?.data as { errorCode?: string } | undefined;
    const customError: CustomError = {
      ...error,
      errorCode: data?.errorCode || "UNKNOWN_ERROR",
    };

    // Only handle 401 errors
    if (error.response?.status !== 401) {
      return Promise.reject(customError);
    }

    // Don't retry refresh endpoint itself
    if (originalRequest.url?.includes("/auth/refresh")) {
      useStoreBase.getState().clearAuth();
      window.location.href = "/sign-in";
      return Promise.reject(customError);
    }

    // Don't retry if already retried
    if (originalRequest._retry) {
      return Promise.reject(customError);
    }

    // If already refreshing, queue this request
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({
          resolve: (token: string) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            resolve(API(originalRequest));
          },
          reject: (err: unknown) => reject(err),
        });
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      // Call refresh endpoint - refresh token sent via cookie automatically
      const response = await axios.post(
        `${baseURL}/auth/refresh`,
        {},
        { withCredentials: true }
      );

      const { access_token } = response.data;

      // Update store
      useStoreBase.getState().setAccessToken(access_token);

      // Process queued requests
      processQueue(null, access_token);

      // Retry original request
      originalRequest.headers.Authorization = `Bearer ${access_token}`;
      return API(originalRequest);
    } catch (refreshError) {
      processQueue(refreshError, null);
      useStoreBase.getState().clearAuth();

      // Redirect to login (unless already on auth pages)
      const currentPath = window.location.pathname;
      if (
        !currentPath.includes("/sign-in") &&
        !currentPath.includes("/sign-up")
      ) {
        window.location.href = "/sign-in";
      }

      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
);

export default API;
```

This entire flow — token attachment, the refresh queue, reuse of a single in-flight refresh call, the redirect-to-sign-in fallback — is *auth* behavior riding on top of an HTTP-client architecture, and it's covered in full, mechanism by mechanism, in [`06-authentication-and-authorization-ui.md`](./06-authentication-and-authorization-ui.md). What matters for this chapter is narrower: this is the **one and only** place in the entire `client/src` tree where `axios.create()` is called for talking to AstriX's own API. Every function in `api.ts`, and every React Query hook built on top of those functions, funnels through this single configured instance — there is no second axios instance anywhere, no call site that constructs its own headers or base URL. That singularity is the whole architectural point, and §5 explains why it matters more than it might look at first glance.

### 3.3 `api.ts` — the function-per-endpoint layer, by domain

`api.ts` imports the shared `API` instance and nothing else that talks to the network. Every export follows the same shape: build (or accept) a path, optionally shape a request body, call `API.<verb>(...)`, and return `response.data`, typed via a generic imported from `types/api.type.ts`. There is no class, no shared "repository" object, no per-endpoint retry or caching logic — each function is a few lines and does exactly one thing.

**Auth and user endpoints:**

```ts
// client/src/lib/api.ts:1-125
import API from "./axios-client";
import {
  AllMembersInWorkspaceResponseType,
  AllProjectPayloadType,
  AllProjectResponseType,
  AllTaskPayloadType,
  AllTaskResponseType,
  AnalyticsResponseType,
  ChangePasswordType,
  ChangeWorkspaceMemberRoleType,
  CreateProjectPayloadType,
  CreateTaskPayloadType,
  CreateWorkspaceResponseType,
  DeleteAccountType,
  EditProjectPayloadType,
  EditTaskPayloadType,
  ForgotPasswordType,
  GetSessionsResponseType,
  MessageResponseType,
  ProjectByIdPayloadType,
  ProjectResponseType,
  RemoveWorkspaceMemberType,
  ResetInviteCodeResponseType,
  ResetPasswordType,
  UpdateProfileType,
  VerifyEmailType,
} from "../types/api.type";
import {
  AllWorkspaceResponseType,
  CreateWorkspaceType,
  CurrentUserResponseType,
  LoginResponseType,
  loginType,
  registerType,
  WorkspaceByIdResponseType,
  EditWorkspaceType,
} from "@/types/api.type";

export const loginMutationFn = async (
  data: loginType
): Promise<LoginResponseType> => {
  const response = await API.post("/auth/login", data);
  return response.data;
};

export const registerMutationFn = async (data: registerType) =>
  await API.post("/auth/register", data);

// Update logout to return proper type
export const logoutMutationFn = async (): Promise<{ message: string }> => {
  const response = await API.post("/auth/logout");
  return response.data;
};

export const logoutAllMutationFn = async (): Promise<MessageResponseType> => {
  const response = await API.post("/auth/logout-all");
  return response.data;
};

export const forgotPasswordMutationFn = async (
  data: ForgotPasswordType
): Promise<MessageResponseType> => {
  const response = await API.post("/auth/forgot-password", data);
  return response.data;
};

export const resetPasswordMutationFn = async (
  data: ResetPasswordType
): Promise<MessageResponseType> => {
  const response = await API.post("/auth/reset-password", data);
  return response.data;
};

export const verifyEmailMutationFn = async (
  data: VerifyEmailType
): Promise<MessageResponseType> => {
  const response = await API.post("/auth/verify-email", data);
  return response.data;
};

export const resendVerificationEmailMutationFn =
  async (): Promise<MessageResponseType> => {
    const response = await API.post("/auth/resend-verification");
    return response.data;
  };

export const changePasswordMutationFn = async (
  data: ChangePasswordType
): Promise<MessageResponseType> => {
  const response = await API.post("/auth/change-password", data);
  return response.data;
};

export const getSessionsQueryFn =
  async (): Promise<GetSessionsResponseType> => {
    const response = await API.get("/auth/sessions");
    return response.data;
  };

export const revokeSessionMutationFn = async (
  sessionId: string
): Promise<MessageResponseType> => {
  const response = await API.delete(`/auth/sessions/${sessionId}`);
  return response.data;
};

export const getCurrentUserQueryFn =
  async (): Promise<CurrentUserResponseType> => {
    const response = await API.get(`/user/current`);
    return response.data;
  };

export const updateProfileMutationFn = async (
  data: UpdateProfileType
): Promise<CurrentUserResponseType> => {
  const response = await API.patch("/user/current", data);
  return response.data;
};

export const deleteAccountMutationFn = async (
  data: DeleteAccountType
): Promise<MessageResponseType> => {
  const response = await API.delete("/user/current", { data });
  return response.data;
};
```

**Workspace endpoints:**

```ts
// client/src/lib/api.ts:127-215
//********* WORKSPACE ****************
//************* */

export const createWorkspaceMutationFn = async (
  data: CreateWorkspaceType
): Promise<CreateWorkspaceResponseType> => {
  const response = await API.post(`/workspace/create/new`, data);
  return response.data;
};

export const editWorkspaceMutationFn = async ({
  workspaceId,
  data,
}: EditWorkspaceType) => {
  const response = await API.put(`/workspace/update/${workspaceId}`, data);
  return response.data;
};

export const getAllWorkspacesUserIsMemberQueryFn =
  async (): Promise<AllWorkspaceResponseType> => {
    const response = await API.get(`/workspace/all`);
    return response.data;
  };

export const getWorkspaceByIdQueryFn = async (
  workspaceId: string
): Promise<WorkspaceByIdResponseType> => {
  const response = await API.get(`/workspace/${workspaceId}`);
  return response.data;
};

export const getMembersInWorkspaceQueryFn = async (
  workspaceId: string
): Promise<AllMembersInWorkspaceResponseType> => {
  const response = await API.get(`/workspace/members/${workspaceId}`);
  return response.data;
};

export const getWorkspaceAnalyticsQueryFn = async (
  workspaceId: string
): Promise<AnalyticsResponseType> => {
  const response = await API.get(`/workspace/analytics/${workspaceId}`);
  return response.data;
};

export const changeWorkspaceMemberRoleMutationFn = async ({
  workspaceId,
  data,
}: ChangeWorkspaceMemberRoleType) => {
  const response = await API.put(
    `/workspace/change/member/role/${workspaceId}`,
    data
  );
  return response.data;
};

export const deleteWorkspaceMutationFn = async (
  workspaceId: string
): Promise<{
  message: string;
  currentWorkspace: string;
}> => {
  const response = await API.delete(`/workspace/delete/${workspaceId}`);
  return response.data;
};

export const removeWorkspaceMemberMutationFn = async ({
  workspaceId,
  memberId,
}: RemoveWorkspaceMemberType): Promise<MessageResponseType> => {
  const response = await API.delete(
    `/workspace/${workspaceId}/member/${memberId}`
  );
  return response.data;
};

export const leaveWorkspaceMutationFn = async (
  workspaceId: string
): Promise<MessageResponseType> => {
  const response = await API.post(`/workspace/${workspaceId}/leave`);
  return response.data;
};

export const resetInviteCodeMutationFn = async (
  workspaceId: string
): Promise<ResetInviteCodeResponseType> => {
  const response = await API.post(`/workspace/${workspaceId}/invite/reset`);
  return response.data;
};
```

**Member endpoint:**

```ts
// client/src/lib/api.ts:217-227
//*******MEMBER ****************

export const invitedUserJoinWorkspaceMutationFn = async (
  iniviteCode: string
): Promise<{
  message: string;
  workspaceId: string;
}> => {
  const response = await API.post(`/member/workspace/${iniviteCode}/join`);
  return response.data;
};
```

**Project endpoints:**

```ts
// client/src/lib/api.ts:229-295
//********* */
//********* PROJECTS
export const createProjectMutationFn = async ({
  workspaceId,
  data,
}: CreateProjectPayloadType): Promise<ProjectResponseType> => {
  const response = await API.post(
    `/project/workspace/${workspaceId}/create`,
    data
  );
  return response.data;
};

export const editProjectMutationFn = async ({
  projectId,
  workspaceId,
  data,
}: EditProjectPayloadType): Promise<ProjectResponseType> => {
  const response = await API.put(
    `/project/${projectId}/workspace/${workspaceId}/update`,
    data
  );
  return response.data;
};

export const getProjectsInWorkspaceQueryFn = async ({
  workspaceId,
  pageSize = 10,
  pageNumber = 1,
}: AllProjectPayloadType): Promise<AllProjectResponseType> => {
  const response = await API.get(
    `/project/workspace/${workspaceId}/all?pageSize=${pageSize}&pageNumber=${pageNumber}`
  );
  return response.data;
};

export const getProjectByIdQueryFn = async ({
  workspaceId,
  projectId,
}: ProjectByIdPayloadType): Promise<ProjectResponseType> => {
  const response = await API.get(
    `/project/${projectId}/workspace/${workspaceId}`
  );
  return response.data;
};

export const getProjectAnalyticsQueryFn = async ({
  workspaceId,
  projectId,
}: ProjectByIdPayloadType): Promise<AnalyticsResponseType> => {
  const response = await API.get(
    `/project/${projectId}/workspace/${workspaceId}/analytics`
  );
  return response.data;
};

export const deleteProjectMutationFn = async ({
  workspaceId,
  projectId,
}: ProjectByIdPayloadType): Promise<{
  message: string;
}> => {
  const response = await API.delete(
    `/project/${projectId}/workspace/${workspaceId}/delete`
  );
  return response.data;
};
```

**Task endpoints:**

```ts
// client/src/lib/api.ts:297-366
//*******TASKS ********************************
//************************* */

export const createTaskMutationFn = async ({
  workspaceId,
  projectId,
  data,
}: CreateTaskPayloadType) => {
  const response = await API.post(
    `/task/project/${projectId}/workspace/${workspaceId}/create`,
    data
  );
  return response.data;
};

export const editTaskMutationFn = async ({
  taskId,
  workspaceId,
  projectId,
  data,
}: EditTaskPayloadType) => {
  const response = await API.put(
    `/task/${taskId}/project/${projectId}/workspace/${workspaceId}/update/`,
    data
  );
  return response.data;
};

export const getAllTasksQueryFn = async ({
  workspaceId,
  keyword,
  projectId,
  assignedTo,
  priority,
  status,
  dueDate,
  pageNumber,
  pageSize,
}: AllTaskPayloadType): Promise<AllTaskResponseType> => {
  const baseUrl = `/task/workspace/${workspaceId}/all`;

  const queryParams = new URLSearchParams();
  if (keyword) queryParams.append("keyword", keyword);
  if (projectId) queryParams.append("projectId", projectId);
  if (assignedTo) queryParams.append("assignedTo", assignedTo);
  if (priority) queryParams.append("priority", priority);
  if (status) queryParams.append("status", status);
  if (dueDate) queryParams.append("dueDate", dueDate);
  if (pageNumber) queryParams.append("pageNumber", pageNumber?.toString());
  if (pageSize) queryParams.append("pageSize", pageSize?.toString());

  const url = queryParams.toString() ? `${baseUrl}?${queryParams}` : baseUrl;
  const response = await API.get(url);
  return response.data;
};

export const deleteTaskMutationFn = async ({
  workspaceId,
  taskId,
}: {
  workspaceId: string;
  taskId: string;
}): Promise<{
  message: string;
}> => {
  const response = await API.delete(
    `/task/${taskId}/workspace/${workspaceId}/delete`
  );
  return response.data;
};
```

Every route path used here is the exact RPC-flavored-or-resource-oriented path documented in [`docs/backend/09-api-design-and-external-providers.md`](../backend/09-api-design-and-external-providers.md) §3.1 — `api.ts` doesn't reinterpret or normalize the backend's URL shape, it mirrors it literally. `getAllTasksQueryFn` is the one function in the file with any real logic in its body: everything else is a one-line `API.<verb>()` call. Building the query string with `URLSearchParams` and only appending a param when it's truthy is a small but real design choice — it keeps the URL free of `?priority=&status=` noise for filters the caller didn't set, which matters for [`04-server-state-and-data-fetching.md`](./04-server-state-and-data-fetching.md)'s query-key conventions, since React Query keys typically embed exactly the variables a query was called with.

### 3.4 `types/api.type.ts` — a representative subset, not the whole file

`api.type.ts` is 330 lines and defines a type for essentially every request payload and response shape `api.ts` touches. Reproducing it in full would mostly restate what's already visible through the functions above; instead, here are the types actually consumed by three of the functions already shown — login (the simplest pair), workspace creation (a payload/response pair with a nested object), and the task list (the payload with the most optional fields and the richest response):

```ts
// client/src/types/api.type.ts:7-12
export type loginType = { email: string; password: string };
export type LoginResponseType = {
  message: string;
  access_token: string;
  user: UserType;
};
```

```ts
// client/src/types/api.type.ts:93-109
export type CreateWorkspaceType = {
  name: string;
  description: string;
};

export type EditWorkspaceType = {
  workspaceId: string;
  data: {
    name: string;
    description: string;
  };
};

export type CreateWorkspaceResponseType = {
  message: string;
  workspace: WorkspaceType;
};
```

```ts
// client/src/types/api.type.ts:314-330
export type AllTaskPayloadType = {
  workspaceId: string;
  projectId?: string | null;
  keyword?: string | null;
  priority?: TaskPriorityEnumType | null;
  status?: TaskStatusEnumType | null;
  assignedTo?: string | null;
  dueDate?: string | null;
  pageNumber?: number | null;
  pageSize?: number | null;
};

export type AllTaskResponseType = {
  message: string;
  tasks: TaskType[];
  pagination: PaginationType;
};
```

The pattern across all sixty-plus functions is the same as these three: a `*Type`/`*PayloadType` for whatever shape the function accepts, and a `*ResponseType` for whatever the backend actually returns, both hand-written by reading the backend's response shape rather than derived from it mechanically. `TaskPriorityEnumType`/`TaskStatusEnumType` (imported at the top of `api.type.ts` from `@/constant`) are shared string-literal enums mirrored from the backend's own enums by hand — another hand-synchronized pair, not a generated one, which is the same gap named in §1(c) and returned to in §7.

---

## 4. Request/Data Flow

Tracing one representative call end to end, tying every file above together, is more useful than restating each function's obvious one-line body. Take `getAllTasksQueryFn`, called from a React Query hook somewhere under `hooks/api/` (full hook-level detail in [`04-server-state-and-data-fetching.md`](./04-server-state-and-data-fetching.md)):

1. **A component mounts or a filter changes**, and a `useQuery` hook built on top of `getAllTasksQueryFn` fires (or refires, if its query key changed).
2. **`getAllTasksQueryFn` runs.** It destructures its `AllTaskPayloadType` argument, builds a `URLSearchParams` from whichever filters are actually set, and calls `API.get(url)` — `API` here is the *default export* of `axios-client.ts`, the one shared instance created once at module load.
3. **The request interceptor runs first**, before the request ever leaves the browser: it reads `useStoreBase.getState().accessToken` directly from the Zustand store (not from React props or context — interceptors run outside the component tree, so a module-level store read is the only option) and, if a token is present, sets the `Authorization` header. This happens for *every* call through `API`, including this one — `getAllTasksQueryFn` itself never touches auth at all; it's entirely the shared instance's job.
4. **The browser sends the request** to `baseURL + "/task/workspace/<id>/all?..."`, with `withCredentials: true` meaning the httpOnly refresh-token cookie rides along automatically even though this particular call doesn't need it (see §6).
5. **On success**, the response interceptor's fulfilled branch (`(response) => response`, a no-op pass-through) does nothing, and `getAllTasksQueryFn`'s `return response.data` hands back a value the TypeScript compiler already knows is shaped like `AllTaskResponseType` — `{ message, tasks, pagination }` — because that's the generic the function's return type promises. No runtime validation happens on this response; TypeScript's guarantee here is a compile-time contract between `api.ts` and its callers, not a runtime check that the backend actually sent that shape (contrast with the backend's own Zod-validated *incoming* requests, covered in [`docs/backend/05-validation-strategies.md`](../backend/05-validation-strategies.md) — nothing on the frontend re-validates *outgoing* trust in the response body).
6. **On a 401**, the response interceptor's rejected branch takes over — attempts a single shared token refresh, queues any other concurrently-failing requests behind that one refresh call, and retries the original request with the new token on success, or clears auth and redirects to `/sign-in` on failure. This exact mechanism is asserted directly by `client/src/lib/__tests__/axios-client.test.ts`, which mocks `axios.create` to capture the registered interceptor functions and drives them directly rather than performing a real network round trip:

```ts
// client/src/lib/__tests__/axios-client.test.ts:169-192
it("queues concurrent 401s behind a single in-flight refresh instead of firing one refresh per request", async () => {
  // #given two requests that both 401 while a refresh is already pending
  let resolveRefresh!: (value: { data: { access_token: string } }) => void;
  mockPost.mockReturnValue(
    new Promise((resolve) => {
      resolveRefresh = resolve;
    })
  );

  const errorA = buildError({ status: 401, url: "/task/1" });
  const errorB = buildError({ status: 401, url: "/task/2" });

  // #when both requests hit the interceptor before the refresh resolves
  const promiseA = responseErrorInterceptor(errorA);
  const promiseB = responseErrorInterceptor(errorB);

  // #then only ONE refresh call was made for both requests
  expect(mockPost).toHaveBeenCalledTimes(1);

  // #and once the single refresh resolves, both queued requests retry
  resolveRefresh({ data: { access_token: "shared-new-token" } });
  await Promise.all([promiseA, promiseB]);
  expect(useStoreBase.getState().accessToken).toBe("shared-new-token");
});
```

This test is worth pointing at directly because it's the clearest evidence in the codebase that the shared-instance architecture is load-bearing, not incidental: the "only one refresh call for N concurrent 401s" guarantee only holds because `isRefreshing`/`failedQueue` are module-level state on the *one* `axios-client.ts` module every caller imports. Two axios instances, or two copies of this module (a real risk the test file's own top comment calls out explicitly, explaining why it avoids `vi.resetModules()` per test), would each maintain independent refresh state and the "single in-flight refresh" guarantee would silently stop holding.

7. **`api.test.ts`**, by contrast, tests the boundary one layer up — that `api.ts`'s functions call the right method on the right URL, with `axios-client.ts` itself mocked out entirely:

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

The two test files divide the layer's responsibility cleanly along the same seam the architecture itself draws: `axios-client.test.ts` asserts the *cross-cutting* behavior (auth header attachment, refresh-and-retry, queuing) that only makes sense to test once, against the shared instance; `api.test.ts` asserts the *per-endpoint* behavior (does this function build the URL it claims to) that would be pointless to duplicate sixty times over — one representative example is enough to prove the pattern holds, since every other function in the file is structurally identical.

---

## 5. Design Decisions & Tradeoffs

**Why one shared axios instance instead of one per feature, or bare axios calls scattered across the app.** The alternative — importing bare `axios` directly in components or hooks and calling `axios.get(fullUrl, { headers: {...} })` inline — would mean re-deriving the base URL, the auth header, the timeout, and the 401-refresh logic at every single call site, or more realistically, most call sites *forgetting* to, since nothing enforces it. A single `axios.create()` instance, imported everywhere, makes "every authenticated request carries a fresh token" and "every 401 gets one refresh attempt, not a login-form dead-end" structural guarantees rather than per-call-site discipline. The cost of this choice is centralization risk: because `isRefreshing`/`failedQueue` are module-level state on one file, a bug in that file's interceptor logic is a bug for *every* API call in the app simultaneously, not an isolated one. That tradeoff — one seam to get right, but a wide blast radius if it's wrong — is exactly why `axios-client.test.ts` exists and why its concurrency test (§4) is worth taking seriously as documentation of the guarantee, not just as a regression check.

**Why plain functions instead of a class or a generated repository layer.** `api.ts` could have been a `WorkspaceApi` class, or a hand-rolled interface mimicking what option (c) in §1 would generate automatically. It isn't, and the reason is legible from the file itself: every function does exactly one thing — shape a path, optionally shape a body, call one verb, return typed data — and a class wrapper around that adds indirection (an instance to construct, methods to look up on a prototype) without adding capability, since there's no shared per-domain state a class would actually hold. Grouping by comment-delimited section (`//********* WORKSPACE`, `//*******TASKS`) rather than by file-per-domain is a real, visible tradeoff of its own: one 366-line file is easy to search end to end and impossible to lose track of, but it's also the one file in `lib/` most likely to produce a merge conflict when two engineers add endpoints in the same PR window, and nothing enforces that a new function actually lands under the right comment header — that's convention, not a compiler-checked constraint. What this shape deliberately does *not* provide, and this is worth stating plainly rather than treating as an oversight: no per-endpoint retry policy, no per-endpoint response caching, and no request deduplication live in `api.ts` at all. Those concerns exist in this codebase, but one layer up — React Query, covered in [`04-server-state-and-data-fetching.md`](./04-server-state-and-data-fetching.md), owns caching, staleness, retry predicates, and deduplication for every one of these functions once they're wrapped in a `useQuery`/`useMutation` hook. `api.ts`'s job stops at "make the call and return typed data"; the shared axios instance's job stops at "attach auth and handle 401s." Splitting caching/retry into a separate layer rather than building it into every function is a deliberate simplicity choice, and its cost is exactly what you'd expect: a function called directly (outside a React Query hook, which does happen in a few places in the codebase) gets none of that caching/retry benefit for free.

**Why the base URL is a build-time value, not a runtime one.** `base-url.ts` reads `import.meta.env.VITE_API_BASE_URL`, and Vite performs that substitution as a literal, static text replacement during `vite build` — the compiled JavaScript in `dist/` contains the actual URL string, not a reference to an environment variable a running server could look up later. [`docs/Architecture.md`](../Architecture.md) §5 traces exactly where that value comes from operationally: `deploy-frontend.yml` fetches it from AWS SSM Parameter Store (`/astrix/dev/VITE_API_BASE_URL`) as a build step, passes it as an env var to `npm run build`, and only *then* syncs the resulting static bundle to S3 and invalidates CloudFront. This is a materially different operational story from the backend's configuration, and it's worth being precise about the contrast rather than treating "env var" as one undifferentiated idea: the backend's SSM-sourced values are injected into the ECS task definition's `secrets`/environment block and read by a long-running Node process at container start (per `docs/Architecture.md` §2) — rotating one of those values means registering a new task definition and forcing a redeploy of the *existing* image, no rebuild required. The frontend's `VITE_API_BASE_URL`, by contrast, is compiled *into* the static assets themselves; changing it requires a full `npm run build` → `s3 sync --delete` → CloudFront invalidation cycle, because there's no running process to hand a new value to at all — the "server" for a static SPA is just files in a bucket. A frontend engineer who assumes "just flip the env var and restart" (a muscle memory built from backend work) will be wrong here in a way that costs real debugging time; §8 builds a debug drill directly around this distinction.

---

## 6. Security Considerations

**`withCredentials: true` is set once, globally, on the shared instance — every request carries it, whether or not that specific call needs a cookie.** The comment directly in the code (`// CRITICAL: Sends cookies with every request`) is accurate but incomplete without the CORS-side consequence: per the Fetch/XHR spec, a cross-origin request sent with credentials (cookies) can only succeed if the server's CORS response is equally explicit — a wildcard `Access-Control-Allow-Origin: *` is rejected by the browser outright when credentials are involved, the server must echo back a specific, exact origin, and it must also send `Access-Control-Allow-Credentials: true`. AstriX's backend does exactly this: [`docs/backend/03-middleware-and-request-pipeline.md`](../backend/03-middleware-and-request-pipeline.md) §3.4 shows `cors({ origin: allowedOrigins, credentials: true, ... })`, where `allowedOrigins` is always a real array of explicit origin strings (never a bare `"*"`, even when someone tries to configure it that way — see that file's own CORS-misconfiguration analysis). The two sides — `withCredentials: true` on the client, `credentials: true` plus an explicit origin allowlist on the server — are a matched pair; setting one without the other produces a broken, not insecure, CORS handshake, which is exactly the fails-closed behavior the backend file documents. The practical implication of setting `withCredentials` globally rather than per-call is that AstriX doesn't have (and doesn't need) two separate axios configurations for "calls that need the refresh cookie" versus "calls that don't" — every call already goes to the same, single, allowlisted origin, so there's no meaningful attack surface gained by sending the cookie on requests that don't strictly need it; the cookie is httpOnly and scoped to the API's own domain regardless.

**The base URL baked into the client bundle is public information, and that's fine — reasoned through explicitly rather than left unexamined.** Anyone who opens the browser's network tab, or simply views the bundled JavaScript source, can read the exact API origin AstriX's frontend talks to. This is not a secret leaking: an API's base URL is, definitionally, something every legitimate client must already know in order to function, and it's independently discoverable by anyone who just uses the deployed app and watches network requests — bundling it doesn't hand an attacker anything they couldn't get in thirty seconds of using the product normally. The things that would actually matter if leaked — the JWT secrets, the Mongo connection string, the Google OAuth client secret, the Resend API key — never touch the frontend bundle at all; they live exclusively in backend SSM parameters injected into the ECS task definition (`docs/Architecture.md` §2), a genuinely separate trust boundary from anything Vite compiles into `dist/`.

**Whether error responses leak backend implementation detail into the UI — checked directly, not assumed.** `CustomError` (`client/src/types/custom-error.type.ts`) is a thin `Error` extension carrying only an optional `errorCode` string; the response interceptor populates it from `error.response?.data?.errorCode`, defaulting to `"UNKNOWN_ERROR"` if the backend didn't supply one. The actual human-readable message a user sees runs through one of two paths in this codebase: a small number of components read `error.message` directly off the caught error (which, for an `AxiosError`, is axios's own generic string — e.g. `"Request failed with status code 400"` — not anything backend-sourced), while the majority go through `getErrorMessage()` (`client/src/lib/helper.ts:7-18`), which explicitly prefers `error.response?.data?.message` — the backend's own curated message — falling back to axios's generic `error.message` only if the backend didn't send one:

```ts
// client/src/lib/helper.ts:7-18
export const getErrorMessage = (
  error: unknown,
  fallback = "Something went wrong"
): string => {
  if (isAxiosError<{ message?: string }>(error)) {
    return error.response?.data?.message || error.message || fallback;
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
};
```

Either path is safe by construction, and the reason is upstream of the frontend entirely: [`docs/backend/04-error-handling-patterns.md`](../backend/04-error-handling-patterns.md) establishes that AstriX's centralized `errorHandler` *never* returns `error.stack` in any environment, and for every branch that could otherwise echo a raw internal error (a Mongoose `CastError`'s message, which would name the exact Mongoose model in play; a Mongo duplicate-key error, which would leak the colliding field value — an email address, for a duplicate-user conflict), the handler deliberately substitutes a generic, curated message instead. The generic 500 fallback goes one step further, replacing even `error.message` with the fixed string `"Unknown error occurred"` specifically in production. So `error.response.data.message`, wherever it's surfaced verbatim in a toast on the frontend, is never raw backend internals by the time it reaches the browser — the sanitization already happened at the source, one layer down, before the response was ever sent. What *is* a real, worth-naming inconsistency (a UX-consistency gap, not a security one) is that the two message-surfacing paths coexist: a handful of components (`create-workspace-form.tsx`, `edit-workspace-form.tsx`, and a few others) read `error.message` directly rather than routing through `getErrorMessage()`, which means a user hitting a validation error on one form sees the backend's actual, helpful `"Validation failed"`-style message via `getErrorMessage()`, while the same class of error on a different form might surface axios's own generic `"Request failed with status code 400"` instead — a real, inconsistent-but-not-insecure gap in this codebase.

---

## 7. Best Practice Check

**A single configured axios instance with interceptors remains a common, entirely defensible 2026 pattern** for a first-party SPA talking to one backend it controls. Nothing about this approach has gone stale — it's the same shape recommended in axios's own documentation today, and it's what the overwhelming majority of production React apps built without a meta-framework's built-in data layer still reach for. AstriX's version of it — one instance, module-level refresh-queue state, a request interceptor for auth and a response interceptor for refresh-and-retry — is idiomatic, not dated.

**The function-per-endpoint shape in `api.ts` is also a reasonable, current choice for a codebase this size**, and it stays reasonable specifically because caching/retry/dedup concerns are pushed one layer up into React Query rather than reimplemented per function — a codebase that tried to hand-roll that machinery inside sixty individual functions would be the actual antipattern, not this one.

**The genuine, worth-flagging gap is the hand-maintained types versus the backend's unused OpenAPI spec — and it deserves to be named plainly, not softened into a stylistic nitpick.** Section §1(c) already established the facts directly rather than assuming them: the backend genuinely does generate an OpenAPI document via `swagger-jsdoc`, serves it at `/api/docs` outside production, and — per [`docs/backend/09-api-design-and-external-providers.md`](../backend/09-api-design-and-external-providers.md) §3.2 — that spec's `components.schemas` are already populated with real, hand-written fragments for `User`, `Project`, `Task`, and their inputs. The frontend consumes none of it. `types/api.type.ts` is an entirely independent, hand-authored parallel description of the same shapes the backend's models and Mongoose schemas define, kept in sync by developer discipline alone — nothing fails a build, a lint, or a CI check if a backend response shape changes and `api.type.ts` isn't updated to match; the failure mode is a silent runtime mismatch (a field renamed on the backend, still referenced under its old name on the frontend, compiling cleanly because TypeScript is trusting a type annotation, not verifying it against a live response) discovered by a user seeing broken data, not by a type error at build time. This is precisely the "two sources of truth that can drift" pattern worth calling a real gap: it isn't that hand-written types are inherently wrong for a project this size — plenty of production SPAs run exactly this way successfully — it's that AstriX specifically already pays the cost of maintaining an OpenAPI-generating pipeline on the backend (the `swagger-jsdoc` wiring, the hand-written schema fragments) and currently gets zero frontend-typing benefit from that investment. Closing this gap wouldn't require adopting a new backend tool; it would mean pointing something like `openapi-typescript` or `openapi-typescript-codegen` at the backend's already-existing `/api/docs` spec and replacing (or cross-checking) `api.type.ts` against the generated output — made meaningfully more valuable once the backend's own gap, noted in that same chapter, of zero routes actually carrying `@swagger`/`@openapi` path annotations is closed, since a schema-only spec with no documented paths doesn't yet have request/response *operations* worth generating client functions from at all. The two gaps compound: the frontend doesn't consume the spec, and the spec doesn't yet document enough to be worth consuming.

---

## 8. Debug Drill

**Scenario:** a feature branch's API calls work perfectly in local development, pass code review, and then — after deploying — either every request fails with a CORS error in the browser console, or every request returns a `404`/connects to the wrong host entirely. Nothing changed in `api.ts` or `axios-client.ts` on this branch. Where do you look first, and why — as a transferable exercise for any SPA with a build-time-baked API base URL, not specific to any one incident?

1. **Confirm which of the two failure shapes you actually have, first.** A CORS error in the console (the request completing on the wire, but the browser refusing to hand the response to JavaScript) and a 404/connection failure (the request never reaching a real backend at all) point in almost opposite directions, and conflating them wastes the first several minutes of any investigation. Open the network tab: a genuine CORS block still shows a completed request with a response, just one the browser withheld from script; a 404 or connection-refused shows exactly that, with no CORS-policy message attached at all.

2. **If it's a wrong-host/404, suspect the build-time environment variable before anything else.** Because `base-url.ts` reads `import.meta.env.VITE_API_BASE_URL` and Vite substitutes that value once, at build time (§3.1, §5), the deployed bundle's API target is fixed at whatever `VITE_API_BASE_URL` resolved to during that specific `npm run build` invocation — not whatever the SSM parameter or environment currently holds. Check the actual build logs for the deploy that shipped this bundle and confirm what value was passed in; a parameter that was correct in SSM *after* the build ran, or a build that ran against the wrong environment's SSM path, produces exactly this symptom, and it will not self-correct until a fresh build runs.

3. **Rule out a stale bundle before assuming the config was wrong.** `deploy-frontend.yml` syncs `dist/` to S3 and then invalidates CloudFront (`docs/Architecture.md` §5) — if the invalidation step failed silently, was skipped, or simply hasn't propagated to every edge location yet, a browser can still be served an *old*, cached `index.html`/JS bundle built against a stale (or even a previous environment's) base URL, even though the most recent deploy's build step used the correct value. Force-refresh past any CDN/browser cache (or check the CloudFront invalidation's actual status) before concluding the build itself was misconfigured.

4. **If it's a genuine CORS rejection, compare the deployed frontend's actual origin — protocol, host, and any `www.`/subdomain difference — against the backend's `allowedOrigins` list byte for byte,** the same check [`docs/backend/03-middleware-and-request-pipeline.md`](../backend/03-middleware-and-request-pipeline.md) §8 walks through from the backend's side. Because `withCredentials: true` is set globally on the shared axios instance (§6), every request from this frontend requires the backend's CORS response to echo back an exact, matching origin — there is no wildcard fallback available once credentials are involved, by browser design, so an origin that's *almost* right (`https://app.example.com` deployed, `https://www.app.example.com` configured on the backend, or vice versa) fails completely rather than partially.

5. **Only after all of the above, suspect the interceptor code itself.** Because both `axios-client.ts`'s auth/refresh interceptors and `api.ts`'s per-endpoint functions are covered by the direct-interceptor and mocked-instance tests shown in §4, a genuine logic regression in either file is the least likely explanation for an environment-specific failure — those tests exercise the code's behavior independent of any real network or deployed environment, so if they're green, the bug is almost certainly in *what value the deployed environment gave this code to work with* (the build-time base URL, the deployed origin, the backend's CORS allowlist), not in the code's own logic.

The transferable lesson: whenever a bug reproduces in every deployed environment but never locally, and the affected code is a build-time-configured value (a base URL, a feature flag, anything Vite/webpack inlines as a literal at build time rather than reading at runtime), the fastest path to the real cause is almost always "what value did *this specific build* actually receive," not "what does the code do with that value" — the code is usually identical between local and deployed; the environment feeding it the value is what actually changed.
