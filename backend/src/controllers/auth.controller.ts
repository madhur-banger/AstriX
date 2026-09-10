import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { config } from "../config/app.config";
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  changePasswordSchema,
  sessionIdSchema,
} from "../validation/auth.validation";
import { HTTPSTATUS } from "../config/http.config";
import {
  registerUserService,
  createSessionService,
  refreshAccessTokenService,
  invalidateSessionService,
  invalidateAllSessionsService,
  getUserSessionsService,
  verifyUserService,
  loginOrCreateAccountService,
  requestPasswordResetService,
  resetPasswordService,
  requestEmailVerificationService,
  verifyEmailService,
  changePasswordService,
  revokeSessionService,
} from "../services/auth.service";
import { BadRequestException, UnauthorizedException } from "../utils/appError";
import { exchangeGoogleCodeForProfile } from "../providers/google.provider";
import { verifyRefreshToken } from "../utils/jwt";
import { logger } from "../utils/logger";

const setRefreshTokenCookie = (res: Response, refreshToken: string): void => {
  res.cookie(config.COOKIE.REFRESH_TOKEN_NAME, refreshToken, {
    httpOnly: config.COOKIE.HTTP_ONLY,
    secure: config.COOKIE.SECURE,
    sameSite: config.COOKIE.SAME_SITE,
    path: config.COOKIE.PATH,
    domain: config.COOKIE.DOMAIN,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

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
// REGISTER (email/password)
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
// LOGIN (email/password)
// ============================================

export const loginController = asyncHandler(
  async (req: Request, res: Response) => {
    const body = loginSchema.parse(req.body);
    const user = await verifyUserService(body);

    const { accessToken, refreshToken } = await createSessionService({
      userId: user._id,
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });

    setRefreshTokenCookie(res, refreshToken);

    return res.status(HTTPSTATUS.OK).json({
      message: "Logged in successfully",
      access_token: accessToken,
      user,
    });
  }
);

// ============================================
// OAUTH (Google)
// ============================================

export const googleCallbackController = asyncHandler(
  async (req: Request, res: Response) => {
    const { code, state } = req.query;

    if (!code || !state) {
      throw new BadRequestException("Missing code or state from request");
    }

    const storedState = req.cookies.google_oauth_state;
    if (!storedState || storedState !== state) {
      throw new UnauthorizedException("Invalid OAuth state");
    }
    res.clearCookie("google_oauth_state");

    const profile = await exchangeGoogleCodeForProfile(code as string);

    const { user } = await loginOrCreateAccountService({
      provider: profile.provider,
      providerId: profile.providerId,
      email: profile.email,
      displayName: profile.name,
      picture: profile.picture,
      emailVerified: profile.emailVerified,
    });

    const { refreshToken } = await createSessionService({
      userId: user._id,
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });

    setRefreshTokenCookie(res, refreshToken);

    const redirectUrl = `${config.FRONTEND_ORIGIN}/workspace/${user.currentWorkspace}`;
    res.redirect(redirectUrl);
  }
);

// ============================================
// REFRESH TOKEN
// ============================================

export const refreshTokenController = asyncHandler(
  async (req: Request, res: Response) => {
    const refreshToken = req.cookies[config.COOKIE.REFRESH_TOKEN_NAME];

    if (!refreshToken) {
      return res.status(HTTPSTATUS.UNAUTHORIZED).json({
        message: "No refresh token provided",
      });
    }

    try {
      const { accessToken, refreshToken: rotatedRefreshToken } =
        await refreshAccessTokenService(refreshToken);

      // Rotation: the token just spent is now dead server-side, so the
      // client must be handed its replacement in the same response or it
      // would be locked out on its next refresh.
      setRefreshTokenCookie(res, rotatedRefreshToken);

      return res.status(HTTPSTATUS.OK).json({ access_token: accessToken });
    } catch (error) {
      clearRefreshTokenCookie(res);
      return res.status(HTTPSTATUS.UNAUTHORIZED).json({
        message:
          error instanceof Error ? error.message : "Invalid refresh token",
      });
    }
  }
);

// ============================================
// LOGOUT (single session / all sessions)
// ============================================

export const logOutController = asyncHandler(
  async (req: Request, res: Response) => {
    const refreshToken = req.cookies[config.COOKIE.REFRESH_TOKEN_NAME];

    if (refreshToken) {
      try {
        const result = verifyRefreshToken(refreshToken);
        if (result.valid) {
          await invalidateSessionService(result.payload.sessionId);
        }
      } catch (error) {
        (req.log ?? logger).error({ err: error }, "Logout error");
      }
    }

    clearRefreshTokenCookie(res);
    return res
      .status(HTTPSTATUS.OK)
      .json({ message: "Logged out successfully" });
  }
);

export const logOutAllController = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;

    if (!user) {
      return res
        .status(HTTPSTATUS.UNAUTHORIZED)
        .json({ message: "Not authenticated" });
    }

    await invalidateAllSessionsService(user._id);
    clearRefreshTokenCookie(res);

    return res
      .status(HTTPSTATUS.OK)
      .json({ message: "Logged out from all devices" });
  }
);

// ============================================
// SESSION LISTING (manage devices)
// ============================================

export const getSessionsController = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;

    if (!user) {
      return res
        .status(HTTPSTATUS.UNAUTHORIZED)
        .json({ message: "Not authenticated" });
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

// ============================================
// PASSWORD RESET
// ============================================

export const forgotPasswordController = asyncHandler(
  async (req: Request, res: Response) => {
    const { email } = forgotPasswordSchema.parse(req.body);

    await requestPasswordResetService(email);

    // Always the same response, whether or not the email belongs to an
    // account - requestPasswordResetService already no-ops for an unknown
    // email, so this line is reached (and this exact message returned)
    // either way.
    return res.status(HTTPSTATUS.OK).json({
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });
  }
);

export const resetPasswordController = asyncHandler(
  async (req: Request, res: Response) => {
    const { token, password } = resetPasswordSchema.parse(req.body);

    await resetPasswordService(token, password);

    return res.status(HTTPSTATUS.OK).json({
      message:
        "Password reset successfully. Please log in with your new password.",
    });
  }
);

// ============================================
// EMAIL VERIFICATION (advisory only - never blocks login)
// ============================================

export const verifyEmailController = asyncHandler(
  async (req: Request, res: Response) => {
    const { token } = verifyEmailSchema.parse(req.body);

    await verifyEmailService(token);

    return res.status(HTTPSTATUS.OK).json({
      message: "Email verified successfully.",
    });
  }
);

export const resendVerificationEmailController = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;

    if (!user) {
      return res
        .status(HTTPSTATUS.UNAUTHORIZED)
        .json({ message: "Not authenticated" });
    }

    await requestEmailVerificationService(user._id.toString());

    return res.status(HTTPSTATUS.OK).json({
      message: "Verification email sent.",
    });
  }
);

// ============================================
// CHANGE PASSWORD (authenticated)
// ============================================

export const changePasswordController = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;

    if (!user) {
      return res
        .status(HTTPSTATUS.UNAUTHORIZED)
        .json({ message: "Not authenticated" });
    }

    const { currentPassword, newPassword } = changePasswordSchema.parse(
      req.body
    );

    await changePasswordService(
      user._id.toString(),
      req.session?._id?.toString(),
      currentPassword,
      newPassword
    );

    return res.status(HTTPSTATUS.OK).json({
      message:
        "Password changed successfully. You've been logged out of all other devices.",
    });
  }
);

// ============================================
// SESSION REVOCATION (single device)
// ============================================

export const revokeSessionController = asyncHandler(
  async (req: Request, res: Response) => {
    const user = req.user;

    if (!user) {
      return res
        .status(HTTPSTATUS.UNAUTHORIZED)
        .json({ message: "Not authenticated" });
    }

    const sessionId = sessionIdSchema.parse(req.params.id);

    await revokeSessionService(user._id.toString(), sessionId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Session revoked successfully.",
    });
  }
);
