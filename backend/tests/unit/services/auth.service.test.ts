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
} from "../../../src/services/auth.service";

import UserModel from "../../../src/models/user.model";
import AccountModel from "../../../src/models/account.model";
import WorkspaceModel from "../../../src/models/workspace.model";
import RoleModel from "../../../src/models/roles-permission.model";
import SessionModel from "../../../src/models/session.model";
import MemberModel from "../../../src/models/member.model";

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
  asConstructorMock
} from "../../setup/testFixtures";

vi.mock("../../../src/models/user.model");
vi.mock("../../../src/models/account.model");
vi.mock("../../../src/models/workspace.model");
vi.mock("../../../src/models/roles-permission.model");
vi.mock("../../../src/models/session.model");
vi.mock("../../../src/models/member.model");

describe("createSessionService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("creates a session document and returns a matching token pair", async () => {
    const userId = makeObjectId();
    const fakeSession = buildFakeSession({ userId });
    vi.mocked(SessionModel.create).mockResolvedValue(fakeSession as any);

    const result = await createSessionService({
      userId,
      userAgent: "vitest",
      ipAddress: "127.0.0.1",
    });

    expect(SessionModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        userAgent: "vitest",
        ipAddress: "127.0.0.1",
        isValid: true,
        expiresAt: expect.any(Date),
      })
    );
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
      registerUserService({ email: "taken@example.com", name: "X", password: "pw" })
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

    vi.mocked(UserModel).mockImplementation(asConstructorMock(
      (data: any) =>
        ({ ...data, _id: makeObjectId(), save: vi.fn().mockResolvedValue(undefined) } as any)
    ));
    vi.mocked(AccountModel).mockImplementation(asConstructorMock(
      (data: any) => ({ ...data, save: vi.fn().mockResolvedValue(undefined) } as any)
    ));
    vi.mocked(WorkspaceModel).mockImplementation(asConstructorMock(
      (data: any) =>
        ({ ...data, _id: makeObjectId(), save: vi.fn().mockResolvedValue(undefined) } as any)
    ));

    vi.mocked(RoleModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null), // no OWNER role seeded
    } as any);

    await expect(
      registerUserService({ email: "new@example.com", name: "New", password: "pw" })
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
    }),
  );

  const accountSave = vi.fn().mockResolvedValue(undefined);

  vi.mocked(AccountModel).mockImplementation(
    asConstructorMock(
      (data: any) =>
        ({
          ...data,
          save: accountSave,
        }) as any,
    ),
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
        }) as any,
    ),
  );

  vi.mocked(RoleModel.findOne).mockReturnValue({
    session: vi.fn().mockResolvedValue(
      buildFakeRole({ name: "OWNER" }),
    ),
  } as any);

  const memberSave = vi.fn().mockResolvedValue(undefined);

  vi.mocked(MemberModel).mockImplementation(
    asConstructorMock(
      (data: any) =>
        ({
          ...data,
          save: memberSave,
        }) as any,
    ),
  );

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
});
});

describe("verifyUserService (login)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws NotFoundException when no account exists for the email/provider", async () => {
    vi.mocked(AccountModel.findOne).mockResolvedValue(null as any);

    await expect(
      verifyUserService({ email: "nobody@example.com", password: "pw" })
    ).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when the account exists but its user was deleted", async () => {
    vi.mocked(AccountModel.findOne).mockResolvedValue(buildFakeAccount() as any);
    vi.mocked(UserModel.findById).mockResolvedValue(null as any);

    await expect(
      verifyUserService({ email: "orphaned@example.com", password: "pw" })
    ).rejects.toThrow(NotFoundException);
  });

  it("throws UnauthorizedException when the password doesn't match", async () => {
    vi.mocked(AccountModel.findOne).mockResolvedValue(buildFakeAccount() as any);
    const fakeUser = buildFakeUser();
    (fakeUser as any).comparePassword = vi.fn().mockResolvedValue(false);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    await expect(
      verifyUserService({ email: "test@example.com", password: "wrong-password" })
    ).rejects.toThrow(UnauthorizedException);
  });

  it("returns the sanitized (password-omitted) user on success", async () => {
    vi.mocked(AccountModel.findOne).mockResolvedValue(buildFakeAccount() as any);
    const fakeUser = buildFakeUser();
    (fakeUser as any).comparePassword = vi.fn().mockResolvedValue(true);
    const sanitizedUser = { ...fakeUser, password: undefined };
    (fakeUser as any).omitPassword = vi.fn().mockReturnValue(sanitizedUser);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    const result = await verifyUserService({
      email: "test@example.com",
      password: "correct-password",
    });

    expect((fakeUser as any).comparePassword).toHaveBeenCalledWith("correct-password");
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
      session: vi.fn().mockResolvedValue(buildFakeAccount({ userId: existingUser._id })),
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

  it("PATH 2a - no account yet, but a user with this email already exists: links the account, creates NO new workspace", async () => {
    const existingUser = buildFakeUser({ email: "email-password-user@example.com" });

    vi.mocked(AccountModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null), // no account linked yet
    } as any);
    vi.mocked(UserModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(existingUser), // but the user exists by email
    } as any);

    const newAccountSave = vi.fn().mockResolvedValue(undefined);
    vi.mocked(AccountModel).mockImplementation(asConstructorMock(
      (data: any) => ({ ...data, save: newAccountSave } as any)
    ));

    const result = await loginOrCreateAccountService({
      provider: "google",
      providerId: "new-google-sub",
      displayName: "Doesn't matter here",
      email: "email-password-user@example.com",
    });

    // Exactly ONE new document should be created: the linking Account.
    expect(newAccountSave).toHaveBeenCalledOnce();
    expect(UserModel).not.toHaveBeenCalled(); // no NEW user constructed
    expect(WorkspaceModel).not.toHaveBeenCalled(); // critical: no duplicate workspace
    expect(MemberModel).not.toHaveBeenCalled();
    expect(result.user).toBe(existingUser);
    expect(fakeSession.commitTransaction).toHaveBeenCalledOnce();
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
    vi.mocked(UserModel).mockImplementation(asConstructorMock((data: any) => {
      capturedUser = { ...data, _id: makeObjectId(), currentWorkspace: null, save: userSave };
      return capturedUser;
    }));

    const workspaceSave = vi.fn().mockResolvedValue(undefined);
    const newWorkspaceId = makeObjectId();
    vi.mocked(WorkspaceModel).mockImplementation(asConstructorMock(
      (data: any) => ({ ...data, _id: newWorkspaceId, save: workspaceSave } as any)
    ));

    vi.mocked(RoleModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(buildFakeRole({ name: "OWNER" })),
    } as any);

    const memberSave = vi.fn().mockResolvedValue(undefined);
    vi.mocked(MemberModel).mockImplementation(asConstructorMock(
      (data: any) => ({ ...data, save: memberSave } as any)
    ));

    const accountSave = vi.fn().mockResolvedValue(undefined);
    vi.mocked(AccountModel).mockImplementation(asConstructorMock(
      (data: any) => ({ ...data, save: accountSave } as any)
    ));

    const result = await loginOrCreateAccountService({
      provider: "google",
      providerId: "google-sub-456",
      displayName: "New Google User",
      email: "brand-new-oauth@example.com",
      picture: "https://example.com/pic.jpg",
    });

    expect(capturedUser.profilePicture).toBe("https://example.com/pic.jpg");
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
    vi.mocked(UserModel).mockImplementation(asConstructorMock(
      (data: any) =>
        ({ ...data, _id: makeObjectId(), save: vi.fn().mockResolvedValue(undefined) } as any)
    ));
    vi.mocked(WorkspaceModel).mockImplementation(asConstructorMock(
      (data: any) =>
        ({ ...data, _id: makeObjectId(), save: vi.fn().mockResolvedValue(undefined) } as any)
    ));
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
    vi.mocked(UserModel).mockImplementation(asConstructorMock((data: any) => {
      capturedUser = { ...data, _id: makeObjectId(), save: vi.fn().mockResolvedValue(undefined) };
      return capturedUser;
    }));
    vi.mocked(WorkspaceModel).mockImplementation(asConstructorMock(
      (data: any) => ({ ...data, _id: makeObjectId(), save: vi.fn().mockResolvedValue(undefined) } as any)
    ));
    vi.mocked(RoleModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(buildFakeRole()),
    } as any);
    vi.mocked(MemberModel).mockImplementation(asConstructorMock(
      (data: any) => ({ ...data, save: vi.fn().mockResolvedValue(undefined) } as any)
    ));
    vi.mocked(AccountModel).mockImplementation(asConstructorMock(
      (data: any) => ({ ...data, save: vi.fn().mockResolvedValue(undefined) } as any)
    ));

    await loginOrCreateAccountService({
      provider: "google",
      providerId: "sub-789",
      displayName: "No Picture Person",
      email: "no-picture@example.com",
      // picture intentionally omitted
    });

    expect(capturedUser.profilePicture).toBeNull();
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
    vi.mocked(SessionModel.findByIdAndDelete).mockResolvedValue(undefined as any);

    await expect(refreshAccessTokenService(refreshToken)).rejects.toThrow(
      UnauthorizedException
    );
    expect(SessionModel.findByIdAndDelete).toHaveBeenCalledWith("expired-session-id");
  });

  it("returns a fresh access token when the session is valid and unexpired", async () => {
    const userId = makeObjectId();
    const { refreshToken } = generateTokenPair(userId, "good-session-id");
    vi.mocked(SessionModel.findById).mockResolvedValue(
      buildFakeSession({ isValid: true }) as any // default expiresAt is 1 hour from now
    );

    const result = await refreshAccessTokenService(refreshToken);

    expect(typeof result.accessToken).toBe("string");
  });
});

describe("invalidateSessionService / invalidateAllSessionsService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("marks a single session invalid by id", async () => {
    vi.mocked(SessionModel.findByIdAndUpdate).mockResolvedValue(undefined as any);

    await invalidateSessionService("session-id-1");

    expect(SessionModel.findByIdAndUpdate).toHaveBeenCalledWith("session-id-1", {
      isValid: false,
    });
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
