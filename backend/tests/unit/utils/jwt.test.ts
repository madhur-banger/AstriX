/**
 * UNIT TESTS: utils/jwt.ts
 * ---------------------------
 * These functions are almost pure: given the SAME secret and payload, they
 * produce deterministic, verifiable output. No database, no Express, no
 * mocking required - `tests/setup/test-env.setup.ts` already gave us fixed
 * fake secrets to sign/verify against, so real jsonwebtoken code runs here.
 *
 * THE CLEVER TRICK FOR TESTING "TOKEN EXPIRED" WITHOUT ACTUALLY WAITING:
 * We don't want a test that calls `setTimeout` for 15 minutes to prove
 * expiry works. Instead, we hand-craft a token with an `exp` claim already
 * in the past using the real `jwt.sign` call directly (bypassing the
 * `expiresIn` option, which only accepts relative future durations) - the
 * library's own expiry check then fails immediately, exactly as it would
 * for a token that aged out naturally.
 */

import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";

import {
  signJwtToken,
  verifyJwtToken,
  extractBearerToken,
  accessTokenSignOptions,
  refreshTokenSignOptions,
  calculateExpiryDate,
} from "../../../src/utils/jwt";

describe("calculateExpiryDate", () => {
  it("adds seconds correctly for an 's' suffix", () => {
    const before = Date.now();
    const result: Date = calculateExpiryDate("30s");
    const diffMs = result.getTime() - before;
    // Allow a small tolerance window since a few ms pass during test execution.
    expect(diffMs).toBeGreaterThan(29_000);
    expect(diffMs).toBeLessThan(31_000);
  });

  it("adds minutes correctly for an 'm' suffix", () => {
    const before = Date.now();
    const result: Date = calculateExpiryDate("15m");
    const diffMs = result.getTime() - before;
    expect(diffMs).toBeGreaterThan(14 * 60_000);
    expect(diffMs).toBeLessThan(16 * 60_000);
  });

  it("adds days correctly for a 'd' suffix", () => {
    const before = Date.now();
    const result: Date = calculateExpiryDate("7d");
    const diffMs = result.getTime() - before;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(diffMs).toBeGreaterThan(sevenDaysMs - 60_000);
    expect(diffMs).toBeLessThan(sevenDaysMs + 60_000);
  });

  it("throws on a malformed duration string", () => {
    expect(() => calculateExpiryDate("not-a-duration")).toThrow(
      /Invalid expiresIn format/
    );
  });

  it("throws when the unit suffix is missing entirely", () => {
    expect(() => calculateExpiryDate("15")).toThrow();
  });
});

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed 'Bearer <token>' header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("returns null when the header is undefined (no Authorization header sent)", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null when the scheme isn't 'Bearer'", () => {
    expect(extractBearerToken("Basic abc123")).toBeNull();
  });

  it("returns null when there's a scheme but no token after it", () => {
    expect(extractBearerToken("Bearer")).toBeNull();
  });

  it("returns null for a completely empty string", () => {
    expect(extractBearerToken("")).toBeNull();
  });
});

describe("signJwtToken + verifyJwtToken (round trip)", () => {
  it("signs a payload and verifies it back to the same values", () => {
    const userId = randomUUID();
    const payload = { userId, sessionId: "session-abc" };

    const token = signJwtToken(payload, accessTokenSignOptions);
    const result = verifyJwtToken<typeof payload>(
      token,
      accessTokenSignOptions.secret
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.userId).toBe(userId);
      expect(result.payload.sessionId).toBe("session-abc");
    }
  });

  it("fails verification when the secret used to verify doesn't match the signing secret", () => {
    const token = signJwtToken({ foo: "bar" }, accessTokenSignOptions);

    const result = verifyJwtToken(token, "a-completely-wrong-secret");

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Invalid token");
    }
  });

  it("fails verification with 'Token expired' for a token whose exp is in the past", () => {
    // Bypass the library's relative `expiresIn` option and hand-craft an
    // already-expired token by setting `exp` directly, in seconds since epoch.
    const expiredToken = jwt.sign(
      {
        userId: "u1",
        sessionId: "s1",
        exp: Math.floor(Date.now() / 1000) - 10, // 10 seconds in the past
        aud: ["user"],
      },
      accessTokenSignOptions.secret,
      { algorithm: "HS256" }
    );

    const result = verifyJwtToken(expiredToken, accessTokenSignOptions.secret);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Token expired");
    }
  });

  it("a token signed with the access secret cannot be verified with the refresh secret", () => {
    // Confirms the two secrets are actually different values in config - a
    // common setup mistake is copy-pasting the same secret for both, which
    // would make this test fail.
    const token = signJwtToken({ userId: "u1", sessionId: "s1" }, accessTokenSignOptions);

    const result = verifyJwtToken(token, refreshTokenSignOptions.secret);

    expect(result.valid).toBe(false);
  });
});
