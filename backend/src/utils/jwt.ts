import jwt, { SignOptions, VerifyOptions } from "jsonwebtoken";
import { config } from "../config/app.config";

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

export const calculateExpiryDate = (expiresIn: string): Date => {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid expiresIn format: ${expiresIn}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return new Date(Date.now() + value * multipliers[unit]);
};
