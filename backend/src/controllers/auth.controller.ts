// backend/src/controllers/auth.controller.ts
// ============================================
// AUTH CONTROLLER - Updated with Refresh Tokens
// ============================================

import { NextFunction, Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { config } from "../config/app.config";
import { registerSchema, loginSchema } from "../validation/auth.validation";
import { HTTPSTATUS } from "../config/http.config";
import {
  registerUserService,
  createSessionService,
  refreshAccessTokenService,
  invalidateSessionService,
  invalidateAllSessionsService,
  getUserSessionsService,
} from "../services/auth.service";
import passport from "passport";

// ============================================
// COOKIE HELPER FUNCTIONS
// ============================================

/**
 * Set refresh token as httpOnly cookie
 * This is the MOST SECURE way to store refresh tokens
 */
const setRefreshTokenCookie = (res: Response, refreshToken: string): void => {
  res.cookie(config.COOKIE.REFRESH_TOKEN_NAME, refreshToken, {
    httpOnly: config.COOKIE.HTTP_ONLY, // Can't be accessed by JavaScript
    secure: config.COOKIE.SECURE, // HTTPS only in production
    sameSite: config.COOKIE.SAME_SITE, // CSRF protection
    path: config.COOKIE.PATH,
    domain: config.COOKIE.DOMAIN,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
  });
};

/**
 * Clear refresh token cookie
 * Must use same options as when setting (except maxAge)
 */
const clearRefreshTokenCookie = (res: Response): void => {
  res.clearCookie(config.COOKIE.REFRESH_TOKEN_NAME, {
    httpOnly: config.COOKIE.HTTP_ONLY,
    secure: config.COOKIE.SECURE,
    sameSite: config.COOKIE.SAME_SITE,
    path: config.COOKIE.PATH,
    domain: config.COOKIE.DOMAIN,
  });
};

// ============================================
// GOOGLE OAUTH CALLBACK
// ============================================

/**
 * After Google authenticates, generate tokens and redirect
 *
 * NOTE: We pass the access token in URL (briefly) because:
 * 1. OAuth redirect can't set response body
 * 2. Frontend needs the access token to make API calls
 * 3. Refresh token is set as httpOnly cookie (secure)
 *
 * The frontend should immediately clear the URL params after extracting the token.
 */
export const googleLoginCallback = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;

    if (!user) {
      return res.redirect(
        `${config.FRONTEND_GOOGLE_CALLBACK_URL}?status=failure&error=no_user`
      );
    }

    try {
      // Create session and generate tokens
      const { accessToken, refreshToken } = await createSessionService({
        userId: user._id,
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });

      // Set refresh token as httpOnly cookie
      setRefreshTokenCookie(res, refreshToken);

      // Redirect with access token and workspace
      // Access token in URL is not ideal, but necessary for OAuth redirect
      // Frontend should immediately extract and clear from URL
      const currentWorkspace = user.currentWorkspace;

      return res.redirect(
        `${config.FRONTEND_GOOGLE_CALLBACK_URL}` +
          `?status=success` +
          `&access_token=${accessToken}` +
          `&current_workspace=${currentWorkspace}`
      );
    } catch (error) {
      console.error("Google OAuth callback error:", error);
      return res.redirect(
        `${config.FRONTEND_GOOGLE_CALLBACK_URL}?status=failure&error=session_creation_failed`
      );
    }
  }
);

// ============================================
// REGISTER
// ============================================

export const registerUserController = asyncHandler(
  async (req: Request, res: Response) => {
    const body = registerSchema.parse(req.body);

    const result = await registerUserService(body);

    return res.status(HTTPSTATUS.CREATED).json({
      message: "User created successfully",
      userId: result.userId,
    });
  }
);

// ============================================
// LOGIN (Email/Password)
// ============================================

export const loginController = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    // Validate input
    loginSchema.parse(req.body);

    passport.authenticate(
      "local",
      async (
        err: Error | null,
        user: Express.User | false,
        info: { message: string } | undefined
      ) => {
        if (err) {
          return next(err);
        }

        if (!user) {
          return res.status(HTTPSTATUS.UNAUTHORIZED).json({
            message: info?.message || "Invalid email or password",
          });
        }

        try {
          // Create session and generate tokens
          const { accessToken, refreshToken, sessionId } =
            await createSessionService({
              userId: user._id,
              userAgent: req.headers["user-agent"],
              ipAddress: req.ip,
            });

          // Set refresh token as httpOnly cookie
          setRefreshTokenCookie(res, refreshToken);

          // Return access token in response body
          // Frontend stores this in memory (Zustand without persistence)
          return res.status(HTTPSTATUS.OK).json({
            message: "Logged in successfully",
            access_token: accessToken,
            user: {
              _id: user._id,
              email: user.email,
              name: user.name,
              currentWorkspace: user.currentWorkspace,
              profilePicture: user.profilePicture,
            },
          });
        } catch (error) {
          return next(error);
        }
      }
    )(req, res, next);
  }
);

// ============================================
// REFRESH TOKEN
// ============================================

/**
 * Exchange refresh token for new access token
 * Refresh token comes from httpOnly cookie (sent automatically)
 */
export const refreshTokenController = asyncHandler(
  async (req: Request, res: Response) => {
    // Get refresh token from cookie
    const refreshToken = req.cookies[config.COOKIE.REFRESH_TOKEN_NAME];

    if (!refreshToken) {
      return res.status(HTTPSTATUS.UNAUTHORIZED).json({
        message: "No refresh token provided",
      });
    }

    try {
      const { accessToken, newRefreshToken } = await refreshAccessTokenService(
        refreshToken
      );

      // If refresh token was rotated, update cookie
      if (newRefreshToken) {
        setRefreshTokenCookie(res, newRefreshToken);
      }

      return res.status(HTTPSTATUS.OK).json({
        access_token: accessToken,
      });
    } catch (error: any) {
      // Clear invalid refresh token
      clearRefreshTokenCookie(res);

      return res.status(HTTPSTATUS.UNAUTHORIZED).json({
        message: error.message || "Invalid refresh token",
      });
    }
  }
);

// ============================================
// LOGOUT
// ============================================

/**
 * Logout from current session
 * 1. Invalidates session in database
 * 2. Clears refresh token cookie
 */
export const logOutController = asyncHandler(
  async (req: Request, res: Response) => {
    // Get refresh token to find session
    const refreshToken = req.cookies[config.COOKIE.REFRESH_TOKEN_NAME];

    if (refreshToken) {
      try {
        // Import verifyRefreshToken to get session ID
        const { verifyRefreshToken } = await import("../utils/jwt");
        const result = verifyRefreshToken(refreshToken);

        if (result.valid) {
          // Invalidate the session
          await invalidateSessionService(result.payload.sessionId);
        }
      } catch (error) {
        // Token invalid, just clear cookie
        console.error("Logout error:", error);
      }
    }

    // Always clear the cookie
    clearRefreshTokenCookie(res);

    return res.status(HTTPSTATUS.OK).json({
      message: "Logged out successfully",
    });
  }
);

// ============================================
// LOGOUT FROM ALL DEVICES
// ============================================

export const logOutAllController = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;

    if (!user) {
      return res.status(HTTPSTATUS.UNAUTHORIZED).json({
        message: "Not authenticated",
      });
    }

    // Invalidate all sessions for this user
    await invalidateAllSessionsService(user._id);

    // Clear current cookie
    clearRefreshTokenCookie(res);

    return res.status(HTTPSTATUS.OK).json({
      message: "Logged out from all devices",
    });
  }
);

// ============================================
// GET ACTIVE SESSIONS (For "Manage Devices")
// ============================================

export const getSessionsController = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;

    if (!user) {
      return res.status(HTTPSTATUS.UNAUTHORIZED).json({
        message: "Not authenticated",
      });
    }

    const sessions = await getUserSessionsService(user._id);

    return res.status(HTTPSTATUS.OK).json({
      sessions: sessions.map((s) => ({
        id: s._id,
        userAgent: s.userAgent,
        ipAddress: s.ipAddress,
        createdAt: s.createdAt,
      })),
    });
  }
);