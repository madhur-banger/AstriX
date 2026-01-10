// backend/src/config/passport.config.ts
// ============================================
// PASSPORT CONFIGURATION - Updated
// ============================================

import passport from "passport";
import { Request } from "express";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as localStrategy } from "passport-local";
import {
  Strategy as JwtStrategy,
  ExtractJwt,
  StrategyOptionsWithoutRequest,
} from "passport-jwt";

import { config } from "./app.config";
import { NotFoundException } from "../utils/appError";
import { ProviderEnum } from "../enums/account-provider.enum";
import {
  findUserByIdService,
  loginOrCreateAccountService,
  verifyUserService,
} from "../services/auth.service";
import SessionModel from "../models/session.model";

// ============================================
// GOOGLE OAUTH STRATEGY
// ============================================

passport.use(
  new GoogleStrategy(
    {
      clientID: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      callbackURL: config.GOOGLE_CALLBACK_URL,
      scope: ["profile", "email"],
      passReqToCallback: true,
    },
    async (req: Request, accessToken, refreshToken, profile, done) => {
      try {
        const { email, sub: googleId, picture } = profile._json;

        if (!googleId) {
          throw new NotFoundException("Google ID (sub) is missing");
        }

        const { user } = await loginOrCreateAccountService({
          provider: ProviderEnum.GOOGLE,
          displayName: profile.displayName,
          providerId: googleId,
          email: email,
          picture: picture,
        });

        // Don't generate token here - let the controller handle it
        // This allows us to properly create a session with request metadata
        done(null, user);
      } catch (error) {
        done(error, false);
      }
    }
  )
);

// ============================================
// LOCAL (EMAIL/PASSWORD) STRATEGY
// ============================================

passport.use(
  new localStrategy(
    {
      usernameField: "email",
      passwordField: "password",
      session: false,
    },
    async (email, password, done) => {
      try {
        const user = await verifyUserService({ email, password });
        return done(null, user);
      } catch (error: any) {
        return done(error, false, { message: error?.message });
      }
    }
  )
);

// ============================================
// JWT STRATEGY - For Protected Routes
// ============================================

interface JwtPayload {
  userId: string;
  sessionId: string;
  iat: number;
  exp: number;
}

const jwtOptions: StrategyOptionsWithoutRequest = {
  // Extract token from Authorization header: "Bearer <token>"
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: config.JWT.ACCESS_TOKEN_SECRET,
  audience: ["user"],
  algorithms: ["HS256"],
};

passport.use(
  new JwtStrategy(jwtOptions, async (payload: JwtPayload, done) => {
    try {
      // 1. Find user
      const user = await findUserByIdService(payload.userId);

      if (!user) {
        return done(null, false);
      }

      // 2. Verify session is still valid (optional but recommended)
      // This adds a small DB query but allows immediate session revocation
      const session = await SessionModel.findById(payload.sessionId);

      if (!session || !session.isValid) {
        return done(null, false);
      }

      // 3. Attach session info to user for later use
      (user as any).sessionId = payload.sessionId;

      return done(null, user);
    } catch (error) {
      return done(error, false);
    }
  })
);

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

/**
 * Middleware for protected routes
 * Verifies JWT from Authorization header
 */
export const passportAuthenticateJWT = passport.authenticate("jwt", {
  session: false,
});

/**
 * Optional: Middleware that allows both authenticated and unauthenticated access
 * Useful for routes that show different content based on auth status
 */
export const optionalAuth = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  passport.authenticate(
    "jwt",
    { session: false },
    (err: any, user: any) => {
      // Don't fail if no token - just don't set user
      if (user) {
        req.user = user;
      }
      next();
    }
  )(req, res, next);
};

import { Response, NextFunction } from "express";