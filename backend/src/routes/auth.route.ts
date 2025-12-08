import { Router } from "express";
import passport from "passport";
import { config } from "../config/app.config";
import {
  googleLoginCallback,
  loginController,
  logoutController,
  registerUserController,
} from "../controllers/auth.controller";

const failedUrl = `${config.FRONTEND_GOOGLE_CALLBACK_URL}?status=failure`;
const authRoutes = Router();

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Register a new user
 *     description: Creates a new user using email, password, and other required fields.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegisterUserInput'
 *     responses:
 *       201:
 *         description: User registered successfully
 *       400:
 *         description: Invalid input data
 *       409:
 *         description: User already exists
 */
authRoutes.post("/register", registerUserController);

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Login with email and password
 *     description: Authenticates a user using local strategy and returns user session.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginUserInput'
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid email or password
 */
authRoutes.post("/login", loginController);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Logout user
 *     description: Logs out the authenticated user and destroys the session.
 *     responses:
 *       200:
 *         description: Logged out successfully
 *       401:
 *         description: User not logged in
 */
authRoutes.post("/logout", logoutController);

/**
 * @openapi
 * /auth/google:
 *   get:
 *     tags:
 *       - Auth
 *     summary: Login with Google
 *     description: Redirects user to Google OAuth consent screen.
 *     responses:
 *       302:
 *         description: Redirect to Google OAuth
 */
authRoutes.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
  })
);

/**
 * @openapi
 * /auth/google/callback:
 *   get:
 *     tags:
 *       - Auth
 *     summary: Google OAuth callback
 *     description: Handles Google OAuth callback and finalizes login.
 *     responses:
 *       302:
 *         description: Redirects user to frontend with authentication status
 */
authRoutes.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: failedUrl,
  }),
  googleLoginCallback
);

export default authRoutes;
