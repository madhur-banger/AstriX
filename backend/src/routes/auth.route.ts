import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { config } from "../config/app.config";
import {
  loginController,
  logOutController,
  logOutAllController,
  registerUserController,
  refreshTokenController,
  getSessionsController,
  googleCallbackController,
} from "../controllers/auth.controller";
import { authenticate } from "../middlewares/auth.middleware";
import {
  generateGoogleOAuthState,
  getGoogleAuthorizationUrl,
} from "../providers/google.provider";

const authRoutes = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Too many refresh attempts. Please try again later." },
});

authRoutes.post("/register", authLimiter, registerUserController);
authRoutes.post("/login", authLimiter, loginController);
authRoutes.post("/refresh", refreshLimiter, refreshTokenController);

authRoutes.get("/google", (req: Request, res: Response) => {
  const state = generateGoogleOAuthState();

  res.cookie("google_oauth_state", state, {
    httpOnly: true,
    secure: config.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
  });

  res.redirect(getGoogleAuthorizationUrl(state));
});

authRoutes.get("/google/callback", googleCallbackController);

authRoutes.post("/logout", logOutController);
authRoutes.post("/logout-all", authenticate, logOutAllController);
authRoutes.get("/sessions", authenticate, getSessionsController);

export default authRoutes;