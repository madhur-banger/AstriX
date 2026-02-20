/**
 * E2E AUTH HELPER
 * -----------------
 * Every e2e suite that hits a route mounted behind the real `authenticate`
 * middleware (see src/index.ts - user/workspace/project/task/member routers
 * are all mounted as `authenticate, someRoutes`) needs a REAL, verifiable
 * access token plus a matching SessionModel row (authenticate looks the
 * session up by id and checks isValid/expiresAt/userId match).
 *
 * This mirrors exactly what `createSessionService` + `generateTokenPair` do
 * in production, so e2e tests exercise the real auth wiring end-to-end
 * instead of stubbing `req.user` by hand.
 */

import UserModel from "../../src/models/user.model";
import SessionModel from "../../src/models/session.model";
import { generateTokenPair, calculateExpiryDate } from "../../src/utils/jwt";
import { config } from "../../src/config/app.config";

export async function createAuthenticatedUser(
  overrides: Partial<{ name: string; email: string }> = {}
) {
  const user = await UserModel.create({
    name: overrides.name ?? "E2E Test User",
    email:
      overrides.email ??
      `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
  });

  const session = await SessionModel.create({
    userId: user._id,
    userAgent: "vitest-e2e-agent",
    ipAddress: "127.0.0.1",
    expiresAt: calculateExpiryDate(config.JWT.REFRESH_TOKEN_EXPIRES_IN),
  });

  const { accessToken } = generateTokenPair(user._id, session._id.toString());

  return {
    user,
    session,
    accessToken,
    authHeader: `Bearer ${accessToken}`,
  };
}
