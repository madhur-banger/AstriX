# Authentication & Authorization

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Backend](./00-master-backend-architecture.md).

Authentication answers "who is this?" Authorization answers "what are they allowed to do?" They are two different problems that get solved in the same request pipeline, and it's worth keeping them mentally separate even while reading code that handles both back to back — AstriX does, and conflating them is one of the easiest ways to introduce a security bug (e.g. checking "is this request signed by someone" and quietly assuming that also means "is this someone allowed to delete this workspace"). This chapter covers both: how AstriX decides a request carries a real, un-revoked identity, and how it decides what that identity is permitted to do once established.

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

**Tradeoffs:** this gives you both revocability (there's a server-side session record to delete) and a stateless hot path (every ordinary API call still only needs JWT signature verification, no DB hit) — the DB only gets touched on the comparatively rare `/refresh` call. The cost is real implementation complexity: you now have to build and get right the rotation bookkeeping, the reuse-detection branch, and a session store with its own lifecycle (creation, expiry, cleanup) — none of which a plain stateless JWT needs.

### Delegated/federated auth — OAuth via a library vs. hand-rolled

Orthogonal to all four above is *how* the user proves who they are in the first place. Instead of a password, a backend can delegate identity verification to a third party (Google, GitHub, Microsoft) via OAuth 2.0 / OpenID Connect. Most Node backends reach for `passport` with a strategy plugin (`passport-google-oauth20`, `passport-github2`, ...), which wraps the authorization-code exchange, session serialization, and a lot of provider-specific edge cases behind a small, declarative API:

```js
// illustrative passport-google-oauth20 usage — not AstriX code
passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: "/auth/google/callback",
}, (accessToken, refreshToken, profile, done) => {
  // find-or-create user, then done(null, user)
}));
```

The alternative — what AstriX does — is hand-rolling the OAuth2 authorization-code exchange directly: build the consent-screen URL yourself, redirect the user, receive the callback, and manually `POST` the authorization code to the provider's token endpoint using `axios` or `fetch`. **Tradeoffs:** a library like `passport-google-oauth20` has already absorbed years of edge cases — token refresh, revocation flows, provider quirks, and a consistent interface across dozens of providers — at the cost of an extra dependency and a somewhat "magic" `done()`-callback control flow that can be awkward to reason about. Hand-rolling it means one fewer dependency and full visibility into exactly what's being sent and received, at the cost of being responsible for getting every detail (state/CSRF handling, error branches, token exchange) right yourself, with no upstream project fixing bugs on your behalf.

---

## 2. AstriX's Choice

AstriX uses a hybrid of options (d) and the hand-rolled OAuth path above: a short-lived, stateless-to-verify JWT access token for every API call, paired with a **rotating, single-use refresh token bound to a server-tracked `Session` document** — so a session can be revoked (logout, "reuse detected," password change) even though the access token itself carries no server-side record. Google login is a **hand-rolled OAuth2 authorization-code flow** (no `passport`, no `passport-google-oauth20`), protected by a CSRF `state` cookie. Sitting on top of both is a separate **RBAC (role-based access control) layer** — `roleGuard` plus a static `RolePermissions` map — that answers "what is this already-authenticated user allowed to do in this workspace," entirely independent of how they authenticated.

---

## 3. AstriX Implementation

### 3.1 Dual-token issuance

Both tokens are produced by one function, sharing default sign options (HS256, audience `["user"]`) but different secrets and lifetimes:

```ts
// backend/src/utils/jwt.ts:1-58
import jwt, { SignOptions, VerifyOptions } from "jsonwebtoken";
import { config } from "../config/app.config";
import { UserDocument } from "../models/user.model";
import { UnauthorizedException } from "./appError";

export type AccessTokenPayload = {
  userId: UserDocument["_id"];
  sessionId: string;
};

export type RefreshTokenPayload = {
  userId: UserDocument["_id"];
  sessionId: string;
};

type SignOptsAndSecret = SignOptions & {
  secret: string;
};

const defaults: SignOptions = {
  audience: ["user"],
  algorithm: "HS256",
};

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

export const generateTokenPair = (
  userId: UserDocument["_id"],
  sessionId: string
): { accessToken: string; refreshToken: string } => {
  const accessToken = signJwtToken<AccessTokenPayload>(
    { userId, sessionId },
    accessTokenSignOptions
  );

  const refreshToken = signJwtToken<RefreshTokenPayload>(
    { userId, sessionId },
    refreshTokenSignOptions
  );

  return { accessToken, refreshToken };
};
```

Both token payloads carry only `userId` and `sessionId` — no roles, no email, nothing else. That's deliberate: any authorization data derived from the token would go stale the moment it changed server-side (a role change wouldn't take effect until the token expired), so the token is kept to the minimum needed to look the rest up fresh on every request.

Verification and extraction live in the same file:

```ts
// backend/src/utils/jwt.ts:60-118
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
    return {
      valid: false,
      error: name === "TokenExpiredError" ? "Token expired" : "Invalid token",
    };
  }
};

export const extractBearerToken = (
  authHeader: string | undefined
): string | null => {
  if (!authHeader) return null;

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) return null;

  return token;
};

export const verifyAccessTokenAndGetPayload = (
  token: string
): AccessTokenPayload => {
  const result = verifyJwtToken<AccessTokenPayload>(
    token,
    accessTokenSignOptions.secret
  );
  if (!result.valid) {
    throw new UnauthorizedException(result.error);
  }
  return result.payload;
};
```

`verifyJwtToken` pins `algorithms: ["HS256"]` explicitly on every verify call rather than trusting whatever algorithm the token header claims — this closes the classic "alg confusion" JWT vulnerability class, where an attacker crafts a token claiming `alg: none` or swaps an asymmetric scheme for a symmetric one to trick a naive verifier. `jsonwebtoken` only honors algorithms in this explicit allow-list, so a forged token claiming a different algorithm is rejected before the signature is even checked.

### 3.2 The `Session` model

The server-side record that makes revocation possible in the first place:

```ts
// backend/src/models/session.model.ts:1-76
// backend/src/models/session.model.ts
// ============================================
// SESSION MODEL - Stores Refresh Tokens
// ============================================

/**
 * WHY STORE REFRESH TOKENS IN DATABASE?
 *
 * 1. REVOCATION: Can invalidate specific sessions (logout from one device)
 * 2. LOGOUT ALL: Can invalidate all user sessions (logout everywhere)
 * 3. SECURITY: If refresh token is compromised, can delete it
 * 4. AUDIT: Can see all active sessions for a user
 * 5. DEVICE MANAGEMENT: "Manage your devices" feature
 */

import mongoose, { Document, Schema } from "mongoose";

export interface SessionDocument extends Document {
  userId: mongoose.Types.ObjectId;
  userAgent?: string;
  ipAddress?: string;
  isValid: boolean; // Can be set to false to revoke
  // SHA-256 of the refresh token this session is CURRENTLY bound to. Rotated
  // on every successful /auth/refresh, so a previously issued (already
  // rotated away) refresh token can be recognised as a replay rather than
  // silently accepted. Only the hash is stored - same discipline as the
  // password-reset and email-verification tokens.
  refreshTokenHash?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionDocument>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true, // Index for fast lookup by user
    },
    userAgent: {
      type: String,
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    isValid: {
      type: Boolean,
      default: true,
      index: true, // Index for fast filtering of valid sessions
    },
    refreshTokenHash: {
      type: String,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 }, // TTL index - MongoDB auto-deletes expired docs
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient queries
sessionSchema.index({ userId: 1, isValid: 1 });

const SessionModel = mongoose.model<SessionDocument>("Session", sessionSchema);

export default SessionModel;
```

Note what's *not* stored: the raw refresh token itself. Only `refreshTokenHash` — a SHA-256 digest — is persisted. `isValid` is the revocation flag (set `false`, never deleted directly, on logout/reuse-detection/password-change), and `expiresAt` doubles as both the session's natural lifetime and, via the TTL index, its own cleanup mechanism.

### 3.3 The `authenticate` middleware, in full

Every protected router in `index.ts` is mounted behind this single function:

```ts
// backend/src/middlewares/auth.middleware.ts:1-57
import { Request, Response, NextFunction } from "express";
import {
  extractBearerToken,
  verifyAccessTokenAndGetPayload,
} from "../utils/jwt";
import { UnauthorizedException } from "../utils/appError";
import UserModel from "../models/user.model";
import SessionModel from "../models/session.model";

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    const token = extractBearerToken(authHeader);

    if (!token) {
      throw new UnauthorizedException("Token not found");
    }

    const payload = verifyAccessTokenAndGetPayload(token);

    const user = await UserModel.findById(payload.userId);

    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    if (!user.isActive) {
      throw new UnauthorizedException("User is not active");
    }

    const session = await SessionModel.findById(payload.sessionId);

    if (!session) {
      throw new UnauthorizedException("Session not found");
    }
    if (!session.isValid) {
      throw new UnauthorizedException("Session has been revoked");
    }
    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException("Session has expired");
    }

    if (session.userId.toString() != user._id.toString()) {
      throw new UnauthorizedException("Invalid Session");
    }
    req.user = user;
    req.session = session;

    next();
  } catch (error) {
    next(error);
  }
};
```

Five separate checks have to pass, in order: the header actually contains a bearer token, the JWT signature/expiry verifies, the user it names still exists, that user is still `isActive`, and — the part that turns this from a stateless-JWT-only check into a revocable one — the session it names still exists, is still `isValid`, hasn't itself expired, and actually belongs to that user. A structurally valid, unexpired JWT is necessary but not sufficient; the session lookup is what lets an admin (or the user themselves, via logout) kill access before the 15-minute access-token window runs out on its own.

### 3.4 The refresh-rotation function, with reuse detection

```ts
// backend/src/services/auth.service.ts:335-383
export const refreshAccessTokenService = async (
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string }> => {
  const result = verifyRefreshToken(refreshToken);
  if (!result.valid) {
    throw new UnauthorizedException(result.error);
  }

  const { userId, sessionId } = result.payload;

  const session = await SessionModel.findById(sessionId);
  if (!session || !session.isValid) {
    throw new UnauthorizedException("Session expired or invalid");
  }

  if (session.expiresAt < new Date()) {
    await SessionModel.findByIdAndDelete(sessionId);
    throw new UnauthorizedException("Session expired");
  }

  // Refresh tokens are single-use. A structurally valid token whose hash is
  // no longer the one this session is bound to has already been rotated
  // away - which means two parties hold tokens for this session, i.e. one
  // was stolen. Kill the session outright rather than just rejecting this
  // one request, so the thief and the victim both have to re-authenticate.
  //
  // `refreshTokenHash` is optional purely for backwards compatibility with
  // sessions issued before rotation existed - those are adopted on their
  // first refresh instead of being force-logged-out.
  if (
    session.refreshTokenHash &&
    session.refreshTokenHash !== hashToken(refreshToken)
  ) {
    await invalidateSessionService(sessionId);
    throw new UnauthorizedException(
      "Refresh token reuse detected. Please log in again."
    );
  }

  const tokens = generateTokenPair(userId, sessionId);

  // Rotate in place on the SAME session document: the session (and the entry
  // the user sees in their device list) is continuous across refreshes -
  // only the token bound to it changes.
  session.refreshTokenHash = hashToken(tokens.refreshToken);
  await session.save();

  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
};
```

`hashToken` — used here and throughout the file for every raw secret that gets persisted — is a small shared helper:

```ts
// backend/src/services/auth.service.ts:43-47
const hashToken = (rawToken: string): string =>
  crypto.createHash("sha256").update(rawToken).digest("hex");
```

And session creation, shared by both email/password login and OAuth login, is where the very first `refreshTokenHash` gets written:

```ts
// backend/src/services/auth.service.ts:54-84
export const createSessionService = async ({
  userId,
  userAgent,
  ipAddress,
}: CreateSessionParams): Promise<TokenPairWithSession> => {
  // Constructed (not `.create()`d) so the session's _id - which the token
  // payload has to carry - is available BEFORE the insert, letting the
  // session and the hash of the refresh token it's bound to be written in a
  // single round trip.
  const session = new SessionModel({
    userId,
    userAgent,
    ipAddress,
    isValid: true,
    expiresAt: calculateExpiryDate(config.JWT.REFRESH_TOKEN_EXPIRES_IN),
  });

  const { accessToken, refreshToken } = generateTokenPair(
    userId,
    session._id.toString()
  );

  session.refreshTokenHash = hashToken(refreshToken);
  await session.save();

  return {
    accessToken,
    refreshToken,
    sessionId: session._id.toString(),
  };
};
```

### 3.5 Google OAuth: authorization URL and code exchange

```ts
// backend/src/providers/google.provider.ts:34-89
export const getGoogleAuthorizationUrl = (state: string): string => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");

  url.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", config.GOOGLE_CALLBACK_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "profile email");
  url.searchParams.set("state", state);

  return url.toString();
};

export const exchangeGoogleCodeForProfile = async (
  code: string
): Promise<OAuthProfile> => {
  try {
    const tokenResponse = await axios.post<GoogleTokenResponse>(
      "https://oauth2.googleapis.com/token",
      {
        code,
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        redirect_uri: config.GOOGLE_CALLBACK_URL,
        grant_type: "authorization_code",
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const { access_token } = tokenResponse.data;

    const profileResponse = await axios.get<GoogleProfileResponse>(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    const googleProfile = profileResponse.data;

    return {
      provider: "GOOGLE",
      providerId: googleProfile.sub,
      email: googleProfile.email,
      name: googleProfile.name,
      picture: googleProfile.picture,
      // Conservative default: treat a missing field as NOT verified rather
      // than assuming Google confirmed it.
      emailVerified: googleProfile.email_verified === true,
    };
  } catch {
    throw new UnauthorizedException("Failed to authenticate with Google");
  }
};

export const generateGoogleOAuthState = (): string => {
  return crypto.randomBytes(32).toString("hex");
};
```

Two manual HTTP calls do everything a library would normally hide: `POST` the authorization code to Google's token endpoint for an access token, then `GET` the OpenID Connect `userinfo` endpoint with that access token to get the profile. Note that AstriX never sees or stores a Google *refresh* token here — this exchange is used purely to authenticate the user once, not to make ongoing calls to Google's APIs on their behalf.

### 3.6 CSRF `state` handling for the OAuth callback

The `state` cookie is set on the redirect-out leg, in the route file itself (not the controller):

```ts
// backend/src/routes/auth.route.ts:79-92
authRoutes.get("/google", oauthLimiter, (req: Request, res: Response) => {
  const state = generateGoogleOAuthState();

  res.cookie("google_oauth_state", state, {
    httpOnly: true,
    secure: config.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
  });

  res.redirect(getGoogleAuthorizationUrl(state));
});

authRoutes.get("/google/callback", oauthLimiter, googleCallbackController);
```

...and checked on the callback leg, in the controller:

```ts
// backend/src/controllers/auth.controller.ts:101-137
export const googleCallbackController = asyncHandler(
  async (req: Request, res: Response) => {
    const { code, state } = req.query;

    if (!code || !state) {
      throw new BadRequestException("Missing code or state from request");
    }

    const storedState = req.cookies.google_oauth_state;
    if (!storedState || storedState !== state) {
      throw new UnauthorizedException("Invalid OAuth state");
    }
    res.clearCookie("google_oauth_state");

    const profile = await exchangeGoogleCodeForProfile(code as string);

    const { user } = await loginOrCreateAccountService({
      provider: profile.provider,
      providerId: profile.providerId,
      email: profile.email,
      displayName: profile.name,
      picture: profile.picture,
      emailVerified: profile.emailVerified,
    });

    const { refreshToken } = await createSessionService({
      userId: user._id,
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });

    setRefreshTokenCookie(res, refreshToken);

    const redirectUrl = `${config.FRONTEND_ORIGIN}/workspace/${user.currentWorkspace}`;
    res.redirect(redirectUrl);
  }
);
```

### 3.7 The RBAC layer: `roleGuard` and `RolePermissions`

Authorization is a flat, per-workspace role check, entirely separate from `authenticate`:

```ts
// backend/src/utils/roleGuard.ts:1-21
import { PermissionType } from "../enums/role.enum";
import { ForbiddenException } from "./appError";
import { RolePermissions } from "./role-permission";

export const roleGuard = (
  role: keyof typeof RolePermissions,
  requiredPermissions: PermissionType[]
) => {
  const permissions = RolePermissions[role];
  // If the role doesn't exist or lacks required permissions, throw an exception

  const hasPermission = requiredPermissions.every((permission) =>
    permissions.includes(permission)
  );

  if (!hasPermission) {
    throw new ForbiddenException(
      "You do not have the necessary permissions to perform this action"
    );
  }
};
```

```ts
// backend/src/utils/role-permission.ts:1-40
import { Permissions, PermissionType, RoleType } from "../enums/role.enum";

export const RolePermissions: Record<RoleType, Array<PermissionType>> = {
  OWNER: [
    Permissions.CREATE_WORKSPACE,
    Permissions.EDIT_WORKSPACE,
    Permissions.DELETE_WORKSPACE,
    Permissions.MANAGE_WORKSPACE_SETTINGS,

    Permissions.ADD_MEMBER,
    Permissions.CHANGE_MEMBER_ROLE,
    Permissions.REMOVE_MEMBER,

    Permissions.CREATE_PROJECT,
    Permissions.EDIT_PROJECT,
    Permissions.DELETE_PROJECT,

    Permissions.CREATE_TASK,
    Permissions.EDIT_TASK,
    Permissions.DELETE_TASK,

    Permissions.VIEW_ONLY,
  ],
  ADMIN: [
    Permissions.ADD_MEMBER,
    Permissions.CREATE_PROJECT,
    Permissions.EDIT_PROJECT,
    Permissions.DELETE_PROJECT,
    Permissions.CREATE_TASK,
    Permissions.EDIT_TASK,
    Permissions.DELETE_TASK,
    Permissions.MANAGE_WORKSPACE_SETTINGS,
    Permissions.VIEW_ONLY,
  ],
  MEMBER: [
    Permissions.VIEW_ONLY,
    Permissions.CREATE_TASK,
    Permissions.EDIT_TASK,
  ],
};
```

`roleGuard` is not middleware — it's a plain function that throws, called directly inside a controller once the controller has already looked up the caller's role for the specific workspace the request targets (role is per-membership, not a global property of the user — the same person can be `OWNER` of one workspace and `MEMBER` of another). This is the enum it checks against:

```ts
// backend/src/enums/role.enum.ts:1-30
export const Roles = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MEMBER: "MEMBER",
} as const;

export type RoleType = keyof typeof Roles;

export const Permissions = {
  CREATE_WORKSPACE: "CREATE_WORKSPACE",
  DELETE_WORKSPACE: "DELETE_WORKSPACE",
  EDIT_WORKSPACE: "EDIT_WORKSPACE",
  MANAGE_WORKSPACE_SETTINGS: "MANAGE_WORKSPACE_SETTINGS",

  ADD_MEMBER: "ADD_MEMBER",
  CHANGE_MEMBER_ROLE: "CHANGE_MEMBER_ROLE",
  REMOVE_MEMBER: "REMOVE_MEMBER",

  CREATE_PROJECT: "CREATE_PROJECT",
  EDIT_PROJECT: "EDIT_PROJECT",
  DELETE_PROJECT: "DELETE_PROJECT",

  CREATE_TASK: "CREATE_TASK",
  EDIT_TASK: "EDIT_TASK",
  DELETE_TASK: "DELETE_TASK",

  VIEW_ONLY: "VIEW_ONLY",
} as const;

export type PermissionType = keyof typeof Permissions;
```

Two things worth noticing: `MEMBER` has no `DELETE_TASK` — a regular member can create and edit tasks but not delete them, only `ADMIN`/`OWNER` can. And `ADMIN` has `MANAGE_WORKSPACE_SETTINGS` but not `DELETE_WORKSPACE` or `CHANGE_MEMBER_ROLE` — deleting the workspace or changing who has what role is reserved for the `OWNER` alone.

### 3.8 Password-reset and email-verification token issuance

Both follow the identical "random token, hash before storing, email the raw one" shape as the refresh token:

```ts
// backend/src/services/auth.service.ts:427-453
export const requestPasswordResetService = async (
  email: string
): Promise<void> => {
  const user = await UserModel.findOne({ email });

  // Deliberately the same outcome (no error, no distinguishing response)
  // whether or not the account exists - an unauthenticated "does this email
  // have an account" oracle is exactly what this endpoint must not become.
  if (!user) {
    return;
  }

  // Only the newest reset link should work - drop any previously issued,
  // still-valid ones for this user.
  await PasswordResetTokenModel.deleteMany({ userId: user._id });

  const rawToken = crypto.randomBytes(32).toString("hex");

  await PasswordResetTokenModel.create({
    userId: user._id,
    tokenHash: hashToken(rawToken),
    expiresAt: calculateExpiryDate(config.PASSWORD_RESET_TOKEN_EXPIRES_IN),
  });

  const resetUrl = `${config.FRONTEND_PASSWORD_RESET_URL}?token=${rawToken}`;
  await sendPasswordResetEmail(user.email, resetUrl);
};
```

```ts
// backend/src/services/auth.service.ts:491-516
export const requestEmailVerificationService = async (
  userId: string
): Promise<void> => {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new NotFoundException("User not found");
  }

  if (user.isEmailVerified) {
    throw new BadRequestException("Email is already verified");
  }

  // Only the newest verification link should work.
  await EmailVerificationTokenModel.deleteMany({ userId: user._id });

  const rawToken = crypto.randomBytes(32).toString("hex");

  await EmailVerificationTokenModel.create({
    userId: user._id,
    tokenHash: hashToken(rawToken),
    expiresAt: calculateExpiryDate(config.EMAIL_VERIFICATION_TOKEN_EXPIRES_IN),
  });

  const verifyUrl = `${config.FRONTEND_EMAIL_VERIFICATION_URL}?token=${rawToken}`;
  await sendVerificationEmail(user.email, verifyUrl);
};
```

Both models that back these tokens store only the hash, and both carry a Mongo TTL index identical in shape to `Session`'s:

```ts
// backend/src/models/passwordResetToken.model.ts:16-38
const passwordResetTokenSchema = new Schema<PasswordResetTokenDocument>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 }, // TTL index - MongoDB auto-deletes expired docs
    },
  },
  {
    timestamps: true,
  }
);
```

`emailVerificationToken.model.ts` is the same shape again, down to the field names — the two are deliberately kept as separate collections rather than one polymorphic "token" collection, so an email-verification token can never accidentally be replayed against the password-reset endpoint or vice versa; the two `findOne({ tokenHash })` lookups in `resetPasswordService` and `verifyEmailService` are scoped to different models, not just a different `type` field on the same one.

---

## 4. Request/Data Flow

### 4.1 Email/password login → session creation → cookie set

1. `POST /auth/login` hits `authLimiter` first (`backend/src/routes/auth.route.ts:76`) — 5 attempts per window, `skipSuccessfulRequests: true` so only failed attempts count against the budget.
2. `loginController` (`backend/src/controllers/auth.controller.ts:76-95`) parses the body with `loginSchema`, then calls `verifyUserService`.
3. `verifyUserService` (`backend/src/services/auth.service.ts:181-220`) looks up the `Account` by `(provider: EMAIL, providerId: email)`, then the `User` that account points to, then calls `user.comparePassword()` — a bcrypt compare defined on the schema in `backend/src/models/user.model.ts:68-70`.
4. On success, the controller calls `createSessionService` (§3.2 above): a new `Session` document is constructed, a fresh access/refresh token pair is signed against that session's `_id`, the refresh token's hash is written onto the session, and the whole thing is saved in one round trip.
5. `setRefreshTokenCookie` writes the refresh token into an `httpOnly` cookie (exact flags in §6 below); the access token goes back in the JSON response body, not a cookie — the client is expected to hold it in memory and attach it as an `Authorization: Bearer` header (see `client/src/lib/axios-client.ts:40-46`, covered in `docs/Architecture.md` §3.2).
6. The response also carries `user.omitPassword()` — the password field stripped before the document ever leaves the service layer.

### 4.2 An authenticated request through `authenticate`

1. Every non-auth router is mounted as `app.use(path, authenticate, router)` in `backend/src/index.ts:147-155` — the guard runs before any route handler in that domain even matches.
2. `authenticate` (§3.3) extracts the bearer token, verifies its signature/expiry/audience against `JWT_ACCESS_TOKEN_SECRET`, then does two more lookups the token alone can't answer: is the user still `isActive`, and is the *session* the token names still `isValid` and unexpired. Only after all four pass does `req.user` and `req.session` get populated and `next()` called.
3. From there, a controller that needs to enforce a role (e.g. "only an `OWNER` can delete this workspace") separately resolves the caller's `Member` record for the target workspace and calls `roleGuard(member.role.name, [Permissions.DELETE_WORKSPACE])` — authentication and authorization are two distinct steps in the same handler, not one combined check.

### 4.3 The Google OAuth redirect round trip, including the CSRF `state` check

1. Browser hits `GET /auth/google`. The route handler (§3.6) generates a random 32-byte hex `state`, sets it as a 10-minute `httpOnly` cookie named `google_oauth_state`, and redirects the browser to Google's consent screen with that same `state` embedded in the URL.
2. The user authenticates with Google and consents; Google redirects the browser back to `GOOGLE_CALLBACK_URL` (AstriX's `/auth/google/callback`) with `?code=...&state=...` — the `state` value Google echoes back is whatever was in the original authorization URL, unchanged.
3. `googleCallbackController` (§3.6) reads `req.cookies.google_oauth_state` — the cookie the browser is still carrying from step 1 — and compares it byte-for-byte against the `state` query parameter Google just sent. A mismatch (or a missing cookie) throws `UnauthorizedException("Invalid OAuth state")` before any code exchange happens. On success, the cookie is cleared immediately — it's single-use by construction.
4. Only then does `exchangeGoogleCodeForProfile` run: `code` is exchanged for a Google access token, which is exchanged for a profile via the userinfo endpoint.
5. `loginOrCreateAccountService` (`backend/src/services/auth.service.ts:226-329`) finds or creates the local `User`/`Account`/`Workspace` records inside a Mongo transaction, then `createSessionService` runs exactly as in the password flow — same session/token machinery, different entry point.
6. The response is a `302` redirect straight to the frontend workspace URL, with the refresh-token cookie already set on that same response — there's no intermediate JSON exchange step for the OAuth path the way there is for password login.

### 4.4 Refresh-token reuse detection — what happens on a stolen/replayed token

1. Client A logs in, gets refresh token `R1`, and the session's `refreshTokenHash` is set to `hash(R1)`.
2. Suppose `R1` is stolen (XSS, a compromised network, a leaked log) before it's used. The thief calls `POST /auth/refresh` with `R1`. `refreshAccessTokenService` (§3.4) hashes `R1`, compares it to the session's stored hash — they match — so it rotates: a new pair is issued, `refreshTokenHash` becomes `hash(R2)`, and `R2` is returned to whoever made this call (the thief, in this ordering).
3. The legitimate client, still holding stale `R1`, later also calls `/auth/refresh` with `R1`. This time the stored hash is `hash(R2)`, not `hash(R1)` — the comparison in the `if (session.refreshTokenHash && session.refreshTokenHash !== hashToken(refreshToken))` branch fails to match, which is exactly the reuse-detection trigger. `invalidateSessionService(sessionId)` sets `isValid: false` on the session, and the request is rejected with `"Refresh token reuse detected. Please log in again."`
4. From that point forward, *both* parties are locked out: the thief's `R2` still verifies as a structurally valid JWT, but the next `/auth/refresh` call re-checks `session.isValid` and rejects immediately, before the hash comparison is even reached. Both have to go through `/auth/login` again.
5. On the controller side, `refreshTokenController` (`backend/src/controllers/auth.controller.ts:143-171`) also actively clears the refresh-token cookie on any failure path — a client whose session was just killed doesn't keep silently resending a dead cookie on every subsequent request.

Whichever party refreshes *first* in this race "wins" the token — the underlying signal is symmetric-looking traffic from two holders of the same secret, not an ability to tell attacker from victim. That's the fundamental limit of bearer-token reuse detection: it reliably detects that theft happened, but can't by itself say which caller was the legitimate one.

---

## 5. Design Decisions & Tradeoffs

**Why this hybrid over the four alternatives in §1.** Plain server-side sessions (a) would have made revocation trivial but would have put a database round trip on the critical path of *every single API call*, not just the once-per-15-minutes refresh — a meaningful latency and DB-load cost paid on every request forever. Pure stateless JWT (b) is the cheapest to run but throws away the ability to log a user out early, which is a feature AstriX's UI explicitly offers (`/auth/logout`, `/auth/logout-all`, and a "manage your devices" session list via `/auth/sessions`) — those endpoints would be lies without server-side revocation to back them. Non-rotating refresh tokens (c) get partway to AstriX's design but leave a long-lived bearer secret valid for its entire lifetime even after a legitimate rotation would have retired it — there's no way to distinguish a replayed old token from a normal one. Rotating, session-bound refresh tokens (d) are the only option on the list that gives AstriX both a stateless hot path (every ordinary request still costs zero extra DB round trips beyond what `authenticate` already needs for the user/session lookup) and real revocation, at the acknowledged cost of the reuse-detection logic in §3.4 — genuinely more code and more edge cases (what does "adopt legacy sessions with no `refreshTokenHash`" even mean, as the comment in `refreshAccessTokenService` calls out) than any single simpler option.

**Why hash the refresh token (SHA-256) instead of storing it plaintext.** The `Session` collection is, functionally, a bearer-credential store — anyone who reads a row and extracts a usable refresh token can impersonate that session until it's rotated or expires. Hashing the token before persisting it means a database read (a leaked backup, an overly broad admin query, a NoSQL-injection read) yields hashes, not usable credentials — the raw token only ever exists in the response body handed to the client and in server memory for the duration of the request that issued or rotated it. This is the exact same discipline applied uniformly to password-reset tokens, email-verification tokens, and refresh tokens alike — three different token types, one consistent "hash before you persist" rule.

**Why a Mongo TTL index instead of a cleanup cron job.** `Session`, `PasswordResetToken`, and `EmailVerificationToken` all set `expiresAt` with `index: { expireAfterSeconds: 0 }` — MongoDB's background TTL monitor sweeps and deletes expired documents on its own, roughly once a minute, with zero application code. The alternative — a scheduled job (cron, a queue-based worker, an ECS scheduled task) that periodically deletes `WHERE expiresAt < now()` — is a second moving part to deploy, monitor, and make sure actually keeps running, doing exactly what the database can already do natively for these collections. The tradeoff is precision: TTL deletion isn't instantaneous or exactly on the second (Mongo's own docs describe it as "best effort, generally within 60 seconds"), which is irrelevant here since `authenticate` and the refresh flow already independently re-check `expiresAt` against `Date.now()` on every use — the TTL index is a storage-hygiene mechanism, not the actual enforcement of expiry.

**What's given up by not using `passport-google-oauth20`.** A mature strategy library has already handled a long tail of provider-specific behavior AstriX's roughly 90-line `google.provider.ts` hasn't: token refresh flows if a longer-lived Google access token were ever needed, revocation-on-unlink handling, `id_token` signature verification as an alternative/complement to the userinfo round trip, retry/backoff around Google's endpoints, and multi-provider abstraction if a second OAuth provider were added later (GitHub, Microsoft) — with `passport`, that's a second strategy plugin; hand-rolled, it's a second bespoke provider file duplicating most of this one's shape. In exchange, AstriX gets full visibility into exactly what's sent to and received from Google (useful for the CSRF `state` design specifically, since it isn't left to a library's own session-integration assumptions about how `state` is generated or checked), one fewer third-party dependency to track for vulnerabilities, and no `passport`-specific session/serialization model to reconcile with AstriX's own JWT-based approach — `passport`'s default mental model assumes it owns the session, which fights rather than helps a design where sessions are already hand-rolled.

---

## 6. Security Considerations

**Token theft/replay.** Covered in depth in §4.4 — the core defense is refresh-token rotation with reuse detection, which turns a stolen-and-replayed refresh token from a silent, ongoing compromise into a detected event that force-invalidates the session for both parties. What it does *not* protect against: an access token stolen during its own ~15-minute window is valid until it naturally expires — there's no per-access-token revocation list, only session revocation, which blocks the *next* refresh but not an already-issued access token still inside its lifetime. That's an accepted tradeoff of the design (see the `JWT_ACCESS_TOKEN_EXPIRES_IN` discussion below), not an oversight.

**Timing-attack mitigation on login.** `verifyUserService` is deliberately structured so a nonexistent-account branch and a wrong-password branch are statistically indistinguishable, not just identical in message and status code:

```ts
// backend/src/services/auth.service.ts:172-220 (excerpt)
const DUMMY_PASSWORD_HASH =
  "$2b$10$uoY4NVy6Uns2Luc7jnt9P.hOJUVlz40gP0G0Aunbvk.3vZ3w642ei";

export const verifyUserService = async ({
  email,
  password,
  provider = ProviderEnum.EMAIL,
}: {
  email: string;
  password: string;
  provider?: string;
}) => {
  const account = await AccountModel.findOne({ provider, providerId: email });
  if (!account) {
    await compareValue(password, DUMMY_PASSWORD_HASH);
    throw new UnauthorizedException("Invalid email or password");
  }

  const user = await UserModel.findById(account.userId);
  if (!user) {
    throw new NotFoundException("User not found for the given account");
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    throw new UnauthorizedException("Invalid email or password");
  }

  return user.omitPassword();
};
```

Without the `compareValue(password, DUMMY_PASSWORD_HASH)` call, the "no such account" branch would return in roughly the time of one Mongo lookup, while the "wrong password" branch would additionally pay for a real bcrypt comparison — bcrypt is deliberately slow (that's the point of it as a KDF), so that gap is measurable over enough requests, and an attacker could use it to enumerate valid email addresses purely from response latency, independent of the response body or status code being identical. Burning the same bcrypt cost against a precomputed dummy hash on the "no account" branch closes that side channel.

**CSRF on the OAuth callback.** Covered in §4.3 — the `state` cookie/parameter pair is the mitigation, and it's genuinely necessary here specifically because the OAuth callback is a state-changing `GET` request (it creates a session and sets a cookie) reachable by an attacker crafting a callback URL with their own `code`. Without `state`, an attacker could potentially trick a victim's browser into completing an OAuth flow bound to the attacker's own Google account, then having the victim unknowingly perform actions inside a session attributed to the attacker — a login CSRF. Tying the callback to a value the browser can only have because it made the original `/auth/google` request closes that gap.

**What happens if `JWT_ACCESS_TOKEN_SECRET`/`JWT_REFRESH_TOKEN_SECRET` leak.** Both are HMAC (HS256) symmetric secrets — the same value signs and verifies. If either leaks, an attacker can forge arbitrary, validly-signed tokens for any `userId`/`sessionId` pair they choose, including ones naming sessions that don't even exist yet or belong to other users, without ever touching the database. This is a full compromise with no in-band detection: a forged token verifies exactly like a real one right up until `authenticate`'s session lookup, and a forged token naming a real, currently-valid session is indistinguishable from a real one to every check in this chapter. Rotating either secret invalidates every outstanding token signed with it — every current user is logged out — which is the correct (if blunt) incident response, and the reason both are read from `config.JWT.ACCESS_TOKEN_SECRET` / `REFRESH_TOKEN_SECRET` (sourced from SSM Parameter Store in deployed environments, per `docs/Architecture.md` §2) rather than hardcoded or checked into source.

**Cookie flags on the refresh-token cookie.** These are read from config, not assumed — the exact `res.cookie(...)` call:

```ts
// backend/src/controllers/auth.controller.ts:35-44
const setRefreshTokenCookie = (res: Response, refreshToken: string): void => {
  res.cookie(config.COOKIE.REFRESH_TOKEN_NAME, refreshToken, {
    httpOnly: config.COOKIE.HTTP_ONLY,
    secure: config.COOKIE.SECURE,
    sameSite: config.COOKIE.SAME_SITE,
    path: config.COOKIE.PATH,
    domain: config.COOKIE.DOMAIN,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};
```

...and the actual values those config keys resolve to:

```ts
// backend/src/config/app.config.ts:66-79
COOKIE: {
  REFRESH_TOKEN_NAME: "refresh_token",
  HTTP_ONLY: true,
  SECURE: NODE_ENV !== "development",
  SAME_SITE: "lax" as const,
  PATH: "/",
  // Genuinely optional: `getEnv`'s default mechanism treats an
  // explicit `undefined` default as "no default," which would make this
  // required. Read it directly instead so an unset COOKIE_DOMAIN falls
  // back to `undefined` (host-only cookie) rather than crashing at boot.
  DOMAIN: process.env.COOKIE_DOMAIN || undefined,
},
```

`httpOnly: true` means client-side JavaScript can never read the cookie — the single strongest mitigation against a garden-variety XSS payload exfiltrating the refresh token (an XSS bug could still ride the *access* token held in memory, or make authenticated requests directly, but it cannot read this cookie's value to send elsewhere). `secure` is `true` everywhere except local development, so the cookie is never sent over plain HTTP outside a dev box. `sameSite: "lax"` blocks the cookie from being attached to most cross-site requests (a third-party site's `<img>` or fetch to AstriX won't carry it) while still allowing it on a top-level navigation — the standard, pragmatic default; `"strict"` would additionally break the cookie being sent on the very redirect that completes the OAuth callback flow, which is same-site from the browser's perspective but arrives via a top-level cross-origin navigation from Google.

**No account lockout / no PKCE — flagged explicitly, not implied.** Neither is present in this codebase. There is no failed-login counter, no temporary account lockout after N bad password attempts, and no backoff beyond the generic per-IP rate limiter (`authLimiter`, 5 attempts per window) applied to `/auth/login`. And the Google OAuth flow in `google.provider.ts` does not implement PKCE (`code_verifier`/`code_challenge`) — the authorization URL built in `getGoogleAuthorizationUrl` sets only `client_id`, `redirect_uri`, `response_type`, `scope`, and `state`, with no PKCE parameters, and the token exchange in `exchangeGoogleCodeForProfile` sends no `code_verifier`. Both are discussed further, with the current industry framing, in §7.

---

## 7. Best Practice Check

JWT access token + rotating, single-use refresh token is *itself* the pattern the OAuth 2.0 Security Best Current Practice recommends for exactly this situation — a client (here, a browser SPA) that can't be fully trusted to keep a long-lived credential perfectly secret. Auth0's and Okta's own refresh-token-rotation guidance describes the same shape AstriX implements: rotate on every use, detect reuse of a stale token, and treat detected reuse as a signal to revoke the whole token family rather than just the one request. On that specific, central design question, AstriX matches 2026 industry practice well — this isn't a dated pattern being carried forward out of habit, it's the currently-recommended one, implemented with the reuse-detection branch that's easy to skip and often is skipped in simpler DIY implementations.

Two places are honestly gap-y rather than merely dated:

- **No PKCE on the OAuth flow.** PKCE (Proof Key for Code Exchange, RFC 7636) was originally designed for public clients that can't hold a client secret (mobile/native apps, SPAs doing the OAuth dance directly in the browser), but current OAuth 2.0 Security BCP guidance recommends it for *all* authorization-code flows, confidential clients included, as defense-in-depth against authorization-code interception. AstriX's OAuth flow runs entirely server-side (the backend, not the browser, holds `GOOGLE_CLIENT_SECRET` and performs the code exchange), which is the case PKCE matters least for — the `client_secret` in the token-exchange request is already a meaningful bar against a bare intercepted `code` being redeemed by someone else, since it must be presented alongside the code and never leaves the server. Still, the combination of `client_secret` *and* PKCE is now the recommended default even for confidential/server-side clients precisely because a code alone, if ever exposed through a different avenue (a referrer leak, a logged URL), buys an attacker nothing without a matching verifier. This is a real, reportable gap, not a dated-but-fine choice — closing it would mean generating a `code_verifier`, deriving a `code_challenge`, and threading it through the `state` cookie's neighbor as a second short-lived cookie.
- **No account lockout or exponential backoff on repeated failed logins**, beyond the blanket 5-per-window IP rate limit shared by the whole `/auth/login` endpoint. Current best practice for credential-stuffing and brute-force resistance typically layers a *per-account* signal (not just per-IP) on top of a generic rate limiter — e.g. temporarily locking or step-up-challenging a specific account after N consecutive failures regardless of source IP, since a distributed attacker rotating IPs sails straight through an IP-only limit. AstriX has the IP-based floor but nothing account-scoped. This is a genuine, worth-flagging gap rather than a stylistic choice — the timing-attack mitigation (§6) shows the team is already thinking carefully about this exact endpoint's threat model, which makes the absence of account-level throttling more likely an oversight than a deliberate tradeoff.

Everywhere else covered in this chapter — hashing every persisted secret rather than storing it raw, `httpOnly`/`secure`/`sameSite` cookie flags all set correctly, pinning the JWT algorithm allow-list explicitly, separating authentication from authorization as distinct layers, and using a database TTL index instead of a fragile custom cleanup job — reads as solid, current practice rather than either a gap or a legacy holdover.

---

## 8. Debug Drill

**Scenario:** Users report getting logged out unexpectedly — not on a predictable schedule, not all at once, just occasionally, mid-session, across different accounts. Support has a handful of tickets; nothing in the error tracker points at an obvious exception. Where do you look first, and why?

1. **Separate "logged out" from "seeing errors."** A silent logout in a system built this way almost always means the client's refresh flow failed and fell through to the interceptor's catch branch that clears local auth state and redirects to `/sign-in` — reread the response interceptor's `/auth/refresh` failure path before assuming anything server-side is broken. Confirm first, from a real affected session if you can get one (browser devtools, a support screen-share), whether the network tab shows a `401` on `/auth/refresh` right before the redirect, or whether the redirect happens with no refresh call at all — those are two different bugs with different causes.
2. **If `/auth/refresh` is returning 401**, the next question is *which* branch inside `refreshAccessTokenService` is throwing — "session expired or invalid," "session expired" (TTL-adjacent), or "reuse detected." Each implies a different root cause: reuse-detected at unexpected scale suggests something is calling `/auth/refresh` twice concurrently with the *same* token — a classic bug is a page firing several API calls at once, each independently triggering a refresh instead of sharing one in-flight refresh promise; re-read the client's `isRefreshing`/`failedQueue` guard (`client/src/lib/axios-client.ts`) for a regression there, and check whether some other client surface (a second tab, a mobile client, a retried request after a flaky network) might be presenting a stale refresh token that a legitimate concurrent refresh already rotated away.
3. **If sessions are expiring "early,"** check clock skew between the token issuer and whatever's evaluating `expiresAt` — `calculateExpiryDate` computes off `Date.now()` on the API server at session-creation time; if the API container's clock is wrong (a real risk in container platforms without NTP properly configured) relative to when a client believes 15 minutes or 7 days have passed, expiry checks will look inconsistent to users even though the logic itself is correct. Also check whether `JWT_ACCESS_TOKEN_EXPIRES_IN` / `JWT_REFRESH_TOKEN_EXPIRES_IN` were recently changed in config/SSM for one environment but not another — a shorter-than-expected refresh window reads exactly like "random logouts" from a user's perspective.
4. **If it correlates with a specific action**, check whether that action is one of the ones that deliberately invalidates sessions as a side effect: `changePasswordService` invalidates every *other* session (by design — confirm the affected report isn't simply "I changed my password on my phone and got logged out on my laptop," which is correct behavior, not a bug), and `resetPasswordService` invalidates *all* sessions including the current one. If users are hitting one of these flows without realizing it (e.g. a "change password" button firing unintentionally, or a double-submit), the "random" logout has a deterministic trigger that just isn't obvious from the support ticket alone.
5. **If none of the above line up**, check for infrastructure-level causes outside this chapter's code entirely: are multiple backend instances behind the ALB using different `JWT_ACCESS_TOKEN_SECRET`/`REFRESH_TOKEN_SECRET` values (a bad SSM Parameter Store rollout, a task definition not fully replaced during a deploy) — a token signed by one instance would fail verification on another sharing the same load balancer, producing exactly this "seemingly random" pattern correlated with which container happened to handle a given request.

The general lesson transfers well beyond this codebase: when "auth randomly breaks," the fix is almost never to add more logging to `authenticate` first — it's to identify which of the handful of places that *intentionally* end a session (rotation, reuse detection, explicit invalidation calls, TTL expiry, a secret rotation) is firing, because a revocable-session design has several legitimate reasons to end a session, and the debugging job is disambiguating "working as designed" from "a real bug" before touching any code.
