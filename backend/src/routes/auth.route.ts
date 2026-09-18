import { Router, Request, Response } from "express";
import { config } from "../config/app.config";
import { createRateLimiter } from "../utils/rate-limiter";
import {
  loginController,
  logOutController,
  logOutAllController,
  registerUserController,
  refreshTokenController,
  getSessionsController,
  googleCallbackController,
  forgotPasswordController,
  resetPasswordController,
  verifyEmailController,
  resendVerificationEmailController,
  changePasswordController,
  revokeSessionController,
} from "../controllers/auth.controller";
import { authenticate } from "../middlewares/auth.middleware";
import {
  generateGoogleOAuthState,
  getGoogleAuthorizationUrl,
} from "../providers/google.provider";

const authRoutes = Router();

const authLimiter = createRateLimiter("auth", {
  max: config.AUTH_RATE_LIMIT_MAX,
  message: {
    error: "Too many login attempts. Please try again in 15 minutes.",
  },
  skipSuccessfulRequests: true,
});

const refreshLimiter = createRateLimiter("refresh", {
  max: 30,
  message: { error: "Too many refresh attempts. Please try again later." },
});

const passwordResetLimiter = createRateLimiter("password-reset", {
  max: 5,
  message: {
    error: "Too many password reset attempts. Please try again later.",
  },
});

const oauthLimiter = createRateLimiter("oauth", {
  max: 20,
  message: { error: "Too many attempts. Please try again later." },
});

const emailVerificationLimiter = createRateLimiter("email-verification", {
  max: 5,
  message: { error: "Too many attempts. Please try again later." },
});

const changePasswordLimiter = createRateLimiter("change-password", {
  max: 10,
  message: { error: "Too many attempts. Please try again later." },
});

authRoutes.post("/register", authLimiter, registerUserController);
authRoutes.post("/login", authLimiter, loginController);
authRoutes.post("/refresh", refreshLimiter, refreshTokenController);

authRoutes.get("/google", oauthLimiter, (req: Request, res: Response) => {
  const state = generateGoogleOAuthState();

  res.cookie("google_oauth_state", state, {
    httpOnly: true,
    secure: config.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
  });

  res.redirect(getGoogleAuthorizationUrl(state));
});

authRoutes.get("/google/callback", oauthLimiter, googleCallbackController);

authRoutes.post(
  "/forgot-password",
  passwordResetLimiter,
  forgotPasswordController
);
authRoutes.post(
  "/reset-password",
  passwordResetLimiter,
  resetPasswordController
);

authRoutes.post(
  "/verify-email",
  emailVerificationLimiter,
  verifyEmailController
);
authRoutes.post(
  "/resend-verification",
  authenticate,
  emailVerificationLimiter,
  resendVerificationEmailController
);

authRoutes.post(
  "/change-password",
  authenticate,
  changePasswordLimiter,
  changePasswordController
);

authRoutes.post("/logout", logOutController);
authRoutes.post("/logout-all", authenticate, logOutAllController);
authRoutes.get("/sessions", authenticate, getSessionsController);
authRoutes.delete("/sessions/:id", authenticate, revokeSessionController);

export default authRoutes;
