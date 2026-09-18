import { Request, Response, NextFunction } from "express";
import { extractBearerToken } from "../utils/jwt";
import { UnauthorizedException } from "../utils/appError";
import { authenticateAccessTokenService } from "../services/auth.service";

// Extracts the bearer token, verifies it against the real Postgres/Redis
// session (authenticateAccessTokenService), and attaches the caller to the
// request as a plain { id, sessionId } pair - see src/@types/index.d.ts for
// the Express.Request.user augmentation this relies on.
export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    const token = extractBearerToken(authHeader);

    if (!token) {
      throw new UnauthorizedException("Token not found");
    }

    const { userId, sessionId } = await authenticateAccessTokenService(token);
    req.user = { id: userId, sessionId };

    next();
  } catch (error) {
    next(error);
  }
};
