# AstriX — How the Frontend and Backend Actually Connect

A dedicated walkthrough of every mechanism that ties `client/` to `backend/` together: network config, auth handoff, error contract, environment wiring, and what happens at each layer of a real request. This sits between Doc 3 (frontend) and Doc 4 (infra) — it's the "seam" between the two halves of the stack.

---

## 1. The Physical Connection — Two Separate Origins, Not One App

AstriX is **not** a single server rendering both API and UI. It's two independently deployed artifacts that talk over HTTP:

```
Browser
  │
  ├── loads static assets from ────► CloudFront + S3           (client/, built by `vite build`)
  │
  └── makes XHR/fetch calls to ────► ALB → ECS Fargate task     (backend/, Express API)
```

In local development this is mirrored, not simulated:
```
Vite dev server  (client, :5173)  ──HTTP──►  Express server  (backend, :8000)
```
`client/vite.config.ts` sets up **no dev proxy** — there's no `server.proxy` entry forwarding `/api` calls through the Vite dev server to the backend. Instead, the frontend always talks to a fully-qualified backend URL, controlled entirely by one environment variable:

```
# client/.env.example
VITE_API_BASE_URL="http://localhost:8000/api"
```

```ts
// client/src/lib/base-url.ts
export const baseURL = import.meta.env.VITE_API_BASE_URL;

// client/src/lib/axios-client.ts
const baseURL = import.meta.env.VITE_API_BASE_URL;
const API = axios.create({ baseURL, withCredentials: true, timeout: 10000 });
```
This means the frontend build is **environment-specific at build time** — a production build literally has the production API URL compiled into its JS bundle (Vite inlines `import.meta.env.VITE_*` at build time, it's not read at runtime). That's exactly why `deploy-frontend.yml` (Doc 4 §5.3) fetches `VITE_API_BASE_URL` from SSM Parameter Store and passes it as a build-time env var immediately before running `npm run build` — get this wrong and you'd ship a frontend bundle silently pointed at the wrong backend, with no runtime way to fix it short of rebuilding.

---

## 2. CORS — the Contract That Makes Cross-Origin Cookies Possible

Because frontend and backend live on **different origins** (`https://cdn-domain` vs `https://alb-domain`, or `localhost:5173` vs `localhost:8000` in dev), every cross-origin request needs explicit backend permission — this is what `cors()` in `backend/src/index.ts` configures:

```ts
app.use(cors({
  origin: config.FRONTEND_ORIGIN,     // exact frontend origin, NOT "*"
  credentials: true,                   // CRITICAL: allows cookies to be sent cross-origin
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
```

Two settings here are load-bearing, not boilerplate:
- **`origin` is a specific value, not `*`.** With `credentials: true`, the CORS spec *forbids* a wildcard origin outright — browsers will reject the response if a server tries to combine `Access-Control-Allow-Credentials: true` with `Access-Control-Allow-Origin: *`. This is why `FRONTEND_ORIGIN` must be set correctly per environment (dev: `localhost:5173`; prod: the actual CloudFront/custom domain) — get it wrong and every authenticated request silently fails in the browser with a CORS error, not an auth error.
- **`allowedHeaders` includes `Authorization`.** This is what lets the frontend attach `Authorization: Bearer <accessToken>` on every request (see §3) — without it explicitly listed, the browser's CORS preflight (`OPTIONS`) would reject the actual request before it's even sent.

---

## 3. The Dual-Token Handoff — Why Two Different Transport Mechanisms Are Used

This is the most important cross-cutting mechanism in the whole app, and it only makes sense when you see both sides together:

| Token | Where it's stored | How it crosses the wire | Why |
|---|---|---|---|
| **Access token** (15 min) | In-memory only, Zustand store (Doc 3 §4.1) | `Authorization: Bearer <token>` header, attached by an axios request interceptor | Never touches `localStorage`/cookies → immune to being read by an XSS payload |
| **Refresh token** (7 days) | httpOnly cookie, set by the backend | Automatic — the browser attaches it to every request to the API origin because of `withCredentials: true` on the client and `credentials: true` in CORS | httpOnly means client-side JS (and therefore XSS) **cannot read it at all**, even though it can still be silently used by the browser |

```ts
// backend sets it on login/refresh (config.COOKIE from app.config.ts)
res.cookie(config.COOKIE.REFRESH_TOKEN_NAME, refreshToken, {
  httpOnly: config.COOKIE.HTTP_ONLY,   // true
  secure: config.COOKIE.SECURE,        // see Security doc — currently inverted, flagged there
  sameSite: config.COOKIE.SAME_SITE,   // "lax"
  path: config.COOKIE.PATH,
});
```
```ts
// frontend automatically sends it back, no code needed beyond this axios option:
const API = axios.create({ baseURL, withCredentials: true });
```
The split exists specifically so that **no single XSS payload can steal a token that's both long-lived and usable to mint new access tokens** — an attacker who injects JS can read the in-memory access token (bad, but it expires in 15 minutes and can't be used to get a new one), but cannot read the httpOnly refresh cookie at all.

---

## 4. The Silent-Refresh Handshake — Full Sequence Across Both Sides

This is the concrete mechanism by which a page refresh doesn't log the user out, even though the access token is never persisted:

```
1. Browser loads the SPA fresh (access token in memory is now empty — Zustand isn't persisted)
2. First authenticated call fires (e.g. useAuth() → GET /api/user/current) with no Authorization header
3. Backend's JwtStrategy finds no/invalid Bearer token → responds 401
4. Frontend axios response interceptor catches the 401:
     - checks it's not already a retry, not the /auth/refresh endpoint itself
     - sets isRefreshing = true
     - POSTs to /auth/refresh with no body — but withCredentials:true means the
       httpOnly refresh cookie rides along automatically
5. Backend's refreshAccessTokenService (auth.service.ts):
     - verifies the refresh token signature (separate secret from access tokens)
     - looks up the Session document by sessionId, checks isValid + expiresAt
     - calls generateTokenPair() → new access token (+ refresh token, if rotation is enabled)
     - responds 200 with { access_token: "..." } in the JSON body
6. Frontend interceptor:
     - useStoreBase.getState().setAccessToken(newToken)   — updates the in-memory store
     - processQueue(null, newToken)                        — replays any requests queued during the refresh
     - retries the original failed request with the new Authorization header
7. Original GET /api/user/current now succeeds — the user appears "still logged in"
   even though nothing was ever read from localStorage.
```
This is the payoff of the axios single-flight-queue pattern documented in Doc 3 §6/§10.5 — it exists *specifically* to make this handshake safe when multiple components mount simultaneously and all fire their own 401 at once (e.g. `AuthProvider` fetching both the user and the workspace on initial load).

---

## 5. Request/Response Contract — Types, Not Just Endpoints

There's no shared package, no generated OpenAPI client, no tRPC/GraphQL schema — the contract between frontend and backend is **hand-maintained in parallel** on both sides:

```
Backend                                         Frontend
─────────────────────────────────────────────  ─────────────────────────────────────────
validation/task.validation.ts (Zod schema)  ↔   components/.../create-task-form.tsx (Zod schema, re-declared)
enums/role.enum.ts (Permissions, Roles)     ↔   constant/index.ts (same values, re-typed by hand)
models/task.model.ts (TaskDocument)         ↔   types/api.type.ts (TaskType, hand-written to match)
controllers/*.controller.ts response shape  ↔   lib/api.ts (typed fetch functions assuming that shape)
```
This works today because both sides are small enough for one person to keep in sync, but it is the single biggest structural risk to the frontend-backend seam as the app grows: **nothing enforces that these stay in sync**. If a backend field is renamed or a new required field is added to a Zod schema, the frontend's mirrored schema and TypeScript types won't catch it — you'd only find out at runtime, from a failed request or a subtly wrong-shaped object silently flowing through the UI. Doc "Roadmap" covers the concrete fix (a shared types package, or generating the frontend client from the backend's Swagger spec, which already exists at `/api/docs` and is currently unused for this purpose).

---

## 6. Error Contract Across the Wire

Backend's `errorHandler` (Doc 2 §3.6) always responds with a consistent JSON shape:
```json
{ "message": "...", "errorCode": "AUTH_UNAUTHORIZED_ACCESS" }
```
or, for Zod validation failures, a field-level error map. The frontend's axios interceptor normalizes **every** failure (network error, 401, 500, validation 400) into one `CustomError` shape before it ever reaches a component or a TanStack Query `error` object:
```ts
// types/custom-error.type.ts — consumed uniformly by every useQuery/useMutation's `error`
type CustomError = { message: string; errorCode?: string; status?: number };
```
This is why every page can render `{error?.message}` directly without each component needing to know whether the failure came from a network drop, a validation error, or an expired session — the interceptor has already flattened the backend's `AppError` hierarchy (Doc 2 §8.4) into one shape by the time it reaches UI code. It's the frontend mirror of the backend's own "one error shape out" design.

---

## 7. Environment Variable Wiring, End to End

This is the full chain from Terraform to a compiled JS bundle, since it's easy to lose track of where a config value actually originates:

```
Terraform (infra/environments/dev/*.tf, variables set per-environment)
   │
   ▼
SSM Parameter Store  (/astrix/dev/VITE_API_BASE_URL, /astrix/dev/JWT_ACCESS_TOKEN_SECRET, etc.)
   │
   ├──► ECS task definition pulls backend secrets from here at container start
   │     (via `secrets` block in the ECS task definition, referencing SSM ARNs)
   │
   └──► deploy-frontend.yml reads VITE_API_BASE_URL from here at BUILD time
         → passed as an env var to `npm run build`
         → Vite inlines it into the compiled JS bundle (baked in, not runtime-configurable)
```
Backend config is **runtime-configurable** (env vars read at container start, can change on redeploy without a rebuild); frontend config is **build-time-baked** (a Vite env var becomes a literal string in the bundle — changing it requires a rebuild + redeploy, not just an ECS restart). This asymmetry is a normal consequence of shipping a static SPA vs. a long-running server process, but it's worth being explicit about it, since "just change the env var" works for the backend and does **not** work for the frontend without a full CI run.

---

## 8. Summary Diagram — The Whole Seam in One Picture

```
┌─────────────────────────────┐        VITE_API_BASE_URL (baked at build)      ┌──────────────────────────────┐
│   client (React SPA)         │ ─────────────────────────────────────────────► │   backend (Express API)       │
│                               │                                                 │                                │
│  axios instance               │  Authorization: Bearer <access_token>  ──────► │  passport JwtStrategy          │
│   withCredentials: true       │                                                 │  (verifies sig + Session doc)  │
│                               │ ◄───────────── Set-Cookie: refresh_token ────── │                                │
│  Zustand (access token,       │      (httpOnly, sameSite=lax, path=/)          │  RBAC: roleGuard() per request │
│   in-memory only)              │                                                │                                │
│                               │  POST /auth/refresh (cookie auto-attached) ───► │  refreshAccessTokenService     │
│  TanStack Query (server        │ ◄──────────────── { access_token } ─────────── │  → new access token issued     │
│   cache, refetch-on-           │                                                │                                │
│   invalidate)                  │  CORS: origin=FRONTEND_ORIGIN, credentials=true (both sides must agree)         │
└─────────────────────────────┘                                                 └──────────────────────────────┘
```