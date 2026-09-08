/**
 * UNIT TESTS: middlewares/auth.middleware.ts
 * ----------------------------------------------
 * This middleware is a chain of SEVEN sequential guard clauses before it
 * finally trusts a request:
 *   1. Is there a Bearer token at all?
 *   2. Does it verify (signature + not expired)?
 *   3. Does the userId in the token match a real, existing user?
 *   4. Is that user active (not deactivated/banned)?
 *   5. Does the sessionId in the token match a real, existing session?
 *   6. Is that session still valid (not logged out) and not expired?
 *   7. Does the session actually belong to that same user (cross-check)?
 *
 * This is EXACTLY the kind of function the README checklist warns about:
 * many sequential `if (!x) throw` guards, where it's easy to test only the
 * "happy path" and the "totally missing token" case, while quietly leaving
 * several other guards completely unverified. We test every single one
 * here, in order, plus the final success path.
 *
 * Mocking strategy: UserModel and SessionModel are mocked (no real DB).
 * `verifyAccessTokenAndGetPayload` is REAL - we generate genuine tokens
 * with `generateTokenPair` so we're also implicitly confirming this
 * middleware and utils/jwt.ts actually agree on token shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { authenticate } from "../../../src/middlewares/auth.middleware";
import UserModel from "../../../src/models/user.model";
import SessionModel from "../../../src/models/session.model";
import { UnauthorizedException } from "../../../src/utils/appError";
import { generateTokenPair } from "../../../src/utils/jwt";
import { createMockReqRes } from "../../setup/mockExpress";
import { buildFakeUser, buildFakeSession, makeObjectId } from "../../setup/testFixtures";

vi.mock("../../../src/models/user.model");
vi.mock("../../../src/models/session.model");

/**
 * Small local helper: builds a mock req carrying a real, valid-shaped Bearer
 * token for the given userId/sessionId, since almost every test here needs one.
 */
function buildAuthedReq(userId: any, sessionId: string, overrides: any = {}) {
  const { accessToken } = generateTokenPair(userId, sessionId);
  return createMockReqRes({
    ...overrides,
    headers: { authorization: `Bearer ${accessToken}`, ...(overrides.headers ?? {}) },
  });
}

describe("authenticate middleware", () => {
  beforeEach(() => vi.resetAllMocks());

  it("guard 1: calls next(error) when there's no Authorization header at all", async () => {
    const { req, res, next } = createMockReqRes({ headers: {} });

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
    expect(UserModel.findById).not.toHaveBeenCalled();
  });

  it("guard 1: calls next(error) when the header isn't a Bearer scheme", async () => {
    const { req, res, next } = createMockReqRes({
      headers: { authorization: "Basic somehash" },
    });

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
  });

  it("guard 2: calls next(error) when the token is garbage/unverifiable", async () => {
    const { req, res, next } = createMockReqRes({
      headers: { authorization: "Bearer not-a-real-jwt" },
    });

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
    expect(UserModel.findById).not.toHaveBeenCalled();
  });

  it("guard 3: calls next(error) when the token's userId doesn't match any real user", async () => {
    const { req, res, next } = buildAuthedReq(makeObjectId(), "session-1");
    vi.mocked(UserModel.findById).mockResolvedValue(null as any);

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
    expect(SessionModel.findById).not.toHaveBeenCalled(); // should short-circuit before this
  });

  it("guard 4: calls next(error) when the user exists but is deactivated", async () => {
    const fakeUser = buildFakeUser({ isActive: false });
    const { req, res, next } = buildAuthedReq(fakeUser._id, "session-1");
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
    expect(SessionModel.findById).not.toHaveBeenCalled();
  });

  it("guard 5: calls next(error) when the session referenced by the token no longer exists", async () => {
    const fakeUser = buildFakeUser();
    const { req, res, next } = buildAuthedReq(fakeUser._id, "deleted-session");
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(SessionModel.findById).mockResolvedValue(null as any);

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
  });

  it("guard 6a: calls next(error) when the session has been explicitly revoked (isValid: false)", async () => {
    const fakeUser = buildFakeUser();
    const fakeSession = buildFakeSession({ userId: fakeUser._id, isValid: false });
    const { req, res, next } = buildAuthedReq(fakeUser._id, String(fakeSession._id));
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(SessionModel.findById).mockResolvedValue(fakeSession as any);

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
  });

  it("guard 6b: calls next(error) when the session's expiresAt is in the past", async () => {
    const fakeUser = buildFakeUser();
    const fakeSession = buildFakeSession({
      userId: fakeUser._id,
      isValid: true,
      expiresAt: new Date(Date.now() - 60_000), // 1 minute ago
    });
    const { req, res, next } = buildAuthedReq(fakeUser._id, String(fakeSession._id));
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(SessionModel.findById).mockResolvedValue(fakeSession as any);

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
  });

  it("guard 7: calls next(error) when the session belongs to a DIFFERENT user than the token claims (session hijack / mismatch check)", async () => {
    // This is arguably the most security-critical guard in the file: it
    // stops a token for user A being paired with a real, valid, unexpired
    // session that actually belongs to user B.
    const tokenUser = buildFakeUser();
    const sessionOwner = buildFakeUser(); // a DIFFERENT user
    const fakeSession = buildFakeSession({ userId: sessionOwner._id, isValid: true });
    const { req, res, next } = buildAuthedReq(tokenUser._id, String(fakeSession._id));
    vi.mocked(UserModel.findById).mockResolvedValue(tokenUser as any);
    vi.mocked(SessionModel.findById).mockResolvedValue(fakeSession as any);

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
  });

  it("success path: attaches req.user and req.session and calls next() with NO error", async () => {
    const fakeUser = buildFakeUser({ isActive: true });
    const fakeSession = buildFakeSession({ userId: fakeUser._id, isValid: true });
    const { req, res, next } = buildAuthedReq(fakeUser._id, String(fakeSession._id));
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(SessionModel.findById).mockResolvedValue(fakeSession as any);

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(); // called with NO arguments = success
    expect((req as any).user).toBe(fakeUser);
    expect((req as any).session).toBe(fakeSession);
  });
});
