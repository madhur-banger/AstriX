/**
 * UNIT TESTS: auth.service.ts
 * ------------------------------
 * Mocking strategy for this file:
 *   - Every Mongoose MODEL is mocked (UserModel, AccountModel, WorkspaceModel,
 *     RoleModel, SessionModel, MemberModel) - same three shapes you learned
 *     in workspace.service.test.ts (direct call, chained `.session()` call,
 *     and `new Model()` constructors).
 *   - `utils/jwt.ts` functions (generateTokenPair, verifyRefreshToken,
 *     calculateExpiryDate) are NOT mocked - they're deterministic pure
 *     functions once test env secrets are set (see testEnv.setup.ts), so
 *     mocking them would just be extra work for no safety benefit. This is
 *     the "don't over-mock" principle from the README in practice: only
 *     mock things that are slow, external, or non-deterministic (a real DB
 *     call) - not things that are already fast and pure.
 *
 * A NEW MOCKING SHAPE YOU HAVEN'T SEEN YET: mocking a METHOD ON A FAKE
 * DOCUMENT INSTANCE (`user.comparePassword`, `user.omitPassword`). These
 * aren't static Model methods or constructors - they're instance methods
 * defined on the schema (`userSchema.methods.comparePassword = ...`).
 * Because we're mocking the whole UserModel module, a plain object literal
 * we hand back from `UserModel.findById` won't magically have those methods
 * - we have to explicitly add them as `vi.fn()` on our fake object.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";
import crypto from "crypto";

import {
  createSessionService,
  registerUserService,
  verifyUserService,
  loginOrCreateAccountService,
  refreshAccessTokenService,
  invalidateSessionService,
  invalidateAllSessionsService,
  getUserSessionsService,
  findUserByIdService,
  requestPasswordResetService,
  resetPasswordService,
  requestEmailVerificationService,
  verifyEmailService,
  changePasswordService,
  revokeSessionService,
} from "../../../src/services/auth.service";

import UserModel from "../../../src/models/user.model";
import AccountModel from "../../../src/models/account.model";
import WorkspaceModel from "../../../src/models/workspace.model";
import RoleModel from "../../../src/models/roles-permission.model";
import SessionModel from "../../../src/models/session.model";
import MemberModel from "../../../src/models/member.model";
import PasswordResetTokenModel from "../../../src/models/passwordResetToken.model";
import EmailVerificationTokenModel from "../../../src/models/emailVerificationToken.model";
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../../../src/providers/email.provider";

import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "../../../src/utils/appError";
import { generateTokenPair } from "../../../src/utils/jwt";
import {
  buildFakeUser,
  buildFakeAccount,
  buildFakeRole,
  buildFakeSession,
  makeObjectId,
  asConstructorMock,
} from "../../setup/testFixtures";

vi.mock("../../../src/models/user.model");
vi.mock("../../../src/models/account.model");
vi.mock("../../../src/models/workspace.model");
vi.mock("../../../src/models/roles-permission.model");
vi.mock("../../../src/models/session.model");
vi.mock("../../../src/models/member.model");
vi.mock("../../../src/models/passwordResetToken.model");
vi.mock("../../../src/models/emailVerificationToken.model");
// External side effect (would otherwise try to reach Resend) - mocked the
// same way exchangeGoogleCodeForProfile is mocked in the OAuth e2e tests.
vi.mock("../../../src/providers/email.provider");

describe("createSessionService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("creates a session document and returns a matching token pair", async () => {
    const userId = makeObjectId();
    const fakeSession = buildFakeSession({
      userId,
      save: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(SessionModel).mockImplementation(
      asConstructorMock((data: any) => Object.assign(fakeSession, data)) as any
    );

    const result = await createSessionService({
      userId,
      userAgent: "vitest",
      ipAddress: "127.0.0.1",
    });

    expect(fakeSession.userId).toBe(userId);
    expect(fakeSession.userAgent).toBe("vitest");
    expect(fakeSession.ipAddress).toBe("127.0.0.1");
    expect(fakeSession.isValid).toBe(true);
    expect(fakeSession.expiresAt).toEqual(expect.any(Date));
    expect(fakeSession.save).toHaveBeenCalledOnce();
    expect(result.sessionId).toBe(fakeSession._id.toString());
    expect(typeof result.accessToken).toBe("string");
    expect(typeof result.refreshToken).toBe("string");
  });
});

describe("registerUserService", () => {
  let fakeSession: any;

  beforeEach(() => {
    vi.resetAllMocks();
    // Same transaction-mocking approach as deleteWorkspaceService: spy on
    // mongoose.startSession rather than mocking the whole mongoose module,
    // so real ObjectId/date behavior elsewhere stays intact.
    fakeSession = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      abortTransaction: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn(),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValue(fakeSession);
  });

  it("throws BadRequestException and aborts when the email is already registered", async () => {
    vi.mocked(UserModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(buildFakeUser()),
    } as any);

    await expect(
      registerUserService({
        email: "taken@example.com",
        name: "X",
        password: "pw",
      })
    ).rejects.toThrow(BadRequestException);

    expect(fakeSession.abortTransaction).toHaveBeenCalledOnce();
    expect(fakeSession.commitTransaction).not.toHaveBeenCalled();
    // finally block should ALWAYS end the session, success or failure
    expect(fakeSession.endSession).toHaveBeenCalledOnce();
  });

  it("throws NotFoundException and aborts when the OWNER role is missing", async () => {
    vi.mocked(UserModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);

    vi.mocked(UserModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({
            ...data,
            _id: makeObjectId(),
            save: vi.fn().mockResolvedValue(undefined),
          }) as any
      )
    );
    vi.mocked(AccountModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({ ...data, save: vi.fn().mockResolvedValue(undefined) }) as any
      )
    );
    vi.mocked(WorkspaceModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({
            ...data,
            _id: makeObjectId(),
            save: vi.fn().mockResolvedValue(undefined),
          }) as any
      )
    );

    vi.mocked(RoleModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null), // no OWNER role seeded
    } as any);

    await expect(
      registerUserService({
        email: "new@example.com",
        name: "New",
        password: "pw",
      })
    ).rejects.toThrow(NotFoundException);

    expect(fakeSession.abortTransaction).toHaveBeenCalledOnce();
  });

  it("creates user, account, workspace, and member, sets current workspace, and commits on success", async () => {
    vi.mocked(UserModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);

    const newUserSave = vi.fn().mockResolvedValue(undefined);
    let capturedUser: any;

    vi.mocked(UserModel).mockImplementation(
      asConstructorMock((data: any) => {
        capturedUser = {
          ...data,
          _id: makeObjectId(),
          currentWorkspace: null,
          save: newUserSave,
        };

        return capturedUser;
      })
    );

    const accountSave = vi.fn().mockResolvedValue(undefined);

    vi.mocked(AccountModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({
            ...data,
            save: accountSave,
          }) as any
      )
    );

    const workspaceSave = vi.fn().mockResolvedValue(undefined);
    const newWorkspaceId = makeObjectId();

    vi.mocked(WorkspaceModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({
            ...data,
            _id: newWorkspaceId,
            save: workspaceSave,
          }) as any
      )
    );

    vi.mocked(RoleModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(buildFakeRole({ name: "OWNER" })),
    } as any);

    const memberSave = vi.fn().mockResolvedValue(undefined);

    vi.mocked(MemberModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({
            ...data,
            save: memberSave,
          }) as any
      )
    );

    // requestEmailVerificationService (called best-effort, post-commit) looks
    // the user back up by id - wire it to resolve to the same captured user.
    vi.mocked(UserModel.findById).mockImplementation(
      () => Promise.resolve(capturedUser) as any
    );
    vi.mocked(EmailVerificationTokenModel.deleteMany).mockResolvedValue(
      {} as any
    );
    vi.mocked(EmailVerificationTokenModel.create).mockResolvedValue({} as any);

    const result = await registerUserService({
      email: "brandnew@example.com",
      name: "Brand New",
      password: "hunter2",
    });

    // First save creates the user.
    // Second save persists currentWorkspace after workspace creation.
    expect(newUserSave).toHaveBeenCalledTimes(2);

    expect(accountSave).toHaveBeenCalledOnce();
    expect(workspaceSave).toHaveBeenCalledOnce();
    expect(memberSave).toHaveBeenCalledOnce();

    expect(capturedUser.currentWorkspace).toBe(newWorkspaceId);

    expect(fakeSession.commitTransaction).toHaveBeenCalledOnce();
    expect(fakeSession.abortTransaction).not.toHaveBeenCalled();
    expect(fakeSession.endSession).toHaveBeenCalledOnce();

    expect(result.workspaceId).toBe(newWorkspaceId);

    // Best-effort verification email, issued AFTER the transaction commits.
    expect(EmailVerificationTokenModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: capturedUser._id })
    );
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      capturedUser.email,
      expect.stringContaining("?token=")
    );
  });

  it("still resolves successfully even if issuing the verification email fails (best-effort, doesn't block registration)", async () => {
    vi.mocked(UserModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);

    let capturedUser: any;
    vi.mocked(UserModel).mockImplementation(
      asConstructorMock((data: any) => {
        capturedUser = {
          ...data,
          _id: makeObjectId(),
          currentWorkspace: null,
          save: vi.fn().mockResolvedValue(undefined),
        };
        return capturedUser;
      })
    );
    vi.mocked(AccountModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({ ...data, save: vi.fn().mockResolvedValue(undefined) }) as any
      )
    );
    vi.mocked(WorkspaceModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({
            ...data,
            _id: makeObjectId(),
            save: vi.fn().mockResolvedValue(undefined),
          }) as any
      )
    );
    vi.mocked(RoleModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(buildFakeRole({ name: "OWNER" })),
    } as any);
    vi.mocked(MemberModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({ ...data, save: vi.fn().mockResolvedValue(undefined) }) as any
      )
    );

    // The post-commit best-effort call fails outright (e.g. a DB hiccup).
    vi.mocked(UserModel.findById).mockImplementation(() => {
      throw new Error("unexpected DB hiccup");
    });

    const result = await registerUserService({
      email: "resilient@example.com",
      name: "Resilient",
      password: "hunter2",
    });

    expect(result.userId).toBe(capturedUser._id);
    expect(fakeSession.commitTransaction).toHaveBeenCalledOnce();
  });
});

describe("verifyUserService (login)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws UnauthorizedException (not NotFoundException) when no account exists for the email/provider, to avoid email enumeration", async () => {
    vi.mocked(AccountModel.findOne).mockResolvedValue(null as any);

    await expect(
      verifyUserService({ email: "nobody@example.com", password: "pw" })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("throws NotFoundException when the account exists but its user was deleted", async () => {
    vi.mocked(AccountModel.findOne).mockResolvedValue(
      buildFakeAccount() as any
    );
    vi.mocked(UserModel.findById).mockResolvedValue(null as any);

    await expect(
      verifyUserService({ email: "orphaned@example.com", password: "pw" })
    ).rejects.toThrow(NotFoundException);
  });

  it("throws UnauthorizedException when the password doesn't match", async () => {
    vi.mocked(AccountModel.findOne).mockResolvedValue(
      buildFakeAccount() as any
    );
    const fakeUser = buildFakeUser();
    (fakeUser as any).comparePassword = vi.fn().mockResolvedValue(false);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    await expect(
      verifyUserService({
        email: "test@example.com",
        password: "wrong-password",
      })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("returns the sanitized (password-omitted) user on success", async () => {
    vi.mocked(AccountModel.findOne).mockResolvedValue(
      buildFakeAccount() as any
    );
    const fakeUser = buildFakeUser();
    (fakeUser as any).comparePassword = vi.fn().mockResolvedValue(true);
    const sanitizedUser = { ...fakeUser, password: undefined };
    (fakeUser as any).omitPassword = vi.fn().mockReturnValue(sanitizedUser);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    const result = await verifyUserService({
      email: "test@example.com",
      password: "correct-password",
    });

    expect((fakeUser as any).comparePassword).toHaveBeenCalledWith(
      "correct-password"
    );
    expect(result).toBe(sanitizedUser);
  });
});

describe("loginOrCreateAccountService (OAuth)", () => {
  // NOTE: this service's logic is "account-first", not "email-first":
  //   1. Look up an Account by (provider, providerId) - this is the row that
  //      links "this specific Google/GitHub/etc identity" to a User.
  //   2. If found -> the user has logged in with this provider before.
  //      Just load their User by account.userId. No new documents at all.
  //   3. If NOT found -> this identity has never been linked. THEN look up
  //      a User by email:
  //        a. User exists (they signed up with email/password before, and
  //           are now linking Google for the first time) -> create ONLY a
  //           new Account row linking the two. Do NOT create a new workspace.
  //        b. User doesn't exist at all -> full first-time onboarding:
  //           create User + Workspace + Member + Account.
  // Each of the four paths below is a DIFFERENT branch through that logic -
  // the whole reason a service like this deserves this many tests is that
  // getting any ONE of these branches wrong either double-creates a
  // workspace for a returning user, or fails to link accounts correctly.

  let fakeSession: any;

  beforeEach(() => {
    vi.resetAllMocks();
    fakeSession = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      abortTransaction: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn(),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValue(fakeSession);
  });

  it("PATH 1 - account already linked: returns the existing user, creates nothing new", async () => {
    const existingUser = buildFakeUser({ email: "already-here@example.com" });
    vi.mocked(AccountModel.findOne).mockReturnValue({
      session: vi
        .fn()
        .mockResolvedValue(buildFakeAccount({ userId: existingUser._id })),
    } as any);
    vi.mocked(UserModel.findById).mockReturnValue({
      session: vi.fn().mockResolvedValue(existingUser),
    } as any);

    const result = await loginOrCreateAccountService({
      provider: "google",
      providerId: "google-sub-123",
      displayName: "Existing Person",
      email: "already-here@example.com",
    });

    expect(result.user).toBe(existingUser);
    // The whole point of this path is that NOTHING new gets constructed.
    expect(UserModel).not.toHaveBeenCalled();
    expect(AccountModel).not.toHaveBeenCalled(); // findOne is a static call, not `new`
    expect(WorkspaceModel).not.toHaveBeenCalled();
    expect(MemberModel).not.toHaveBeenCalled();
    expect(fakeSession.commitTransaction).toHaveBeenCalledOnce();
  });

  it("PATH 1b - account linked but its user was deleted: throws a plain Error (documents current behavior)", async () => {
    // Like changeMemberRoleService in the workspace file, this branch
    // throws a bare `new Error(...)` instead of a NotFoundException like
    // most of this file's other guard clauses. Worth normalizing later,
    // but this test locks in what happens TODAY.
    vi.mocked(AccountModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(buildFakeAccount()),
    } as any);
    vi.mocked(UserModel.findById).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);

    await expect(
      loginOrCreateAccountService({
        provider: "google",
        providerId: "orphaned-sub",
        displayName: "Orphan",
        email: "orphan@example.com",
      })
    ).rejects.toThrow(Error);

    expect(fakeSession.abortTransaction).toHaveBeenCalledOnce();
  });

  it("PATH 2a - no account yet, but a user with this email already exists AND the IdP verified the email: links the account, creates NO new workspace", async () => {
    const existingUser = buildFakeUser({
      email: "email-password-user@example.com",
    });

    vi.mocked(AccountModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null), // no account linked yet
    } as any);
    vi.mocked(UserModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(existingUser), // but the user exists by email
    } as any);

    const newAccountSave = vi.fn().mockResolvedValue(undefined);
    vi.mocked(AccountModel).mockImplementation(
      asConstructorMock(
        (data: any) => ({ ...data, save: newAccountSave }) as any
      )
    );

    const result = await loginOrCreateAccountService({
      provider: "google",
      providerId: "new-google-sub",
      displayName: "Doesn't matter here",
      email: "email-password-user@example.com",
      emailVerified: true,
    });

    // Exactly ONE new document should be created: the linking Account.
    expect(newAccountSave).toHaveBeenCalledOnce();
    expect(UserModel).not.toHaveBeenCalled(); // no NEW user constructed
    expect(WorkspaceModel).not.toHaveBeenCalled(); // critical: no duplicate workspace
    expect(MemberModel).not.toHaveBeenCalled();
    expect(result.user).toBe(existingUser);
    expect(fakeSession.commitTransaction).toHaveBeenCalledOnce();
  });

  it("PATH 2a - refuses to link when the IdP did NOT verify the email (account-takeover guard)", async () => {
    const existingUser = buildFakeUser({
      email: "email-password-user@example.com",
    });

    vi.mocked(AccountModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);
    vi.mocked(UserModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(existingUser),
    } as any);

    await expect(
      loginOrCreateAccountService({
        provider: "google",
        providerId: "new-google-sub",
        displayName: "Attacker-controlled display name",
        email: "email-password-user@example.com",
        emailVerified: false,
      })
    ).rejects.toThrow(UnauthorizedException);

    // Nothing should be created or linked on the refused path.
    expect(AccountModel).not.toHaveBeenCalled();
    expect(fakeSession.abortTransaction).toHaveBeenCalledOnce();
  });

  it("PATH 2b - brand new identity AND brand new email: full onboarding (user + workspace + member + account)", async () => {
    vi.mocked(AccountModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);
    vi.mocked(UserModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);

    const userSave = vi.fn().mockResolvedValue(undefined);
    let capturedUser: any;
    vi.mocked(UserModel).mockImplementation(
      asConstructorMock((data: any) => {
        capturedUser = {
          ...data,
          _id: makeObjectId(),
          currentWorkspace: null,
          save: userSave,
        };
        return capturedUser;
      })
    );

    const workspaceSave = vi.fn().mockResolvedValue(undefined);
    const newWorkspaceId = makeObjectId();
    vi.mocked(WorkspaceModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({ ...data, _id: newWorkspaceId, save: workspaceSave }) as any
      )
    );

    vi.mocked(RoleModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(buildFakeRole({ name: "OWNER" })),
    } as any);

    const memberSave = vi.fn().mockResolvedValue(undefined);
    vi.mocked(MemberModel).mockImplementation(
      asConstructorMock((data: any) => ({ ...data, save: memberSave }) as any)
    );

    const accountSave = vi.fn().mockResolvedValue(undefined);
    vi.mocked(AccountModel).mockImplementation(
      asConstructorMock((data: any) => ({ ...data, save: accountSave }) as any)
    );

    const result = await loginOrCreateAccountService({
      provider: "google",
      providerId: "google-sub-456",
      displayName: "New Google User",
      email: "brand-new-oauth@example.com",
      picture: "https://example.com/pic.jpg",
      emailVerified: true,
    });

    expect(capturedUser.profilePicture).toBe("https://example.com/pic.jpg");
    // A brand new account trusts the IdP's verification status directly -
    // no pre-existing identity is being taken over, so there's no
    // link-hijacking risk here (unlike PATH 2a above).
    expect(capturedUser.isEmailVerified).toBe(true);
    expect(workspaceSave).toHaveBeenCalledOnce();
    expect(memberSave).toHaveBeenCalledOnce();
    expect(accountSave).toHaveBeenCalledOnce();
    expect(capturedUser.currentWorkspace).toBe(newWorkspaceId);
    expect(result.user).toBe(capturedUser);
    expect(fakeSession.commitTransaction).toHaveBeenCalledOnce();
  });

  it("PATH 2b - throws NotFoundException and aborts when the OWNER role is missing during first-time onboarding", async () => {
    vi.mocked(AccountModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);
    vi.mocked(UserModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);
    vi.mocked(UserModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({
            ...data,
            _id: makeObjectId(),
            save: vi.fn().mockResolvedValue(undefined),
          }) as any
      )
    );
    vi.mocked(WorkspaceModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({
            ...data,
            _id: makeObjectId(),
            save: vi.fn().mockResolvedValue(undefined),
          }) as any
      )
    );
    vi.mocked(RoleModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null), // no OWNER role seeded
    } as any);

    await expect(
      loginOrCreateAccountService({
        provider: "google",
        providerId: "sub-999",
        displayName: "X",
        email: "x@example.com",
      })
    ).rejects.toThrow(NotFoundException);

    expect(fakeSession.abortTransaction).toHaveBeenCalledOnce();
  });

  it("PATH 2b - defaults profilePicture to null when no picture is provided", async () => {
    vi.mocked(AccountModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);
    vi.mocked(UserModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);

    let capturedUser: any;
    vi.mocked(UserModel).mockImplementation(
      asConstructorMock((data: any) => {
        capturedUser = {
          ...data,
          _id: makeObjectId(),
          save: vi.fn().mockResolvedValue(undefined),
        };
        return capturedUser;
      })
    );
    vi.mocked(WorkspaceModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({
            ...data,
            _id: makeObjectId(),
            save: vi.fn().mockResolvedValue(undefined),
          }) as any
      )
    );
    vi.mocked(RoleModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(buildFakeRole()),
    } as any);
    vi.mocked(MemberModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({ ...data, save: vi.fn().mockResolvedValue(undefined) }) as any
      )
    );
    vi.mocked(AccountModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({ ...data, save: vi.fn().mockResolvedValue(undefined) }) as any
      )
    );

    await loginOrCreateAccountService({
      provider: "google",
      providerId: "sub-789",
      displayName: "No Picture Person",
      email: "no-picture@example.com",
      // picture AND emailVerified intentionally omitted
    });

    expect(capturedUser.profilePicture).toBeNull();
    // emailVerified omitted -> conservative default of false, same as
    // google.provider.ts's own conservative default for a missing field.
    expect(capturedUser.isEmailVerified).toBe(false);
  });
});

describe("refreshAccessTokenService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws UnauthorizedException for a garbage/malformed refresh token", async () => {
    // No mocking required here at all - a real invalid string fails real
    // JWT verification, exactly like it would in production.
    await expect(refreshAccessTokenService("not-a-real-token")).rejects.toThrow(
      UnauthorizedException
    );
  });

  it("throws UnauthorizedException when the session no longer exists in the DB", async () => {
    const userId = makeObjectId();
    const { refreshToken } = generateTokenPair(userId, "missing-session-id");
    vi.mocked(SessionModel.findById).mockResolvedValue(null as any);

    await expect(refreshAccessTokenService(refreshToken)).rejects.toThrow(
      UnauthorizedException
    );
  });

  it("throws UnauthorizedException when the session exists but isValid is false", async () => {
    const userId = makeObjectId();
    const { refreshToken } = generateTokenPair(userId, "revoked-session-id");
    vi.mocked(SessionModel.findById).mockResolvedValue(
      buildFakeSession({ isValid: false }) as any
    );

    await expect(refreshAccessTokenService(refreshToken)).rejects.toThrow(
      UnauthorizedException
    );
  });

  it("deletes the session and throws when it's past its expiresAt", async () => {
    const userId = makeObjectId();
    const { refreshToken } = generateTokenPair(userId, "expired-session-id");
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    vi.mocked(SessionModel.findById).mockResolvedValue(
      buildFakeSession({ isValid: true, expiresAt: oneHourAgo }) as any
    );
    vi.mocked(SessionModel.findByIdAndDelete).mockResolvedValue(
      undefined as any
    );

    await expect(refreshAccessTokenService(refreshToken)).rejects.toThrow(
      UnauthorizedException
    );
    expect(SessionModel.findByIdAndDelete).toHaveBeenCalledWith(
      "expired-session-id"
    );
  });

  it("returns a fresh access token when the session is valid and unexpired", async () => {
    const userId = makeObjectId();
    const { refreshToken } = generateTokenPair(userId, "good-session-id");
    vi.mocked(SessionModel.findById).mockResolvedValue(
      buildFakeSession({
        isValid: true, // default expiresAt is 1 hour from now
        save: vi.fn().mockResolvedValue(undefined),
      }) as any
    );

    const result = await refreshAccessTokenService(refreshToken);

    expect(typeof result.accessToken).toBe("string");
  });

  it("rotates the refresh token in place, persisting the new hash on the same session", async () => {
    const userId = makeObjectId();
    const { refreshToken } = generateTokenPair(userId, "good-session-id");
    const fakeSession = buildFakeSession({
      isValid: true,
      refreshTokenHash: undefined, // pre-rotation session, adopted on first refresh
      save: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(SessionModel.findById).mockResolvedValue(fakeSession as any);

    const result = await refreshAccessTokenService(refreshToken);

    // JWTs carry a second-granularity `iat`, so two tokens signed in the
    // same test tick can be byte-identical strings - the meaningful proof
    // of rotation is that the session now persists the hash of whatever
    // refresh token was actually just returned to the caller.
    const expectedHash = crypto
      .createHash("sha256")
      .update(result.refreshToken)
      .digest("hex");
    expect(fakeSession.save).toHaveBeenCalledOnce();
    expect(fakeSession.refreshTokenHash).toBe(expectedHash);
  });

  it("kills the session and rejects when a refresh token is reused after rotation", async () => {
    const userId = makeObjectId();
    const { refreshToken: staleToken } = generateTokenPair(
      userId,
      "stolen-session-id"
    );
    // The session already rotated to a different hash - `staleToken`'s hash
    // no longer matches, simulating a stolen/replayed refresh token.
    vi.mocked(SessionModel.findById).mockResolvedValue(
      buildFakeSession({
        isValid: true,
        refreshTokenHash: "some-other-hash-from-a-later-rotation",
      }) as any
    );
    vi.mocked(SessionModel.findByIdAndUpdate).mockResolvedValue(
      undefined as any
    );

    await expect(refreshAccessTokenService(staleToken)).rejects.toThrow(
      UnauthorizedException
    );
    expect(SessionModel.findByIdAndUpdate).toHaveBeenCalledWith(
      "stolen-session-id",
      expect.objectContaining({ isValid: false })
    );
  });
});

describe("invalidateSessionService / invalidateAllSessionsService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("marks a single session invalid by id", async () => {
    vi.mocked(SessionModel.findByIdAndUpdate).mockResolvedValue(
      undefined as any
    );

    await invalidateSessionService("session-id-1");

    expect(SessionModel.findByIdAndUpdate).toHaveBeenCalledWith(
      "session-id-1",
      {
        isValid: false,
      }
    );
  });

  it("marks ALL of a user's sessions invalid ('log out everywhere')", async () => {
    vi.mocked(SessionModel.updateMany).mockResolvedValue(undefined as any);
    const userId = makeObjectId();

    await invalidateAllSessionsService(userId);

    expect(SessionModel.updateMany).toHaveBeenCalledWith(
      { userId },
      { isValid: false }
    );
  });
});

describe("getUserSessionsService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("queries for only valid, unexpired sessions and selects limited fields", async () => {
    const fakeSessions = [buildFakeSession(), buildFakeSession()];
    const selectMock = vi.fn().mockResolvedValue(fakeSessions);
    vi.mocked(SessionModel.find).mockReturnValue({ select: selectMock } as any);

    const userId = makeObjectId();
    const result = await getUserSessionsService(userId);

    expect(SessionModel.find).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        isValid: true,
        expiresAt: expect.objectContaining({ $gt: expect.any(Date) }),
      })
    );
    expect(selectMock).toHaveBeenCalledWith("userAgent ipAddress createdAt");
    expect(result).toBe(fakeSessions);
  });
});

describe("findUserByIdService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("looks up a user by id while excluding the password field", async () => {
    const fakeUser = buildFakeUser();
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    const result = await findUserByIdService(String(fakeUser._id));

    expect(UserModel.findById).toHaveBeenCalledWith(String(fakeUser._id), {
      password: false,
    });
    expect(result).toBe(fakeUser);
  });
});

describe("requestPasswordResetService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("no-ops silently for an unknown email (never reveals whether the account exists)", async () => {
    vi.mocked(UserModel.findOne).mockResolvedValue(null as any);

    await requestPasswordResetService("nobody@example.com");

    expect(PasswordResetTokenModel.deleteMany).not.toHaveBeenCalled();
    expect(PasswordResetTokenModel.create).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("clears prior tokens, issues a new one, and emails a link containing it, for a known email", async () => {
    const fakeUser = buildFakeUser({ email: "known@example.com" });
    vi.mocked(UserModel.findOne).mockResolvedValue(fakeUser as any);
    vi.mocked(PasswordResetTokenModel.deleteMany).mockResolvedValue({} as any);
    vi.mocked(PasswordResetTokenModel.create).mockResolvedValue({} as any);

    await requestPasswordResetService("known@example.com");

    expect(PasswordResetTokenModel.deleteMany).toHaveBeenCalledWith({
      userId: fakeUser._id,
    });
    expect(PasswordResetTokenModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: fakeUser._id,
        tokenHash: expect.any(String),
        expiresAt: expect.any(Date),
      })
    );
    // The hash is 64 hex chars (SHA-256), never the raw token itself.
    const createCall = vi.mocked(PasswordResetTokenModel.create).mock
      .calls[0][0] as any;
    expect(createCall.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      "known@example.com",
      expect.stringContaining("?token=")
    );
  });
});

describe("resetPasswordService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws UnauthorizedException for an unknown token", async () => {
    vi.mocked(PasswordResetTokenModel.findOne).mockResolvedValue(null as any);

    await expect(
      resetPasswordService("garbage-token", "NewPassword@123")
    ).rejects.toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException and deletes the record for an expired token", async () => {
    const expiredToken = {
      _id: makeObjectId(),
      userId: makeObjectId(),
      expiresAt: new Date(Date.now() - 60 * 1000),
    };
    vi.mocked(PasswordResetTokenModel.findOne).mockResolvedValue(
      expiredToken as any
    );
    vi.mocked(PasswordResetTokenModel.findByIdAndDelete).mockResolvedValue(
      {} as any
    );

    await expect(
      resetPasswordService("expired-token", "NewPassword@123")
    ).rejects.toThrow(UnauthorizedException);

    expect(PasswordResetTokenModel.findByIdAndDelete).toHaveBeenCalledWith(
      expiredToken._id
    );
  });

  it("throws NotFoundException when the token is valid but its user no longer exists", async () => {
    const validToken = {
      _id: makeObjectId(),
      userId: makeObjectId(),
      expiresAt: new Date(Date.now() + 60 * 1000),
    };
    vi.mocked(PasswordResetTokenModel.findOne).mockResolvedValue(
      validToken as any
    );
    vi.mocked(UserModel.findById).mockResolvedValue(null as any);

    await expect(
      resetPasswordService("valid-token", "NewPassword@123")
    ).rejects.toThrow(NotFoundException);
  });

  it("updates the password, deletes all reset tokens for the user, and invalidates all sessions on success", async () => {
    const userId = makeObjectId();
    const validToken = {
      _id: makeObjectId(),
      userId,
      expiresAt: new Date(Date.now() + 60 * 1000),
    };
    const fakeUser = buildFakeUser({ _id: userId });
    fakeUser.save = vi.fn().mockResolvedValue(undefined);

    vi.mocked(PasswordResetTokenModel.findOne).mockResolvedValue(
      validToken as any
    );
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(PasswordResetTokenModel.deleteMany).mockResolvedValue({} as any);
    vi.mocked(SessionModel.updateMany).mockResolvedValue({} as any);

    await resetPasswordService("valid-token", "NewPassword@123");

    expect((fakeUser as any).password).toBe("NewPassword@123");
    expect(fakeUser.save).toHaveBeenCalledOnce();
    expect(PasswordResetTokenModel.deleteMany).toHaveBeenCalledWith({ userId });
    expect(SessionModel.updateMany).toHaveBeenCalledWith(
      { userId },
      { isValid: false }
    );
  });
});

describe("requestEmailVerificationService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws NotFoundException when the user doesn't exist", async () => {
    vi.mocked(UserModel.findById).mockResolvedValue(null as any);

    await expect(requestEmailVerificationService("missing-id")).rejects.toThrow(
      NotFoundException
    );
  });

  it("throws BadRequestException when the email is already verified", async () => {
    vi.mocked(UserModel.findById).mockResolvedValue(
      buildFakeUser({ isEmailVerified: true }) as any
    );

    await expect(requestEmailVerificationService("user-id")).rejects.toThrow(
      BadRequestException
    );
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("clears prior tokens, issues a new one, and emails a link containing it", async () => {
    const fakeUser = buildFakeUser({ isEmailVerified: false });
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(EmailVerificationTokenModel.deleteMany).mockResolvedValue(
      {} as any
    );
    vi.mocked(EmailVerificationTokenModel.create).mockResolvedValue({} as any);

    await requestEmailVerificationService(String(fakeUser._id));

    expect(EmailVerificationTokenModel.deleteMany).toHaveBeenCalledWith({
      userId: fakeUser._id,
    });
    expect(EmailVerificationTokenModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: fakeUser._id,
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        expiresAt: expect.any(Date),
      })
    );
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      fakeUser.email,
      expect.stringContaining("?token=")
    );
  });
});

describe("verifyEmailService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws UnauthorizedException for an unknown token", async () => {
    vi.mocked(EmailVerificationTokenModel.findOne).mockResolvedValue(
      null as any
    );

    await expect(verifyEmailService("garbage-token")).rejects.toThrow(
      UnauthorizedException
    );
  });

  it("throws UnauthorizedException and deletes the record for an expired token", async () => {
    const expiredToken = {
      _id: makeObjectId(),
      userId: makeObjectId(),
      expiresAt: new Date(Date.now() - 60 * 1000),
    };
    vi.mocked(EmailVerificationTokenModel.findOne).mockResolvedValue(
      expiredToken as any
    );
    vi.mocked(EmailVerificationTokenModel.findByIdAndDelete).mockResolvedValue(
      {} as any
    );

    await expect(verifyEmailService("expired-token")).rejects.toThrow(
      UnauthorizedException
    );
    expect(EmailVerificationTokenModel.findByIdAndDelete).toHaveBeenCalledWith(
      expiredToken._id
    );
  });

  it("throws NotFoundException when the token is valid but its user no longer exists", async () => {
    const validToken = {
      _id: makeObjectId(),
      userId: makeObjectId(),
      expiresAt: new Date(Date.now() + 60 * 1000),
    };
    vi.mocked(EmailVerificationTokenModel.findOne).mockResolvedValue(
      validToken as any
    );
    vi.mocked(UserModel.findById).mockResolvedValue(null as any);

    await expect(verifyEmailService("valid-token")).rejects.toThrow(
      NotFoundException
    );
  });

  it("marks the user verified and deletes all verification tokens for them on success", async () => {
    const userId = makeObjectId();
    const validToken = {
      _id: makeObjectId(),
      userId,
      expiresAt: new Date(Date.now() + 60 * 1000),
    };
    const fakeUser = buildFakeUser({ _id: userId, isEmailVerified: false });
    fakeUser.save = vi.fn().mockResolvedValue(undefined);

    vi.mocked(EmailVerificationTokenModel.findOne).mockResolvedValue(
      validToken as any
    );
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(EmailVerificationTokenModel.deleteMany).mockResolvedValue(
      {} as any
    );

    await verifyEmailService("valid-token");

    expect((fakeUser as any).isEmailVerified).toBe(true);
    expect(fakeUser.save).toHaveBeenCalledOnce();
    expect(EmailVerificationTokenModel.deleteMany).toHaveBeenCalledWith({
      userId,
    });
  });
});

describe("changePasswordService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws NotFoundException when the user doesn't exist", async () => {
    vi.mocked(UserModel.findById).mockResolvedValue(null as any);

    await expect(
      changePasswordService("missing-id", "session-id", "old", "New@Password1")
    ).rejects.toThrow(NotFoundException);
  });

  it("throws UnauthorizedException when the current password is wrong", async () => {
    const fakeUser = buildFakeUser();
    fakeUser.comparePassword = vi.fn().mockResolvedValue(false);
    fakeUser.save = vi.fn().mockResolvedValue(undefined);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    await expect(
      changePasswordService(
        String(fakeUser._id),
        "session-id",
        "wrong",
        "New@Password1"
      )
    ).rejects.toThrow(UnauthorizedException);
    expect(fakeUser.save).not.toHaveBeenCalled();
  });

  it("updates the password and invalidates every OTHER session, keeping the current one alive", async () => {
    const fakeUser = buildFakeUser();
    fakeUser.comparePassword = vi.fn().mockResolvedValue(true);
    fakeUser.save = vi.fn().mockResolvedValue(undefined);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(SessionModel.updateMany).mockResolvedValue({} as any);

    await changePasswordService(
      String(fakeUser._id),
      "current-session-id",
      "CorrectOld@1",
      "New@Password1"
    );

    expect((fakeUser as any).password).toBe("New@Password1");
    expect(fakeUser.save).toHaveBeenCalledOnce();
    expect(SessionModel.updateMany).toHaveBeenCalledWith(
      { userId: fakeUser._id, _id: { $ne: "current-session-id" } },
      { isValid: false }
    );
  });

  it("invalidates ALL sessions when no current session id is available", async () => {
    const fakeUser = buildFakeUser();
    fakeUser.comparePassword = vi.fn().mockResolvedValue(true);
    fakeUser.save = vi.fn().mockResolvedValue(undefined);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(SessionModel.updateMany).mockResolvedValue({} as any);

    await changePasswordService(
      String(fakeUser._id),
      undefined,
      "CorrectOld@1",
      "New@Password1"
    );

    expect(SessionModel.updateMany).toHaveBeenCalledWith(
      { userId: fakeUser._id },
      { isValid: false }
    );
  });
});

describe("revokeSessionService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws NotFoundException when the session doesn't exist", async () => {
    vi.mocked(SessionModel.findById).mockResolvedValue(null as any);

    await expect(revokeSessionService("user-id", "session-id")).rejects.toThrow(
      NotFoundException
    );
  });

  it("throws NotFoundException (not Forbidden) when the session belongs to a different user", async () => {
    const ownerId = makeObjectId();
    const fakeSessionDoc = buildFakeSession({ userId: ownerId });
    vi.mocked(SessionModel.findById).mockResolvedValue(fakeSessionDoc as any);

    const someoneElsesId = makeObjectId().toString();
    await expect(
      revokeSessionService(someoneElsesId, String(fakeSessionDoc._id))
    ).rejects.toThrow(NotFoundException);
  });

  it("invalidates the session when it belongs to the caller", async () => {
    const ownerId = makeObjectId();
    const fakeSessionDoc = buildFakeSession({ userId: ownerId });
    vi.mocked(SessionModel.findById).mockResolvedValue(fakeSessionDoc as any);
    vi.mocked(SessionModel.findByIdAndUpdate).mockResolvedValue({} as any);

    await revokeSessionService(ownerId.toString(), String(fakeSessionDoc._id));

    expect(SessionModel.findByIdAndUpdate).toHaveBeenCalledWith(
      String(fakeSessionDoc._id),
      { isValid: false }
    );
  });
});
