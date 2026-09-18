/**
 * INTEGRATION TESTS: services/auth.service.ts
 * -------------------------------------------------
 * Real Postgres + Redis (testcontainers, see tests/setup/global-setup.ts)
 * via the real Drizzle client and session/token services - no mocks except
 * spying on the email provider to capture raw reset/verification tokens
 * (they're hashed before storage and normally only ever leave the process
 * via the outgoing email). OAuth network calls (Google) are out of scope
 * here - loginOrCreateAccountService itself makes no network calls, only
 * the controller layer does, so it's exercised directly as a plain function.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  registerUserService,
  verifyUserService,
  loginOrCreateAccountService,
  createSessionService,
  refreshAccessTokenService,
  requestPasswordResetService,
  resetPasswordService,
  requestEmailVerificationService,
  verifyEmailService,
  changePasswordService,
  revokeSessionService,
  authenticateAccessTokenService,
  getUserSessionsService,
} from "../../src/services/auth.service";
import { createAccountService } from "../../src/services/account.service";
import * as emailProvider from "../../src/providers/email.provider";
import { db } from "../../src/db/client";
import { redis } from "../../src/redis/client";
import { users, accounts, workspaces, workspaceMembers } from "../../src/db/schema";
import { BadRequestException, NotFoundException, UnauthorizedException } from "../../src/utils/appError";
import { createTestUser, createTestWorkspace } from "../setup/fixtures";

describe("auth.service (integration - real Postgres + Redis via testcontainers)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("registerUserService", () => {
    it("creates user+EMAIL account+OWNER workspace+membership+currentWorkspaceId atomically", async () => {
      const { userId, workspaceId } = await registerUserService({
        email: `register-${Date.now()}@example.com`,
        name: "New User",
        password: "Password1!",
      });

      const [user] = await db.select().from(users).where(eq(users.id, userId));
      expect(user.currentWorkspaceId).toBe(workspaceId);

      const [account] = await db.select().from(accounts).where(eq(accounts.userId, userId));
      expect(account.provider).toBe("EMAIL");

      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
      expect(workspace.ownerId).toBe(userId);

      const [membership] = await db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId));
      expect(membership.userId).toBe(userId);
    });

    it("throws BadRequestException for a duplicate email", async () => {
      const email = `dup-${Date.now()}@example.com`;
      await registerUserService({ email, name: "First", password: "Password1!" });

      await expect(
        registerUserService({ email, name: "Second", password: "Password1!" })
      ).rejects.toThrow(BadRequestException);
    });

    it("still succeeds when the best-effort verification email step no-ops (RESEND_API_KEY unset in test env)", async () => {
      const result = await registerUserService({
        email: `noresend-${Date.now()}@example.com`,
        name: "No Resend",
        password: "Password1!",
      });

      expect(result.userId).toBeTruthy();
    });
  });

  describe("verifyUserService", () => {
    it("throws UnauthorizedException with the same message for a nonexistent email and a wrong password", async () => {
      const user = await createTestUser({ password: "CorrectPass1!" });

      let nonexistentMessage = "";
      let wrongPasswordMessage = "";
      try {
        await verifyUserService({ email: "no-such-user@example.com", password: "whatever" });
      } catch (error) {
        nonexistentMessage = (error as Error).message;
      }
      try {
        await verifyUserService({ email: user.email, password: "WrongPass1!" });
      } catch (error) {
        wrongPasswordMessage = (error as Error).message;
      }

      expect(nonexistentMessage).toBeTruthy();
      expect(nonexistentMessage).toBe(wrongPasswordMessage);
    });

    it("succeeds and updates lastLogin for a correct password, excluding passwordHash", async () => {
      const user = await createTestUser({ password: "CorrectPass1!" });
      await createAccountService({ userId: user.id, provider: "EMAIL", providerId: user.email });

      const result = await verifyUserService({ email: user.email, password: "CorrectPass1!" });

      expect(result).not.toHaveProperty("passwordHash");

      const [refetched] = await db.select().from(users).where(eq(users.id, user.id));
      expect(refetched.lastLogin).not.toBeNull();
    });
  });

  describe("loginOrCreateAccountService", () => {
    it("creates a new user+workspace when no account/email match exists", async () => {
      const { user } = await loginOrCreateAccountService({
        provider: "GOOGLE",
        displayName: "OAuth New",
        providerId: `google-${Date.now()}`,
        email: `oauth-new-${Date.now()}@example.com`,
        emailVerified: true,
      });

      expect(user.currentWorkspaceId).toBeTruthy();
      const memberships = await db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, user.id));
      expect(memberships).toHaveLength(1);
    });

    it("returns the existing user for an existing (provider, providerId) account without creating a second workspace", async () => {
      const providerId = `google-${Date.now()}`;
      const { user: firstUser } = await loginOrCreateAccountService({
        provider: "GOOGLE",
        displayName: "OAuth Repeat",
        providerId,
        email: `oauth-repeat-${Date.now()}@example.com`,
        emailVerified: true,
      });

      const { user: secondUser } = await loginOrCreateAccountService({
        provider: "GOOGLE",
        displayName: "OAuth Repeat",
        providerId,
        email: `oauth-repeat-${Date.now()}@example.com`,
        emailVerified: true,
      });

      expect(secondUser.id).toBe(firstUser.id);
      const workspaceCount = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.ownerId, firstUser.id));
      expect(workspaceCount).toHaveLength(1);
    });

    it("refuses to auto-link when the email matches an existing user but emailVerified is false", async () => {
      const existing = await createTestUser();

      await expect(
        loginOrCreateAccountService({
          provider: "GOOGLE",
          displayName: "Impersonator",
          providerId: `google-${Date.now()}`,
          email: existing.email,
          emailVerified: false,
        })
      ).rejects.toThrow(UnauthorizedException);
    });

    it("links the new account to the existing user without a second workspace when emailVerified is true", async () => {
      const existing = await createTestUser();
      await createTestWorkspace(existing.id);

      const { user } = await loginOrCreateAccountService({
        provider: "GOOGLE",
        displayName: "Verified Link",
        providerId: `google-${Date.now()}`,
        email: existing.email,
        emailVerified: true,
      });

      expect(user.id).toBe(existing.id);
      const workspaceCount = await db.select().from(workspaces).where(eq(workspaces.ownerId, existing.id));
      expect(workspaceCount).toHaveLength(1);
    });
  });

  describe("createSessionService / refreshAccessTokenService", () => {
    it("rejects a token from an invalidated session", async () => {
      const user = await createTestUser();
      const { refreshToken, sessionId } = await createSessionService({ userId: user.id });
      await revokeSessionService(user.id, sessionId).catch(() => undefined);
      await redis.del(`session:${sessionId}`);

      await expect(refreshAccessTokenService(refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it("detects refresh token reuse, kills the session, and rejects the rotated token too", async () => {
      const user = await createTestUser();
      const { refreshToken: originalToken } = await createSessionService({ userId: user.id });

      // JWT `iat` has 1-second resolution: signing the rotated token in the
      // same wall-clock second as the original would produce a byte-identical
      // string (same payload, same iat), defeating the reuse check below.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const { refreshToken: rotatedToken } = await refreshAccessTokenService(originalToken);

      await expect(refreshAccessTokenService(originalToken)).rejects.toThrow(
        "Refresh token reuse detected. Please log in again."
      );

      await expect(refreshAccessTokenService(rotatedToken)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe("requestPasswordResetService / resetPasswordService", () => {
    it("is a silent no-op for an unknown email", async () => {
      await expect(requestPasswordResetService("unknown@example.com")).resolves.toBeUndefined();
    });

    it("resetPasswordService rejects a bogus/never-stored token", async () => {
      await expect(resetPasswordService("bogus-token", "NewPassword1!")).rejects.toThrow(
        "Invalid or expired reset token"
      );
    });

    it("full round trip: capture the raw token via a spy, reset the password, and invalidate all sessions", async () => {
      const user = await createTestUser({ password: "OldPassword1!" });
      await createSessionService({ userId: user.id });
      const spy = vi.spyOn(emailProvider, "sendPasswordResetEmail").mockResolvedValue(undefined);

      await requestPasswordResetService(user.email);

      const resetUrl = spy.mock.calls[0][1];
      const rawToken = new URL(resetUrl).searchParams.get("token");
      expect(rawToken).toBeTruthy();

      const [beforeReset] = await db.select().from(users).where(eq(users.id, user.id));

      await resetPasswordService(rawToken as string, "NewPassword1!");

      const [afterReset] = await db.select().from(users).where(eq(users.id, user.id));
      expect(afterReset.passwordHash).not.toBe(beforeReset.passwordHash);

      const sessions = await getUserSessionsService(user.id);
      expect(sessions).toHaveLength(0);
    });
  });

  describe("requestEmailVerificationService / verifyEmailService", () => {
    it("throws BadRequestException when the user's email is already verified", async () => {
      const user = await createTestUser();
      await db.update(users).set({ isEmailVerified: true }).where(eq(users.id, user.id));

      await expect(requestEmailVerificationService(user.id)).rejects.toThrow(BadRequestException);
    });

    it("full round trip: capture the raw token via a spy and verify the email", async () => {
      const user = await createTestUser();
      const spy = vi.spyOn(emailProvider, "sendVerificationEmail").mockResolvedValue(undefined);

      await requestEmailVerificationService(user.id);

      const verifyUrl = spy.mock.calls[0][1];
      const rawToken = new URL(verifyUrl).searchParams.get("token");
      expect(rawToken).toBeTruthy();

      await verifyEmailService(rawToken as string);

      const [refetched] = await db.select().from(users).where(eq(users.id, user.id));
      expect(refetched.isEmailVerified).toBe(true);
    });
  });

  describe("changePasswordService", () => {
    it("throws UnauthorizedException for a wrong current password", async () => {
      const user = await createTestUser({ password: "CorrectPass1!" });

      await expect(
        changePasswordService(user.id, undefined, "WrongPass1!", "NewPassword1!")
      ).rejects.toThrow(UnauthorizedException);
    });

    it("invalidates all OTHER sessions but keeps the current one", async () => {
      const user = await createTestUser({ password: "CorrectPass1!" });
      const sessionA = await createSessionService({ userId: user.id });
      await createSessionService({ userId: user.id });

      await changePasswordService(user.id, sessionA.sessionId, "CorrectPass1!", "NewPassword1!");

      const sessions = await getUserSessionsService(user.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(sessionA.sessionId);
    });
  });

  describe("revokeSessionService", () => {
    it("throws NotFoundException (not 403) when the session belongs to a different user", async () => {
      const owner = await createTestUser();
      const otherUser = await createTestUser();
      const { sessionId } = await createSessionService({ userId: owner.id });

      await expect(revokeSessionService(otherUser.id, sessionId)).rejects.toThrow(NotFoundException);
    });
  });

  describe("authenticateAccessTokenService", () => {
    it("throws UnauthorizedException for an inactive user", async () => {
      const user = await createTestUser();
      const { accessToken } = await createSessionService({ userId: user.id });
      await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));

      await expect(authenticateAccessTokenService(accessToken)).rejects.toThrow(UnauthorizedException);
    });

    it("throws UnauthorizedException for a session whose isValid isn't \"1\"", async () => {
      const user = await createTestUser();
      const { accessToken, sessionId } = await createSessionService({ userId: user.id });
      await redis.hset(`session:${sessionId}`, { isValid: "0" });

      await expect(authenticateAccessTokenService(accessToken)).rejects.toThrow(UnauthorizedException);
    });
  });
});
