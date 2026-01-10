// backend/src/utils/jwt.ts
// ============================================
// JWT UTILITY WITH ACCESS + REFRESH TOKENS
// ============================================

import { config } from "../config/app.config";
import { UserDocument } from "../models/user.model";
import jwt, { SignOptions, VerifyOptions } from "jsonwebtoken";

// ============================================
// TYPE DEFINITIONS
// ============================================

export type AccessTokenPayload = {
  userId: UserDocument["_id"];
  sessionId: string; // Links to refresh token for revocation
};

export type RefreshTokenPayload = {
  userId: UserDocument["_id"];
  sessionId: string;
};

type SignOptsAndSecret = SignOptions & {
  secret: string;
};

// ============================================
// TOKEN CONFIGURATION
// ============================================

const defaults: SignOptions = {
  audience: ["user"],
  algorithm: "HS256",
};

/**
 * ACCESS TOKEN CONFIG:
 * - Short-lived (15 minutes)
 * - Contains user info for stateless verification
 * - Sent in Authorization header by frontend
 */
export const accessTokenSignOptions: SignOptsAndSecret = {
  expiresIn: config.JWT.ACCESS_TOKEN_EXPIRES_IN || "15m",
  secret: config.JWT.ACCESS_TOKEN_SECRET,
};

/**
 * REFRESH TOKEN CONFIG:
 * - Long-lived (7 days)
 * - Used only to get new access tokens
 * - Stored in httpOnly cookie (can't be stolen via XSS)
 * - Stored in DB for revocation capability
 */
export const refreshTokenSignOptions: SignOptsAndSecret = {
  expiresIn: config.JWT.REFRESH_TOKEN_EXPIRES_IN || "7d",
  secret: config.JWT.REFRESH_TOKEN_SECRET,
};

// ============================================
// TOKEN GENERATION
// ============================================

export const signJwtToken = <T extends object>(
  payload: T,
  options: SignOptsAndSecret = accessTokenSignOptions
): string => {
  const { secret, ...opts } = options;
  return jwt.sign(payload, secret, {
    ...defaults,
    ...opts,
  });
};

/**
 * Generate both tokens at once (for login)
 */
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

// ============================================
// TOKEN VERIFICATION
// ============================================

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
  } catch (error: any) {
    return {
      valid: false,
      error:
        error.name === "TokenExpiredError" ? "Token expired" : "Invalid token",
    };
  }
};

/**
 * Verify access token
 */
export const verifyAccessToken = (token: string) => {
  return verifyJwtToken<AccessTokenPayload>(
    token,
    accessTokenSignOptions.secret
  );
};

/**
 * Verify refresh token
 */
export const verifyRefreshToken = (token: string) => {
  return verifyJwtToken<RefreshTokenPayload>(
    token,
    refreshTokenSignOptions.secret
  );
};

// ============================================
// HELPER: Calculate expiry date for DB storage
// ============================================

export const calculateExpiryDate = (expiresIn: string): Date => {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid expiresIn format: ${expiresIn}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1000, // seconds
    m: 60 * 1000, // minutes
    h: 60 * 60 * 1000, // hours
    d: 24 * 60 * 60 * 1000, // days
  };

  return new Date(Date.now() + value * multipliers[unit]);
};