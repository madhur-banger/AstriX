# Authentication & Authorization

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Backend](./00-master-backend-architecture.md).

Authentication answers "who is this?" Authorization answers "what are they allowed to do?" They are two different problems that get solved in the same request pipeline, and it's worth keeping them mentally separate even while reading code that handles both back to back — AstriX does, and conflating them is one of the easiest ways to introduce a security bug (e.g. checking "is this request signed by someone" and quietly assuming that also means "is this someone allowed to delete this workspace"). This chapter covers both: how AstriX decides a request carries a real, un-revoked identity, and how it decides what that identity is permitted to do once established.

> **Note on this revision:** AstriX's backend was migrated off MongoDB/Mongoose onto PostgreSQL (via Drizzle ORM) and Redis (via `ioredis`) — see [`backend/migrations/PLAN.md`](../../backend/migrations/PLAN.md) for the full six-phase history, and [`backend/migrations/phase-3-redis-migration-and-ttl-data.md`](../../backend/migrations/phase-3-redis-migration-and-ttl-data.md) specifically for why sessions and single-use tokens moved to Redis. Every Mongoose-era model this chapter used to describe — a `Session` collection with a TTL index, a `PasswordResetToken`/`EmailVerificationToken` collection pair, `mongoose.Types.ObjectId` payloads — no longer exists in this codebase. This chapter documents the auth system as it exists today, in Postgres and Redis, and notes the prior Mongo-era behavior explicitly as history where it matters for understanding *why* something is shaped the way it is — never as how the system behaves now.

---

## 1. The Landscape

Before looking at a single line of AstriX code, it's worth knowing the actual menu of ways a backend can answer "is this request authenticated," because the tradeoffs only make sense in contrast to each other. Four approaches dominate real systems, plus a fifth axis — delegated/federated login — that's orthogonal to all four.

### (a) Server-side sessions with a cookie

The classic web-app pattern, still extremely common: on login, the server creates a session record (in memory, Redis, or a database) keyed by a random session ID, and hands the browser that ID as an opaque `httpOnly` cookie. Every subsequent request, the server looks the ID up in the session store to find out who's making the request. `express-session` is the canonical Node implementation:

```js
// illustrative express-session usage — not AstriX code
app.use(session({
  secret: process.env.SESSION_SECRET,
  store: new RedisStore({ client: redisClient }),
  cookie: { httpOnly: true, secure: true, maxAge: 86400000 },
}));
```

**Tradeoffs:** revocation is trivial — delete the session record and the user is logged out instantly, everywhere that record was checked. The cost is that every request costs a store lookup, and a single in-memory session store doesn't survive a restart or scale horizontally — the moment you run more than one server process, you need a shared store (Redis, Postgres, Memcached) so any instance can validate any session, which is an extra piece of infrastructure to run and keep available.

### (b) Pure stateless JWT

A JSON Web Token is a signed (and optionally encrypted) claim — "this is user 123, issued at time T, expires at time T+N" — that the server can verify with nothing but a secret key and no database round trip at all. `passport-jwt` and countless tutorials use exactly this shape: the client holds the token, sends it on every request, and the server's only job is checking the signature and expiry.

```js
// illustrative jsonwebtoken usage — not AstriX code
const token = jwt.sign({ userId: user.id }, SECRET, { expiresIn: "1h" });
// later, on every request:
const payload = jwt.verify(req.headers.authorization.split(" ")[1], SECRET);
```

**Tradeoffs:** this is the cheapest option to run — verification is pure computation, no database, no shared store, trivially horizontally scalable. The cost is that it's *unrevocable* before expiry: there is no server-side record of the token at all, so "log this user out" or "this laptop was stolen, kill its access" cannot be enforced server-side. The best you can do is wait for the token to expire on its own, or maintain a deny-list of individually revoked tokens — which quietly reintroduces the exact server-side state this approach was chosen to avoid.

### (c) JWT access token + a long-lived refresh token, without rotation

A common middle ground: a short-lived JWT access token (minutes) is used for API calls, and a separate, longer-lived refresh token (days/weeks) is exchanged for new access tokens once the access token expires, so the user doesn't have to re-enter a password every 15 minutes. The refresh token is usually a stateless JWT too, and critically in this variant it is *reused* — the same refresh token is presented again and again until it expires on its own.

**Tradeoffs:** solves stateless JWT's "annoying re-login" problem without giving up much of its statelessness for the hot path (every API call still just needs signature verification). But it inherits the same core weakness one level up: if a refresh token is stolen, it's valid until its own (long) expiry, and there's no way to tell a legitimate client's refresh call from an attacker's — they're indistinguishable requests carrying the same bearer secret.

### (d) JWT access token + a rotating, single-use refresh token bound to a server-tracked session — what AstriX does

The pattern OAuth 2.0's Security Best Current Practice (BCP) recommends for public/native clients: every time a refresh token is used, it's invalidated and a brand-new refresh token is issued in its place, and the server keeps a record (a session) of which refresh token is currently valid for that session. Auth0's and Okta's refresh-token-rotation documentation describe exactly this shape. Because each refresh token can only be spent once, a server that sees the *previous* (already-spent) token presented again knows with certainty that two parties now hold tokens for the same session — the legitimate client that already rotated, and whoever stole the old one. That's *reuse detection*, and it lets the server kill the whole session proactively instead of just silently rejecting one request.

**Tradeoffs:** this gives you both revocability (there's a server-side session record to delete) and a stateless hot path (every ordinary API call still only needs JWT signature verification, no DB hit) — the session store only gets touched on the comparatively rare `/refresh` call. The cost is real implementation complexity: you now have to build and get right the rotation bookkeeping, the reuse-detection branch, and a session store with its own lifecycle (creation, expiry, cleanup) — none of which a plain stateless JWT needs.

### Delegated/federated auth — OAuth via a library vs. hand-rolled

Orthogonal to all four above is *how* the user proves who they are in the first place. Instead of a password, a backend can delegate identity verification to a third party (Google, GitHub, Microsoft) via OAuth 2.0 / OpenID Connect. Most Node backends reach for `passport` with a strategy plugin (`passport-google-oauth20`, `passport-github2`, ...), which wraps the authorization-code exchange, session serialization, and a lot of provider-specific edge cases behind a small, declarative API. AstriX doesn't use `passport` — its Google OAuth integration is a hand-rolled, ~90-line authorization-code exchange (`providers/google.provider.ts`, §3.7 below), a deliberate choice covered in §5.

---

## 2. AstriX's Choice

AstriX uses **option (d)**: a short-lived JWT access token (default 15 minutes) verified statelessly on every request, paired with a rotating, single-use refresh token bound to a session record that now lives in **Redis**, not a database table. Google OAuth is a second, parallel way to establish that same session — once a Google identity resolves to a user row, the rest of the pipeline (session creation, access/refresh tokens, cookie handling) is identical to email/password login. Authorization is a third, independent piece bolted onto the same request: a static, per-workspace role→permission map (`utils/role-permission.ts`), checked explicitly by whichever controller needs it via `roleGuard`.

None of this shape changed across the Postgres/Redis migration — `signJwtToken`/`verifyJwtToken`, the rotate-on-refresh design, and the reuse-detection kill-switch were never Mongo-specific ideas. What changed is **where session and token state physically live**: a Mongoose `Session` collection with a TTL index on `expiresAt`, and two near-duplicate `PasswordResetToken`/`EmailVerificationToken` collections, all with an application-level "is this actually expired yet" re-check because Mongo's TTL sweep runs on a ~60-second background cycle rather than expiring a document the instant it's read. Today, both are Redis structures with real, immediate key expiry — a session is a Redis **Hash** with a TTL, and a password-reset/email-verification token is a Redis **String** consumed exactly once via `GETDEL`. Neither needs, or has, a defensive re-check in application code — see §3.2.

---

## 3. AstriX Implementation

### 3.1 The session model: a Redis Hash, not a table row

`backend/src/services/redis/session.service.ts` is the whole of it — no `Session` model, no schema file, because a session isn't a Postgres table at all:

```ts
// backend/src/services/redis/session.service.ts:16-40
export const createSession = async (params: {
  userId: string;
  userAgent?: string;
  ipAddress?: string;
  refreshTokenHash: string;
}): Promise<string> => {
  const sessionId = randomUUID();
  const key = `session:${sessionId}`;

  await redis
    .multi()
    .hset(key, {
      userId: params.userId,
      userAgent: params.userAgent ?? "",
      ipAddress: params.ipAddress ?? "",
      isValid: "1",
      refreshTokenHash: params.refreshTokenHash,
      createdAt: new Date().toISOString(),
    })
    .expire(key, SESSION_TTL_SECONDS)
    .sadd(`user:${params.userId}:sessions`, sessionId)
    .exec();

  return sessionId;
};
```

A session lives at Redis key `session:<sessionId>` as a **Hash** — `userId`, `userAgent`, `ipAddress`, `isValid`, `refreshTokenHash`, `createdAt` as separate hash fields, matching the exact fields the old Mongoose `Session` model carried, minus the TTL-index-specific `expiresAt` field (Redis's own `EXPIRE key seconds` replaces it — there's no field for the database to sweep). `SESSION_TTL_SECONDS` is `7 * 24 * 60 * 60` (7 days), matching the default refresh-token lifetime. `redis.multi()` batches the `HSET` + `EXPIRE` + `SADD` into one round trip executed back-to-back with no other client's commands interleaved — not the same guarantee as a Postgres transaction (no rollback if one command fails after another succeeded), but enough to keep the hash and its index in sync under normal operation.

**The second key, `user:<userId>:sessions`, is a Redis Set** — the index that answers "list every session for this user," a query Postgres/Mongo would give you for free via a `WHERE userId = ...` scan or a compound index, but which Redis has no built-in way to answer without a hand-maintained structure. Every `createSession` call adds the new session ID to this set; every `invalidateSession` call removes it:

```ts
// backend/src/services/redis/session.service.ts:58-67
export const invalidateSession = async (
  sessionId: string,
  userId: string
): Promise<void> => {
  await redis
    .multi()
    .del(`session:${sessionId}`)
    .srem(`user:${userId}:sessions`, sessionId)
    .exec();
};
```

**The one sharp edge this design accepts, documented directly in the source:** the Set has no per-member TTL — only the `session:<id>` hash key expires on its own. If a session's hash key expires naturally (nobody ever calls `invalidateSession` on it) or something crashes between a session ending and its `SREM` running, the Set can transiently hold a session ID pointing at nothing. `listSessionsForUser` is the function that has to cope with this:

```ts
// backend/src/services/redis/session.service.ts:69-86
export const listSessionsForUser = async (
  userId: string
): Promise<SessionRecord[]> => {
  const ids = await redis.smembers(`user:${userId}:sessions`);
  const pipeline = redis.pipeline();
  ids.forEach((id) => pipeline.hgetall(`session:${id}`));
  const results = await pipeline.exec();

  // The Set has no per-member TTL, so it can transiently hold a stale
  // session ID after that session's key has already expired (Phase 3 §3.6)
  // - filter those out rather than surfacing an empty record.
  return (results ?? [])
    .map(([, data], i) => ({
      sessionId: ids[i],
      ...(data as Record<string, string>),
    }))
    .filter((s): s is SessionRecord => Object.keys(s).length > 1);
};
```

It fetches every ID the Set claims exists, `HGETALL`s each one in a pipeline, and filters out any result that came back empty (`hgetall` on a missing/expired key returns `{}`, which has only the injected `sessionId` field after the spread — length 1, filtered). This is the honest, stated tradeoff of building your own secondary index in a key-value store: **it isn't self-healing the way a relational index is** — a stale Set member gets silently swept the next time someone lists this user's sessions, not proactively.

`invalidateAllSessionsForUser` and `invalidateAllSessionsForUserExcept` — used by `logOutAllController` and by `changePasswordService`'s "kill every other device" step — are built directly on top of `listSessionsForUser`, fanning out one `invalidateSession` call per session, because Redis has no bulk "update every hash matching a pattern" primitive the way Mongo's `updateMany({ userId }, { isValid: false })` did:

```ts
// backend/src/services/redis/session.service.ts:91-106
export const invalidateAllSessionsForUser = async (userId: string): Promise<void> => {
  const sessions = await listSessionsForUser(userId);
  await Promise.all(sessions.map((s) => invalidateSession(s.sessionId, userId)));
};

export const invalidateAllSessionsForUserExcept = async (
  userId: string,
  keepSessionId: string
): Promise<void> => {
  const sessions = await listSessionsForUser(userId);
  await Promise.all(
    sessions.filter((s) => s.sessionId !== keepSessionId).map((s) => invalidateSession(s.sessionId, userId))
  );
};
```

### 3.2 Why no defensive expiry check anywhere in this code

The old Mongoose `Session` model needed application code to re-check `if (session.expiresAt < new Date())` after every read, because Mongo's TTL index deletes expired documents via a background sweep that runs roughly every 60 seconds — a document can be logically expired but still physically present, and returned by a plain query, for up to a minute after its `expiresAt` passed. Redis's key expiry has no equivalent gap: a `GET`/`HGETALL` on an expired key is treated as nonexistent the instant any command touches it (lazy expiry), backed by a separate active-expiry cycle that reclaims memory proactively regardless of whether anything reads the key. `getSession` above trusts this completely — `Object.keys(data).length === 0` is the only check it does, and it's checking "does this key exist at all," not "has enough time passed that I should distrust what came back." There is no defensive re-check anywhere in `auth.service.ts` or `session.service.ts`, and there doesn't need to be one.

### 3.3 Single-use tokens: `SET ... EX` + `GETDEL`, one service for two purposes

The old codebase had two near-identical Mongoose models — `PasswordResetToken` and `EmailVerificationToken` — differing only in TTL duration and which flow used them. Both collapse into one Redis-backed service, `backend/src/services/redis/token.service.ts`, in full:

```ts
// backend/src/services/redis/token.service.ts, in full
import { redis } from "../../redis/client";

export type TokenNamespace = "pwreset" | "emailverify";

export const storeToken = async (
  namespace: TokenNamespace,
  tokenHash: string,
  userId: string,
  ttlSeconds: number
): Promise<void> => {
  await redis.set(`${namespace}:${tokenHash}`, userId, "EX", ttlSeconds);
};

// GETDEL: atomic fetch-and-delete in one round trip - the Redis-native way
// to express "single use." A naive GET + DEL has a race window between the
// two calls where two concurrent consume attempts could both succeed;
// GETDEL closes it (Phase 3 §3.7).
export const consumeToken = async (
  namespace: TokenNamespace,
  tokenHash: string
): Promise<string | null> => {
  return redis.getdel(`${namespace}:${tokenHash}`);
};
```

A token lives as a plain Redis **String** at `pwreset:<tokenHash>` or `emailverify:<tokenHash>`, mapping directly to the `userId` it belongs to, with the TTL set atomically at creation via `SET key value EX seconds`. `consumeToken`'s `GETDEL` is the detail worth internalizing: it fetches the value and deletes the key in one atomic round trip. Two concurrent requests racing to consume the same reset link can't both succeed — the second `GETDEL` sees the key already gone and returns `null` — which a naive `GET` followed by a separate `DEL` cannot guarantee, since another client's read could land in the gap between the two calls. `auth.service.ts` never touches raw tokens; it only ever hashes them first:

```ts
// backend/src/services/auth.service.ts:52-56
const hashToken = (rawToken: string): string =>
  crypto.createHash("sha256").update(rawToken).digest("hex");
```

A raw token (the value embedded in the emailed reset/verification link) exists only in the client's hands and the request that generated it — only its SHA-256 hash is ever persisted to Redis, the same "don't store the secret in plaintext" discipline the old Mongoose models applied to the same data.

### 3.4 The full authentication flow: JWT signing, the request guard, and what `req.user` actually is

`backend/src/utils/jwt.ts` — trimmed during Phase 6's cutover to exactly what's still used; `generateTokenPair`, `verifyAccessTokenAndGetPayload`, `verifyAccessToken`, `verifyRefreshToken`, and the standalone `AccessTokenPayload`/`RefreshTokenPayload` types were all deleted as dead Mongo-only code no call site referenced anymore. What remains, in full:

```ts
// backend/src/utils/jwt.ts, in full
import jwt, { SignOptions, VerifyOptions } from "jsonwebtoken";
import { config } from "../config/app.config";

type SignOptsAndSecret = SignOptions & { secret: string };

const defaults: SignOptions = { audience: ["user"], algorithm: "HS256" };

export const accessTokenSignOptions: SignOptsAndSecret = {
  expiresIn: config.JWT.ACCESS_TOKEN_EXPIRES_IN || "15m",
  secret: config.JWT.ACCESS_TOKEN_SECRET,
};

export const refreshTokenSignOptions: SignOptsAndSecret = {
  expiresIn: config.JWT.REFRESH_TOKEN_EXPIRES_IN || "7d",
  secret: config.JWT.REFRESH_TOKEN_SECRET,
};

export const signJwtToken = <T extends object>(
  payload: T,
  options: SignOptsAndSecret = accessTokenSignOptions
): string => {
  const { secret, ...opts } = options;
  return jwt.sign(payload, secret, { ...defaults, ...opts });
};

export const verifyJwtToken = <T extends object>(
  token: string,
  secret: string = accessTokenSignOptions.secret,
  options?: VerifyOptions
): { valid: true; payload: T } | { valid: false; error: string } => {
  try {
    const payload = jwt.verify(token, secret, {
      audience: ["user"],
      algorithms: ["HS256"],
      ...options,
    }) as T;
    return { valid: true, payload };
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    return { valid: false, error: name === "TokenExpiredError" ? "Token expired" : "Invalid token" };
  }
};

export const extractBearerToken = (authHeader: string | undefined): string | null => {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
};
```

Two separate signing secrets (`JWT.ACCESS_TOKEN_SECRET`, `JWT.REFRESH_TOKEN_SECRET`) and two separate expiries (15 minutes, 7 days by default) — a stolen access token is useless within minutes even if the theft is never detected; a stolen refresh token is caught by reuse detection (§3.6) long before its own 7-day expiry would matter in practice. `signJwtToken`/`verifyJwtToken` are the only two functions anything in the codebase calls to produce or check a token — there's no separate "access" vs. "refresh" verification function, because the same `{ userId, sessionId }` payload shape and the same `verifyJwtToken` generic serve both, differing only in which secret and sign-options object is passed in.

The request guard, `backend/src/middlewares/auth.middleware.ts`, in full:

```ts
// backend/src/middlewares/auth.middleware.ts, in full
import { Request, Response, NextFunction } from "express";
import { extractBearerToken } from "../utils/jwt";
import { UnauthorizedException } from "../utils/appError";
import { authenticateAccessTokenService } from "../services/auth.service";

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    const token = extractBearerToken(authHeader);

    if (!token) {
      throw new UnauthorizedException("Token not found");
    }

    const { userId, sessionId } = await authenticateAccessTokenService(token);
    req.user = { id: userId, sessionId };

    next();
  } catch (error) {
    next(error);
  }
};
```

Every real check lives in `authenticateAccessTokenService` (`backend/src/services/auth.service.ts:492-522`), which the middleware just calls and trusts:

```ts
// backend/src/services/auth.service.ts:492-522
export const authenticateAccessTokenService = async (
  accessToken: string
): Promise<{ userId: string; sessionId: string }> => {
  const result = verifyJwtToken<TokenPayload>(accessToken, accessTokenSignOptions.secret);
  if (!result.valid) {
    throw new UnauthorizedException(result.error);
  }

  const { userId, sessionId } = result.payload;

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) {
    throw new UnauthorizedException("User not found");
  }
  if (!user.isActive) {
    throw new UnauthorizedException("User is not active");
  }

  const session = await getSession(sessionId);
  if (!session) {
    throw new UnauthorizedException("Session not found");
  }
  if (session.isValid !== "1") {
    throw new UnauthorizedException("Session has been revoked");
  }
  if (session.userId !== userId) {
    throw new UnauthorizedException("Invalid Session");
  }

  return { userId, sessionId };
};
```

Four independent checks, in order, each with its own reason to exist: the JWT signature/expiry check (stateless, no I/O); a live Postgres row for `userId` (a deleted account's still-valid, still-unexpired JWT must not authenticate — this is why authentication isn't *purely* stateless despite the access token itself being self-verifying); `user.isActive` (a deactivated-but-not-deleted account, a distinct state from "row doesn't exist"); and the Redis session's own `isValid`/`userId` fields (a session that's been explicitly revoked, or — defensively — a session hash whose `userId` field somehow doesn't match the token's claimed `userId`). Passing all four is what attaches `req.user = { id: userId, sessionId }` — a **plain object with two string fields**, per the `Express.Request` augmentation in `backend/src/@types/index.d.ts`:

```ts
// backend/src/@types/index.d.ts:3-10
interface Request {
  // Attached by the auth middleware (src/middlewares/auth.middleware.ts)
  // once a bearer token is verified against a real Postgres user + Redis
  // session - a plain id pair, not an ORM document.
  user?: { id: string; sessionId: string };
  log?: Logger;
}
```

Every controller that reads `req.user!.id` is reading a plain UUID string — not a Mongoose document's `_id` `ObjectId` requiring `.toString()` before it can be used as a plain identifier in a Drizzle `.where(eq(...))` clause, a real, if small, cleanup the migration produced at every one of these call sites.

### 3.5 Login, registration, and the timing-attack defense

`registerUserService` (`backend/src/services/auth.service.ts:90-143`) does the whole account-creation sequence — check for an existing email, hash the password, insert the `users` row, insert an `accounts` row with `provider: "EMAIL"`, look up the seeded `OWNER` role, create a default workspace, insert the owning `workspace_members` row, and backfill `currentWorkspaceId` — inside one `db.transaction(async (tx) => {...})`, so a failure partway through (say, the `OWNER` role somehow isn't seeded) leaves no half-created user/workspace pair behind. Sending the verification email happens **after** the transaction commits, deliberately outside it and wrapped in its own `try/catch` that only logs on failure — a `resend` API blip must not turn an otherwise-successful registration into a failed one, since the account already exists and the user can always request a new verification email later.

`verifyUserService` (`backend/src/services/auth.service.ts:156-188`) is where the login timing-attack defense lives:

```ts
// backend/src/services/auth.service.ts:149-172
const DUMMY_PASSWORD_HASH =
  "$2b$10$uoY4NVy6Uns2Luc7jnt9P.hOJUVlz40gP0G0Aunbvk.3vZ3w642ei";

export const verifyUserService = async ({ email, password }: { email: string; password: string }) => {
  const account = await findAccountByProviderService("EMAIL", email);

  if (!account) {
    await compareValue(password, DUMMY_PASSWORD_HASH);
    throw new UnauthorizedException("Invalid email or password");
  }
  // ...
};
```

If no `accounts` row exists for this email at all, the code still runs a full `bcrypt.compare` against a precomputed, hardcoded hash with no corresponding real password — burning the same ~bcrypt-cost-10 wall-clock time a genuine wrong-password comparison would take — before throwing the exact same `UnauthorizedException("Invalid email or password")` the wrong-password branch throws further down. Without this, "no such account" would return measurably faster than "account exists, wrong password," and a login endpoint that leaks that distinction (via response latency, not response body) is an email-enumeration oracle regardless of how identical the two error messages look on the wire. `requestPasswordResetService` applies the same principle at the response-shape level instead of the timing level — it returns the exact same "if an account exists, a reset link has been sent" response whether or not `email` matches a real user, silently no-op-ing on the not-found branch rather than distinguishing it.

### 3.6 Refresh: rotation and reuse-detection kill-switch

```ts
// backend/src/services/auth.service.ts:286-319
export const refreshAccessTokenService = async (
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string }> => {
  const result = verifyJwtToken<TokenPayload>(refreshToken, refreshTokenSignOptions.secret);
  if (!result.valid) {
    throw new UnauthorizedException(result.error);
  }

  const { userId, sessionId } = result.payload;

  const session = await getSession(sessionId);
  if (!session || session.isValid !== "1") {
    throw new UnauthorizedException("Session expired or invalid");
  }

  // Refresh tokens are single-use. A structurally valid token whose hash is
  // no longer the one this session is bound to has already been rotated
  // away - two parties hold tokens for this session, i.e. one was stolen.
  // Kill the session outright rather than just rejecting this one request.
  if (session.refreshTokenHash && session.refreshTokenHash !== hashToken(refreshToken)) {
    await invalidateSession(sessionId, userId);
    throw new UnauthorizedException("Refresh token reuse detected. Please log in again.");
  }

  const accessToken = signJwtToken<TokenPayload>({ userId, sessionId }, accessTokenSignOptions);
  const rotatedRefreshToken = signJwtToken<TokenPayload>({ userId, sessionId }, refreshTokenSignOptions);

  // Rotate in place on the SAME session: it (and the entry the user sees in
  // their device list) is continuous across refreshes - only the token
  // bound to it changes.
  await rotateSessionToken(sessionId, hashToken(rotatedRefreshToken));

  return { accessToken, refreshToken: rotatedRefreshToken };
};
```

The refresh token itself is a JWT (structurally verifiable, stateless), but whether *this specific* refresh token is still the live one for its session is checked against `session.refreshTokenHash` — the SHA-256 hash of the last refresh token actually issued for this session, stored in the Redis Hash. A structurally-valid, non-expired refresh token whose hash doesn't match is unambiguous evidence of reuse: exactly one refresh token is ever the "current" one for a session, so if the token presented isn't it, whoever's presenting it either stole an already-rotated-away token, or is racing the legitimate client. Either way, the response is the same — `invalidateSession` kills the *entire* session outright, not just this one request, forcing a fresh login. `changePasswordService`, `resetPasswordService`, and `logOutAllController` all reuse this exact `invalidateSession`/`invalidateAllSessionsForUser(Except)` machinery — a password change invalidates every *other* session (the caller's current one survives, since they just proved who they are by supplying the current password), while a password *reset* (via emailed token, no current-session context) invalidates every session unconditionally, on the theory that the flow was likely triggered by a suspected compromise.

### 3.7 Google OAuth: the full account-linking logic

`providers/google.provider.ts` is a hand-rolled ~90-line OAuth2 authorization-code exchange — no `passport`, no strategy plugin:

```ts
// backend/src/providers/google.provider.ts:34-88, condensed
export const getGoogleAuthorizationUrl = (state: string): string => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", config.GOOGLE_CALLBACK_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "profile email");
  url.searchParams.set("state", state);
  return url.toString();
};

export const exchangeGoogleCodeForProfile = async (code: string): Promise<OAuthProfile> => {
  // POSTs the code to Google's token endpoint, then GETs the userinfo
  // endpoint with the resulting access token.
  // ...
  return {
    provider: "GOOGLE",
    providerId: googleProfile.sub,
    email: googleProfile.email,
    name: googleProfile.name,
    picture: googleProfile.picture,
    // Conservative default: a missing field is treated as NOT verified,
    // never assumed verified.
    emailVerified: googleProfile.email_verified === true,
  };
};

export const generateGoogleOAuthState = (): string => crypto.randomBytes(32).toString("hex");
```

`generateGoogleOAuthState` produces the CSRF `state` value; `GET /api/auth/google` (`routes/auth.route.ts`) sets it as a short-lived (10-minute), `httpOnly` cookie before redirecting to Google, and `googleCallbackController` (`controllers/auth.controller.ts:100-136`) checks the `state` query param against that cookie before doing anything else — a callback whose `state` doesn't match the cookie is rejected with a `401` before the authorization `code` is ever exchanged, closing the standard OAuth CSRF hole where an attacker tricks a victim's browser into completing *the attacker's* OAuth flow under the victim's session.

The actual account-linking decision lives in `loginOrCreateAccountService` (`backend/src/services/auth.service.ts:194-280`), inside one `db.transaction`:

1. **Look up `accounts` by `(provider, providerId)` first.** If a Google identity has already logged in before, this is a direct hit — return its linked `users` row, no further decision needed.
2. **No existing `accounts` row — look up `users` by email.** If a `users` row with this email already exists (created via email/password signup, or a different OAuth provider), this is the account-linking decision point:
   ```ts
   // backend/src/services/auth.service.ts:223-234
   if (user) {
     if (!emailVerified) {
       throw new UnauthorizedException(
         "This email is already registered. Log in with your password, or verify this email with your provider first."
       );
     }
   }
   ```
   Auto-linking a brand-new Google identity to a **pre-existing** account happens only if `emailVerified` is `true` — meaning Google itself confirmed the user controls that email address (`google.provider.ts`'s `email_verified === true`, defaulting to `false` on a missing field). Without that confirmation, the code refuses to link: there's no way to distinguish "this is genuinely the same person logging in with a new method" from "someone typed in an email address they don't control, hoping to hijack an existing account," so it refuses rather than risk granting login access to the wrong account.
3. **No `users` row at all — create one.** A brand-new user is always fine to create regardless of `emailVerified`'s value (there's no pre-existing account at risk of being hijacked), including its own default workspace, `OWNER` role membership, and `currentWorkspaceId` backfill — the same sequence `registerUserService` runs for email/password signup.
4. **Insert the new `accounts` row** (`provider`, `providerId`) linking this OAuth identity to whichever `users` row the above resolved to, and return it.

`googleCallbackController` then runs the exact same `createSessionService` (§3.8) any other login path runs — from the session layer's perspective, an OAuth login and a password login are indistinguishable once a `userId` has been resolved.

### 3.8 Shared session creation and per-workspace RBAC (unchanged by the migration)

```ts
// backend/src/services/auth.service.ts:68-84
export const createSessionService = async ({
  userId,
  userAgent,
  ipAddress,
}: CreateSessionParams): Promise<TokenPairWithSession> => {
  // A placeholder refresh-token hash is written first so the session id -
  // which the token payload has to carry - exists before the real token can
  // be signed.
  const sessionId = await createSession({ userId, userAgent, ipAddress, refreshTokenHash: "" });

  const accessToken = signJwtToken<TokenPayload>({ userId, sessionId }, accessTokenSignOptions);
  const refreshToken = signJwtToken<TokenPayload>({ userId, sessionId }, refreshTokenSignOptions);

  await rotateSessionToken(sessionId, hashToken(refreshToken));

  return { accessToken, refreshToken, sessionId };
};
```

Both login paths (`loginController`, `googleCallbackController`) call this one function; the refresh token is set as an `httpOnly` cookie (`setRefreshTokenCookie` in `controllers/auth.controller.ts`), and the access token goes in the JSON response body for the client to hold and send as a bearer token.

Authorization is a genuinely separate system, entirely static and entirely unaffected by the database migration — it never touched Mongo or Postgres, since it's just a hardcoded TypeScript map:

```ts
// backend/src/utils/role-permission.ts, in full
import { Permissions, PermissionType, RoleType } from "../enums/role.enum";

export const RolePermissions: Record<RoleType, Array<PermissionType>> = {
  OWNER: [
    Permissions.CREATE_WORKSPACE, Permissions.EDIT_WORKSPACE, Permissions.DELETE_WORKSPACE,
    Permissions.MANAGE_WORKSPACE_SETTINGS, Permissions.ADD_MEMBER, Permissions.CHANGE_MEMBER_ROLE,
    Permissions.REMOVE_MEMBER, Permissions.CREATE_PROJECT, Permissions.EDIT_PROJECT,
    Permissions.DELETE_PROJECT, Permissions.CREATE_TASK, Permissions.EDIT_TASK,
    Permissions.DELETE_TASK, Permissions.VIEW_ONLY,
  ],
  ADMIN: [
    Permissions.ADD_MEMBER, Permissions.CREATE_PROJECT, Permissions.EDIT_PROJECT,
    Permissions.DELETE_PROJECT, Permissions.CREATE_TASK, Permissions.EDIT_TASK,
    Permissions.DELETE_TASK, Permissions.MANAGE_WORKSPACE_SETTINGS, Permissions.VIEW_ONLY,
  ],
  MEMBER: [Permissions.VIEW_ONLY, Permissions.CREATE_TASK, Permissions.EDIT_TASK],
};
```

```ts
// backend/src/utils/roleGuard.ts, in full
export const roleGuard = (
  role: keyof typeof RolePermissions,
  requiredPermissions: PermissionType[]
) => {
  const permissions = RolePermissions[role];
  const hasPermission = requiredPermissions.every((permission) => permissions.includes(permission));
  if (!hasPermission) {
    throw new ForbiddenException("You do not have the necessary permissions to perform this action");
  }
};
```

`roleGuard` is called explicitly, inline, by every controller that needs an authorization check — never centrally, and never as its own middleware — right after resolving the caller's role for the target workspace via `getMemberRoleInWorkspace` (`backend/src/services/member.service.ts:8-25`), which does a Drizzle `innerJoin` between `workspace_members` and `roles`:

```ts
// backend/src/services/member.service.ts:8-25
export const getMemberRoleInWorkspace = async (userId: string, workspaceId: string) => {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) {
    throw new NotFoundException("Workspace not found");
  }

  const [member] = await db
    .select({ roleName: roles.name })
    .from(workspaceMembers)
    .innerJoin(roles, eq(workspaceMembers.roleId, roles.id))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)));

  if (!member) {
    throw new UnauthorizedException("You are not a member of this workspace");
  }

  return { role: member.roleName };
};
```

The other real piece of `member.service.ts`, `joinWorkspaceByInviteService`, is the concrete example of the "pre-check, then trust the database constraint as the real guard" pattern this codebase uses throughout: it explicitly checks for an existing membership before inserting, then still wraps the `INSERT` in a `try/catch` for Postgres error code `23505` (unique violation on the `(workspaceId, userId)` compound index) — the actual race guard against two concurrent join requests, since the pre-check alone has a window between the read and the write:

```ts
// backend/src/services/member.service.ts:51-60
try {
  await db.insert(workspaceMembers).values({ userId, workspaceId: workspace.id, roleId: role.id });
} catch (error) {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "23505") {
    throw new BadRequestException("You are already a member of this workspace");
  }
  throw error;
}
```

---

## 4. Request/Data Flow

### (a) Login

`POST /api/auth/login` → `authLimiter` (5 attempts / 15 min, `skipSuccessfulRequests: true` — a login that succeeds doesn't count against the limit) → `loginController` → `loginSchema.parse(req.body)` → `verifyUserService` (§3.5, including the dummy-hash timing defense on a miss) → `createSessionService` (§3.8: new Redis session, JWT pair) → `setRefreshTokenCookie` (httpOnly, `secure` outside development, `sameSite: "lax"`) → `200` with `{ access_token, user }` in the body.

### (b) An authenticated request to a protected route

`GET /api/workspace/:id` (any protected route mounted behind `authenticate` in `app.ts`) → `extractBearerToken` pulls the token out of `Authorization: Bearer <token>` → `authenticateAccessTokenService`'s four checks in order (§3.4: JWT valid → user exists → user active → Redis session valid and matching) → `req.user = { id, sessionId }` attached → route's own controller runs, typically calling `getMemberRoleInWorkspace` + `roleGuard` before touching the actual resource.

### (c) Refresh, including the reuse-detection branch

`POST /api/auth/refresh`, refresh token read from the `refresh_token` cookie → `refreshLimiter` (30/15min) → `refreshTokenController` → `refreshAccessTokenService` (§3.6). Two branches: a normal rotation returns a new access token and sets a new refresh-token cookie; a **reused** (already-rotated-away) refresh token invalidates the entire session and returns `401` with `"Refresh token reuse detected. Please log in again."` — the controller's `catch` block also clears the refresh-token cookie client-side either way, so a rejected refresh never leaves a client holding a cookie it'll just get rejected again on the next attempt.

### (d) Password reset

`POST /api/auth/forgot-password` → `passwordResetLimiter` → `requestPasswordResetService`: looks up the user, silently no-ops if not found, otherwise generates a random 32-byte token, hashes it, stores the hash in Redis (`pwreset:<hash>` → `userId`, TTL from `PASSWORD_RESET_TOKEN_EXPIRES_IN`, default 30 minutes), emails the raw token as a link. Response is identical either way. `POST /api/auth/reset-password` → `resetPasswordService`: `consumeToken("pwreset", hash(token))` — a `GETDEL`, so a reused link fails the second time with the same `UnauthorizedException` a garbage token would — then updates `passwordHash` and calls `invalidateAllSessionsForUser`, logging out every device unconditionally.

---

## 5. Design Decisions & Tradeoffs

**Why rotating refresh tokens with reuse detection, not plain long-lived JWTs.** AstriX's workspace/task data is exactly the kind of thing a stolen session should not have standing access to indefinitely — the alternative (landscape option (b)/(c)) trades this real security property for less implementation complexity, and the team decided the tradeoff wasn't worth it for an app whose entire value proposition is trusted collaborative data. The cost paid for it is concrete and visible in §3.6: a `session.refreshTokenHash` field to maintain, a reuse-detection branch that has to run on every refresh, and a session store with a real create/rotate/invalidate lifecycle instead of "nothing to manage."

**Why Redis for sessions and tokens instead of a Postgres table.** This is the one piece of this chapter's design that the migration actually changed, and the reasoning (`backend/migrations/phase-3-redis-migration-and-ttl-data.md` §3.2) is worth restating precisely: a session or a single-use token is fundamentally a short-lived, access-pattern-simple record whose entire lifecycle is "exists, gets read a few times, then needs to disappear on a timer" — exactly Redis's design center (native key `TTL`, immediate expiry with no sweep delay), and a worse fit for a relational table (which would need an `expires_at` column, a cron job or a Postgres extension to actually delete expired rows, and defensive re-checks in application code the way the old Mongo TTL index needed). The cost, named directly in §3.1 and §3.6 above, is that Redis gives up "query by any field for free" — a session lookup by `userId` needed a hand-built, hand-maintained Set index that a relational table's own B-tree index would have given for free, and that index is not self-healing.

**Why the same session (not a fresh one) survives a refresh.** `rotateSessionToken` updates the existing `session:<id>` hash's `refreshTokenHash` field in place rather than deleting the old session and creating a new one — deliberately, so the entry a user sees in a "manage your devices" UI (`getUserSessionsService` → `GET /api/auth/sessions`) stays continuous across refreshes; only the token bound to it changes. A design that created a fresh session ID on every refresh would make "which of these five sessions is this browser tab" unanswerable from the client's perspective.

**Why authorization is checked inline per-controller rather than as shared middleware.** This mirrors the tradeoff already named in [`01-architecture-patterns-and-project-structure.md`](./01-architecture-patterns-and-project-structure.md) §6: `getMemberRoleInWorkspace` + `roleGuard` is repeated, by hand, in every controller function that needs a workspace-scoped permission check, rather than being enforced by one router-level middleware the way `authenticate` is. That's workable today because there are relatively few workspace-scoped write routes and every existing one remembers the pattern — but nothing in the layered structure *enforces* that a new route added later includes it; there's no compiler error or shared base controller that would catch an author who forgets.

---

## 6. Security Considerations

**Refresh-token reuse detection is the load-bearing defense against token theft, and it fails closed.** If a stolen refresh token is used before the legitimate client rotates, the *legitimate* client's next refresh attempt is the one that gets rejected as "reuse" (its token was already spent by the attacker) — an intentional, if occasionally user-visible, cost: it means the account owner gets logged out and has to re-authenticate, which is a strictly better outcome than an attacker retaining silent, undetected access.

**The Google OAuth `state` cookie is the CSRF defense for the entire OAuth flow**, and it's checked before anything else in `googleCallbackController` — before the authorization code is even exchanged with Google. The cookie is `httpOnly` and capped at a 10-minute `maxAge`, narrowing the window an attacker has to force a victim's browser through a crafted OAuth redirect.

**The `emailVerified`-gated auto-link rule is the entire defense against an OAuth-based account-takeover vector.** Without it, an attacker who controls a Google (or any OAuth-provider) account claiming to own `victim@example.com` — trivial if the provider doesn't itself verify email ownership, or if a provider's `email_verified` field is spoofable in a misconfigured integration — could "log in" via OAuth and be silently linked to the victim's existing password-based account, gaining full access to it. Gating the auto-link on the *provider's own* `emailVerified` confirmation (never trusting a client-supplied claim) is what closes that hole; `google.provider.ts` defaults `emailVerified` to `false` on any missing/falsy field from Google's response specifically so a malformed or unexpected API response fails closed (refuses to link) rather than open.

**Password hashes never reach a response**, by explicit column-list discipline, not a schema-level flag: `verifyUserService` and `loginOrCreateAccountService` both destructure `passwordHash` out of the return value (`const { passwordHash: _passwordHash, ...safeUser } = user;`) before returning `safeUser` to a controller. There's no Postgres/Drizzle equivalent of Mongoose's field-level `select: false` — see [`07-database-schema-design.md`](./07-database-schema-design.md) §7 for the full argument that this is more visible, at the cost of being a call-site discipline rather than something the schema itself enforces.

**The dummy-bcrypt-hash timing defense (§3.5) only closes the timing side-channel on the *login* endpoint** — it doesn't extend to `requestPasswordResetService`, which instead closes the same class of leak by response-shape identity (always the same message) rather than timing, since that endpoint doesn't need to run a bcrypt comparison at all on the not-found branch. Both are valid closures of the same underlying "don't let this endpoint answer 'does this email have an account'" requirement, applied by whichever mechanism fits the endpoint's actual code path.

---

## 7. Best Practice Check

**Refresh-token rotation with reuse detection** matches current (2026) OAuth 2.0 BCP guidance precisely, and is one of the stronger pieces of this system — not a compromise made for migration convenience, since it long predates the Postgres/Redis work and survived it unchanged in shape.

**Redis-backed session storage with real TTL** is the correct replacement for the old Mongo TTL-index approach specifically because it eliminates a real bug class (the up-to-60-second window where an "expired" document was still readable) rather than merely moving the same mechanism to different infrastructure — see §3.2's precise mechanism comparison.

**Where this system still carries a real, named gap:** authorization enforcement is inline-per-controller, not centralized (§5) — the same gap [`01-architecture-patterns-and-project-structure.md`](./01-architecture-patterns-and-project-structure.md) names for the layered structure generally, concretely instantiated here. At AstriX's current route count this is manageable by discipline; it's the first thing to reconsider centralizing if the number of workspace-scoped routes grows significantly, per that chapter's own recommendation.

**Static RBAC via a hardcoded permission map** is a reasonable, low-ceremony choice for three fixed roles that don't need runtime configurability — see [`07-database-schema-design.md`](./07-database-schema-design.md) §3.4 for why `roles.permissions` is a Postgres array column rather than a fully normalized permissions table, the same "small, low-churn, no bidirectional query need" argument applying on both the Postgres and the TypeScript side of this system.

---

## 8. Debug Drill

**Scenario:** a user reports being logged out unexpectedly, with no error they can point to — refresh calls that used to work now return `401`.

1. **Check whether this is reuse detection firing, not an actual attack.** The single most common real-world cause of a legitimate user hitting "Refresh token reuse detected" is a client-side bug: two tabs/requests racing to refresh with the *same* (about-to-be-stale) refresh token concurrently, where the first one wins, rotates the session, and the second one's now-stale token gets read as reuse. Check the client's refresh-call deduplication (is there a single in-flight refresh promise shared across concurrent 401s, or does every failed request independently trigger its own refresh call?) before assuming a real token theft.
2. **Confirm which of `authenticateAccessTokenService`'s four checks is actually failing**, by reading the exact `UnauthorizedException` message reaching the client (`"Token expired"` / `"Invalid token"` from `verifyJwtToken`, `"User not found"`, `"User is not active"`, `"Session not found"`, `"Session has been revoked"`, `"Invalid Session"`) — each maps to a different one of the four checks in §3.4, and they are not interchangeable: "Session not found" means the Redis key is simply gone (natural TTL expiry, or an explicit `invalidateSession` call), while "Session has been revoked" means the key exists but `isValid` isn't `"1"` — a state that, per the current code, is never actually set anywhere except implicitly by deleting the session key entirely (`invalidateSession` does a `DEL`, not an `isValid` flip) — if you ever see this specific message in production, that's a signal something is writing to the session hash directly rather than going through `invalidateSession`, worth investigating as a bug in itself.
3. **Check the session's actual TTL** with `redis-cli TTL session:<id>` if you can reproduce with a real session ID — a session that should still be alive but has a suspiciously low or negative TTL means something called `rotateSessionToken` (which resets the TTL to a full 7 days on every rotation) either isn't running when expected, or something else is calling `redis.expire()` on that key with a shorter value.
4. **If the report is "logged out on every device simultaneously,"** check whether a password change or password reset happened around the same time — both `changePasswordService` (invalidates every *other* session) and `resetPasswordService` (invalidates *every* session, including the current one) are legitimate, intentional triggers for exactly this behavior, not a bug. Confirm via the user's own action history before treating it as a session-handling defect.
5. **If none of the above explains it, check Redis itself, not the application code.** A Redis instance running out of memory under an eviction policy other than a no-eviction/TTL-aware one (`allkeys-lru`, for instance) can evict live, non-expired session keys under memory pressure — this would surface as "Session not found" for sessions that should still exist, with no corresponding `invalidateSession` call anywhere in the application's own logs, which is the tell that distinguishes it from every other cause in this list.

---

Authorization's static permission map and the middleware pipeline that gets a request to `authenticate` in the first place are covered in full in [`03-middleware-and-request-pipeline.md`](./03-middleware-and-request-pipeline.md); the `AppError`/`errorHandler` mechanics every `throw` in this chapter ultimately funnels into are [`04-error-handling-patterns.md`](./04-error-handling-patterns.md)'s scope.
