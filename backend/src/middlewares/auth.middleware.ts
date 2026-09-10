import { Request, Response, NextFunction } from "express";
import {
  extractBearerToken,
  verifyAccessTokenAndGetPayload,
} from "../utils/jwt";
import { UnauthorizedException } from "../utils/appError";
import UserModel from "../models/user.model";
import SessionModel from "../models/session.model";

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    const token = extractBearerToken(authHeader);

    if (!token) {
      throw new UnauthorizedException("Token not found");
    }

    const payload = verifyAccessTokenAndGetPayload(token);

    const user = await UserModel.findById(payload.userId);

    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    if (!user.isActive) {
      throw new UnauthorizedException("User is not active");
    }

    const session = await SessionModel.findById(payload.sessionId);

    if (!session) {
      throw new UnauthorizedException("Session not found");
    }
    if (!session.isValid) {
      throw new UnauthorizedException("Session has been revoked");
    }
    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException("Session has expired");
    }

    if (session.userId.toString() != user._id.toString()) {
      throw new UnauthorizedException("Invalid Session");
    }
    req.user = user;
    req.session = session;

    next();
  } catch (error) {
    next(error);
  }
};
