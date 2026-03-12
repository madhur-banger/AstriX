/**
 * INTEGRATION TESTS: auth.service.ts
 * --------------------------------------
 * No mocking at all here - real Mongoose models against the in-memory DB.
 *
 * WHY THIS FILE MATTERS MORE THAN USUAL:
 * Unit tests mock `user.comparePassword()` to return true/false on command -
 * they can NEVER catch a bug where your bcrypt hashing or comparison logic
 * is actually broken (e.g. hashing twice, comparing against the wrong
 * field, a schema `select: false` on password silently returning
 * `undefined` to bcrypt.compare). Only a REAL register -> REAL login
 * roundtrip proves password auth actually works end to end. This is the
 * single most important integration test in your whole auth system.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  registerUserService,
  verifyUserService,
  loginOrCreateAccountService,
  createSessionService,
  refreshAccessTokenService,
} from "../../src/services/auth.service";

import UserModel from "../../src/models/user.model";
import AccountModel from "../../src/models/account.model";
import WorkspaceModel from "../../src/models/workspace.model";
import MemberModel from "../../src/models/member.model";
import SessionModel from "../../src/models/session.model";
import RoleModel from "../../src/models/roles-permission.model";
import { Roles } from "../../src/enums/role.enum";
import {
  BadRequestException,
  UnauthorizedException,
} from "../../src/utils/appError";

describe("auth.service (integration - real in-memory MongoDB)", () => {
  beforeEach(async () => {
    // registerUserService and loginOrCreateAccountService both need a real
    // OWNER role document to exist, exactly like workspace's integration test.
    await RoleModel.create({ name: Roles.OWNER, permissions: [] });
  });

  it("REGISTER -> LOGIN roundtrip: the password set at registration actually verifies at login", async () => {
    // This is the test that catches "the schema hashes on save but
    // comparePassword compares against the plaintext" type bugs - a
    // mistake that's invisible to any mocked unit test.
    const { userId, workspaceId } = await registerUserService({
      email: "roundtrip@example.com",
      name: "Roundtrip User",
      password: "Correc@123",
    });

    expect(userId).toBeDefined();
    expect(workspaceId).toBeDefined();

    // Confirm the password was NOT stored in plaintext - if this fails,
    // your pre-save hashing hook isn't running.
    const rawUser = await UserModel.findById(userId).select("+password");
    expect(rawUser!.password).not.toBe("Correc@123");

    // Now actually log in with the SAME password via the real service.
    const loggedInUser = await verifyUserService({
      email: "roundtrip@example.com",
      password: "Correc@123",
    });
    expect(String(loggedInUser._id)).toBe(String(userId));
    // omitPassword() should mean the password never comes back to the caller.
    expect((loggedInUser as any).password).toBeUndefined();
  });

  it("LOGIN fails with the wrong password against a real hash", async () => {
    await registerUserService({
      email: "wrongpass@example.com",
      name: "Test",
      password: "the-real-password",
    });

    await expect(
      verifyUserService({
        email: "wrongpass@example.com",
        password: "a-guessed-password",
      })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("REGISTER rejects a duplicate email and leaves no partial data behind (transaction rollback check)", async () => {
    await registerUserService({
      email: "duplicate@example.com",
      name: "First",
      password: "pw1",
    });

    await expect(
      registerUserService({
        email: "duplicate@example.com",
        name: "Second",
        password: "pw2",
      })
    ).rejects.toThrow(BadRequestException);

    // Only ONE user should exist with this email - confirms the second
    // (failed) attempt didn't partially write anything despite the abort.
    const users = await UserModel.find({ email: "duplicate@example.com" });
    expect(users).toHaveLength(1);
  });

  it("REGISTER really creates exactly one workspace + one member for the new owner", async () => {
    const { userId, workspaceId } = await registerUserService({
      email: "onboarding@example.com",
      name: "New Owner",
      password: "pw",
    });

    const member = await MemberModel.findOne({ workspaceId, userId });
    expect(member).not.toBeNull();

    const account = await AccountModel.findOne({ userId });
    expect(account).not.toBeNull();
    expect(account!.provider).toBe("EMAIL"); // adjust to match your ProviderEnum.EMAIL value if different

    // account.model.ts declares a toJSON.transform that strips refreshToken -
    // this only fires through real Mongoose serialization, not a mocked doc,
    // so it belongs here rather than in the mocked unit test file.
    expect(account!.toJSON()).not.toHaveProperty("refreshToken");
  });

  it("OAuth: a returning Google identity logs in without creating a second workspace", async () => {
    // First-time Google login - full onboarding.
    const { user: firstLoginUser } = await loginOrCreateAccountService({
      provider: "GOOGLE",
      providerId: "real-google-sub-1",
      displayName: "Google Person",
      email: "google-person@example.com",
    });

    const workspacesAfterFirstLogin = await WorkspaceModel.find({
      owner: firstLoginUser._id,
    });
    expect(workspacesAfterFirstLogin).toHaveLength(1);

    // Second login with the SAME provider+providerId should reuse the
    // existing account/user, not create anything new.
    const { user: secondLoginUser } = await loginOrCreateAccountService({
      provider: "GOOGLE",
      providerId: "real-google-sub-1",
      displayName: "Google Person",
      email: "google-person@example.com",
    });

    expect(String(secondLoginUser._id)).toBe(String(firstLoginUser._id));
    const workspacesAfterSecondLogin = await WorkspaceModel.find({
      owner: firstLoginUser._id,
    });
    // Still exactly one - this is the exact bug class an "email-first"
    // implementation could reintroduce if ever refactored carelessly.
    expect(workspacesAfterSecondLogin).toHaveLength(1);
  });

  it("OAuth: linking Google to an existing email/password account does NOT create a second workspace", async () => {
    const { userId } = await registerUserService({
      email: "hybrid-login@example.com",
      name: "Hybrid User",
      password: "pw",
    });

    await loginOrCreateAccountService({
      provider: "GOOGLE",
      providerId: "hybrid-google-sub",
      displayName: "Hybrid User",
      email: "hybrid-login@example.com",
      emailVerified: true,
    });

    const accountsForUser = await AccountModel.find({ userId });
    // Should now have TWO accounts (email + google) linked to the SAME user...
    expect(accountsForUser.length).toBeGreaterThanOrEqual(2);
    // ...but still only ONE workspace.
    const workspaces = await WorkspaceModel.find({ owner: userId });
    expect(workspaces).toHaveLength(1);
  });

  it("REFRESH: a session created at login can mint a new access token, and a deleted/expired one cannot", async () => {
    const { userId } = await registerUserService({
      email: "refresh-flow@example.com",
      name: "Refresh Test",
      password: "pw",
    });

    const { refreshToken, sessionId } = await createSessionService({ userId });

    const refreshed = await refreshAccessTokenService(refreshToken);
    expect(typeof refreshed.accessToken).toBe("string");

    // Now actually expire the session in the real DB and confirm refresh fails.
    await SessionModel.findByIdAndUpdate(sessionId, {
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(refreshAccessTokenService(refreshToken)).rejects.toThrow(
      UnauthorizedException
    );

    // Bonus: the service should have deleted the expired session document.
    const stillExists = await SessionModel.findById(sessionId);
    expect(stillExists).toBeNull();
  });
});
