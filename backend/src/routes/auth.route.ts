// backend/src/routes/auth.route.ts
// ============================================
// AUTH ROUTES - Updated with Refresh Token Endpoints
// ============================================

import { Router } from "express";
import passport from "passport";
import rateLimit from "express-rate-limit";
import { config } from "../config/app.config";
import {
  googleLoginCallback,
  loginController,
  logOutController,
  logOutAllController,
  registerUserController,
  refreshTokenController,
  getSessionsController,
} from "../controllers/auth.controller";
import { passportAuthenticateJWT } from "../config/passport.config";

const failedUrl = `${config.FRONTEND_GOOGLE_CALLBACK_URL}?status=failure`;

const authRoutes = Router();

// ============================================
// RATE LIMITING
// ============================================

/**
 * Rate limiting for login/register to prevent brute force attacks
 * - 5 attempts per 15 minutes per IP
 * - Returns 429 Too Many Requests when exceeded
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: {
    error: "Too many login attempts. Please try again in 15 minutes.",
  },
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
  // Skip successful requests (don't count against limit)
  skipSuccessfulRequests: true,
});

/**
 * Less restrictive rate limit for token refresh
 * - 30 attempts per 15 minutes
 */
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: {
    error: "Too many refresh attempts. Please try again later.",
  },
});

// ============================================
// PUBLIC ROUTES (No Auth Required)
// ============================================

// Registration
authRoutes.post("/register", authLimiter, registerUserController);

// Email/Password Login
authRoutes.post("/login", authLimiter, loginController);

// Refresh Token (Cookie sent automatically)
authRoutes.post("/refresh", refreshLimiter, refreshTokenController);

// Google OAuth - Initiate
authRoutes.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false,
  })
);

// Google OAuth - Callback
authRoutes.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: failedUrl,
    session: false,
  }),
  googleLoginCallback
);

// ============================================
// PROTECTED ROUTES (Auth Required)
// ============================================

// Logout from current device
authRoutes.post("/logout", logOutController);

// Logout from all devices (requires current auth)
authRoutes.post("/logout-all", passportAuthenticateJWT, logOutAllController);

// Get all active sessions (for "Manage Devices" UI)
authRoutes.get("/sessions", passportAuthenticateJWT, getSessionsController);

export default authRoutes;