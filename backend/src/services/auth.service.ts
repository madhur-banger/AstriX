import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { users, accounts, workspaces, roles, workspaceMembers } from "../db/schema";
import { Roles } from "../enums/role.enum";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "../utils/appError";
import { compareValue, hashValue } from "../utils/bcrypt";
import {
  signJwtToken,
  verifyJwtToken,
  calculateExpiryDate,
  accessTokenSignOptions,
  refreshTokenSignOptions,
} from "../utils/jwt";
import { generateInviteCode } from "../utils/uuid";
import { config } from "../config/app.config";
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../providers/email.provider";
import { logger } from "../utils/logger";
import { findAccountByProviderService } from "./account.service";
import {
  createSession,
  getSession,
  rotateSessionToken,
  invalidateSession,
  invalidateAllSessionsForUser,
  invalidateAllSessionsForUserExcept,
  listSessionsForUser,
} from "./redis/session.service";
import { storeToken, consumeToken } from "./redis/token.service";

type TokenPayload = { userId: string; sessionId: string };

interface CreateSessionParams {
  userId: string;
  userAgent?: string;
  ipAddress?: string;
}

interface TokenPairWithSession {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

// A raw token (password reset link, email verification link, refresh token)
// only ever lives in the client's hands and this request's memory - only its
// hash is ever persisted.
const hashToken = (rawToken: string): string =>
  crypto.createHash("sha256").update(rawToken).digest("hex");

const ttlSecondsUntil = (expiresIn: string): number => {
  const expiryDate = calculateExpiryDate(expiresIn);
  return Math.max(1, Math.round((expiryDate.getTime() - Date.now()) / 1000));
};

// ============================================
// SHARED: session + token creation
// used by both email/password login and OAuth
// ============================================

export const createSessionService = async ({
  userId,
  userAgent,
  ipAddress,
}: CreateSessionParams): Promise<TokenPairWithSession> => {
  // A placeholder refresh-token hash is written first so the session id -
  // which the token payload has to carry - exists before the real token can
  // be signed, mirroring the Mongo original's construct-then-save shape.
  const sessionId = await createSession({ userId, userAgent, ipAddress, refreshTokenHash: "" });

  const accessToken = signJwtToken<TokenPayload>({ userId, sessionId }, accessTokenSignOptions);
  const refreshToken = signJwtToken<TokenPayload>({ userId, sessionId }, refreshTokenSignOptions);

  await rotateSessionToken(sessionId, hashToken(refreshToken));

  return { accessToken, refreshToken, sessionId };
};

// ============================================
// REGISTER (email/password)
// ============================================

export const registerUserService = async (body: {
  email: string;
  name: string;
  password: string;
}) => {
  const { email, name, password } = body;

  const { userId, workspaceId } = await db.transaction(async (tx) => {
    const [existingUser] = await tx.select().from(users).where(eq(users.email, email));
    if (existingUser) {
      throw new BadRequestException("Email already exists");
    }

    const passwordHash = await hashValue(password);
    const [user] = await tx.insert(users).values({ email, name, passwordHash }).returning();

    await tx.insert(accounts).values({ userId: user.id, provider: "EMAIL", providerId: email });

    const [ownerRole] = await tx.select().from(roles).where(eq(roles.name, Roles.OWNER));
    if (!ownerRole) {
      throw new NotFoundException("Owner role not found");
    }

    const [workspace] = await tx
      .insert(workspaces)
      .values({
        name: "My Workspace",
        description: `Workspace created for ${user.name}`,
        ownerId: user.id,
        inviteCode: generateInviteCode(),
      })
      .returning();

    await tx.insert(workspaceMembers).values({ userId: user.id, workspaceId: workspace.id, roleId: ownerRole.id });
    await tx.update(users).set({ currentWorkspaceId: workspace.id }).where(eq(users.id, user.id));

    return { userId: user.id, workspaceId: workspace.id };
  });

  // Best-effort, outside the transaction (it already committed - the
  // account exists regardless of what happens here). A hiccup creating the
  // verification token or sending the email must NOT turn into a
  // registration failure; the user can always request a new one later.
  try {
    await requestEmailVerificationService(userId);
  } catch (verificationError) {
    logger.error(
      { err: verificationError },
      "Failed to send verification email during registration"
    );
  }

  return { userId, workspaceId };
};

// ============================================
// LOGIN (email/password)
// ============================================

// A precomputed bcrypt hash with no corresponding real password - compared
// against on the "no such account" branch below purely to burn the same
// ~bcrypt-cost-10 wall-clock time that a real wrong-password comparison
// would, so the two branches aren't distinguishable by response latency.
const DUMMY_PASSWORD_HASH =
  "$2b$10$uoY4NVy6Uns2Luc7jnt9P.hOJUVlz40gP0G0Aunbvk.3vZ3w642ei";

export const verifyUserService = async ({
  email,
  password,
}: {
  email: string;
  password: string;
}) => {
  const account = await findAccountByProviderService("EMAIL", email);

  // Same exception (401) and same message as the wrong-password branch
  // below - a 404 here would make the login endpoint an email enumeration
  // oracle. Burn the same bcrypt cost against a dummy hash first so both
  // branches take statistically indistinguishable time.
  if (!account) {
    await compareValue(password, DUMMY_PASSWORD_HASH);
    throw new UnauthorizedException("Invalid email or password");
  }

  const [user] = await db.select().from(users).where(eq(users.id, account.userId));
  if (!user) {
    throw new NotFoundException("User not found for the given account");
  }

  const isMatch = user.passwordHash ? await compareValue(password, user.passwordHash) : false;
  if (!isMatch) {
    throw new UnauthorizedException("Invalid email or password");
  }

  await db.update(users).set({ lastLogin: new Date() }).where(eq(users.id, user.id));

  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
};

// ============================================
// OAUTH (Google login / registration)
// ============================================

export const loginOrCreateAccountService = async (data: {
  provider: "GOOGLE" | "GITHUB" | "FACEBOOK" | "EMAIL";
  displayName: string;
  providerId: string;
  picture?: string;
  email?: string;
  // Whether the IdP itself confirmed the user controls this email. Only
  // gates auto-linking to a PRE-EXISTING account - a brand new account is
  // always fine to create regardless.
  emailVerified?: boolean;
}) => {
  const { providerId, provider, displayName, email, picture, emailVerified } = data;

  const user = await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.provider, provider), eq(accounts.providerId, providerId)));

    if (account) {
      const [existingUser] = await tx.select().from(users).where(eq(users.id, account.userId));
      if (!existingUser) {
        throw new Error("Account exists but user not found");
      }
      return existingUser;
    }

    let user = email ? (await tx.select().from(users).where(eq(users.email, email)))[0] : undefined;

    if (user) {
      // Auto-linking a new OAuth identity to a PRE-EXISTING account by
      // email match - without the IdP confirming it verified this email, we
      // can't tell "this is genuinely the same person" from "someone
      // registered using someone else's email," so refuse rather than risk
      // linking (and thus granting login access) to the wrong account.
      if (!emailVerified) {
        throw new UnauthorizedException(
          "This email is already registered. Log in with your password, or verify this email with your provider first."
        );
      }
    }

    if (!user) {
      if (!email) {
        throw new BadRequestException("Email is required to create an account");
      }

      const [newUser] = await tx
        .insert(users)
        .values({
          email,
          name: displayName,
          profilePicture: picture || null,
          isEmailVerified: !!emailVerified,
        })
        .returning();
      user = newUser;

      const [ownerRole] = await tx.select().from(roles).where(eq(roles.name, Roles.OWNER));
      if (!ownerRole) {
        throw new NotFoundException("Owner role not found");
      }

      const [workspace] = await tx
        .insert(workspaces)
        .values({
          name: "My Workspace",
          description: `Workspace created for ${user.name}`,
          ownerId: user.id,
          inviteCode: generateInviteCode(),
        })
        .returning();

      await tx.insert(workspaceMembers).values({ userId: user.id, workspaceId: workspace.id, roleId: ownerRole.id });
      await tx.update(users).set({ currentWorkspaceId: workspace.id }).where(eq(users.id, user.id));
      user = { ...user, currentWorkspaceId: workspace.id };
      // If user exists (email match), we don't create a new workspace.
    }

    await tx.insert(accounts).values({ userId: user.id, provider, providerId });

    return user;
  });

  const { passwordHash: _passwordHash, ...safeUser } = user;
  return { user: safeUser };
};

// ============================================
// REFRESH TOKEN
// ============================================

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

// ============================================
// LOGOUT (single session / all sessions)
// ============================================

export const invalidateSessionService = async (sessionId: string, userId: string): Promise<void> => {
  await invalidateSession(sessionId, userId);
};

export const invalidateAllSessionsService = async (userId: string): Promise<void> => {
  await invalidateAllSessionsForUser(userId);
};

export const logoutByRefreshTokenService = async (refreshToken: string): Promise<void> => {
  const result = verifyJwtToken<TokenPayload>(refreshToken, refreshTokenSignOptions.secret);
  if (!result.valid) return;
  await invalidateSession(result.payload.sessionId, result.payload.userId);
};

// ============================================
// SESSION LISTING (manage devices)
// ============================================

export const getUserSessionsService = async (userId: string) => {
  const sessions = await listSessionsForUser(userId);
  return sessions.map((s) => ({
    id: s.sessionId,
    userAgent: s.userAgent,
    ipAddress: s.ipAddress,
    createdAt: s.createdAt,
  }));
};

// ============================================
// PASSWORD RESET
// ============================================

export const requestPasswordResetService = async (email: string): Promise<void> => {
  const [user] = await db.select().from(users).where(eq(users.email, email));

  // Deliberately the same outcome (no error, no distinguishing response)
  // whether or not the account exists - an unauthenticated "does this email
  // have an account" oracle is exactly what this endpoint must not become.
  if (!user) {
    return;
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  await storeToken(
    "pwreset",
    hashToken(rawToken),
    user.id,
    ttlSecondsUntil(config.PASSWORD_RESET_TOKEN_EXPIRES_IN)
  );

  const resetUrl = `${config.FRONTEND_PASSWORD_RESET_URL}?token=${rawToken}`;
  await sendPasswordResetEmail(user.email, resetUrl);
};

export const resetPasswordService = async (rawToken: string, newPassword: string): Promise<void> => {
  const userId = await consumeToken("pwreset", hashToken(rawToken));
  if (!userId) {
    throw new UnauthorizedException("Invalid or expired reset token");
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) {
    throw new NotFoundException("User not found");
  }

  const passwordHash = await hashValue(newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));

  // Single-use: this token (and any siblings from a repeated forgot-password
  // request) is now spent via GETDEL. A password change is also a standard
  // trigger to invalidate existing sessions - if the account was
  // compromised, this resets that too.
  await invalidateAllSessionsForUser(userId);
};

// ============================================
// EMAIL VERIFICATION (advisory only - never gates login)
// ============================================

export const requestEmailVerificationService = async (userId: string): Promise<void> => {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) {
    throw new NotFoundException("User not found");
  }

  if (user.isEmailVerified) {
    throw new BadRequestException("Email is already verified");
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  await storeToken(
    "emailverify",
    hashToken(rawToken),
    user.id,
    ttlSecondsUntil(config.EMAIL_VERIFICATION_TOKEN_EXPIRES_IN)
  );

  const verifyUrl = `${config.FRONTEND_EMAIL_VERIFICATION_URL}?token=${rawToken}`;
  await sendVerificationEmail(user.email, verifyUrl);
};

export const verifyEmailService = async (rawToken: string): Promise<void> => {
  const userId = await consumeToken("emailverify", hashToken(rawToken));
  if (!userId) {
    throw new UnauthorizedException("Invalid or expired verification token");
  }

  await db.update(users).set({ isEmailVerified: true }).where(eq(users.id, userId));
};

// ============================================
// CHANGE PASSWORD (authenticated)
// ============================================

export const changePasswordService = async (
  userId: string,
  currentSessionId: string | undefined,
  currentPassword: string,
  newPassword: string
): Promise<void> => {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) {
    throw new NotFoundException("User not found");
  }

  const isMatch = user.passwordHash ? await compareValue(currentPassword, user.passwordHash) : false;
  if (!isMatch) {
    throw new UnauthorizedException("Current password is incorrect");
  }

  const passwordHash = await hashValue(newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));

  // Invalidate every OTHER session - the caller just proved who they are,
  // so their current device shouldn't be logged out as a side effect of
  // changing their own password. Every other device should be, in case the
  // password change was prompted by a suspected compromise.
  if (currentSessionId) {
    await invalidateAllSessionsForUserExcept(userId, currentSessionId);
  } else {
    await invalidateAllSessionsForUser(userId);
  }
};

// ============================================
// SESSION REVOCATION (single device)
// ============================================

export const revokeSessionService = async (userId: string, sessionId: string): Promise<void> => {
  const session = await getSession(sessionId);
  if (!session) {
    throw new NotFoundException("Session not found");
  }

  if (session.userId !== userId) {
    // Don't leak whether the session id exists at all to a caller who
    // doesn't own it - 404, not 403.
    throw new NotFoundException("Session not found");
  }

  await invalidateSession(sessionId, userId);
};

// ============================================
// AUTHENTICATION (used by the auth middleware)
// ============================================

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
