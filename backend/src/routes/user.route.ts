import { Router } from "express";
import { createRateLimiter } from "../utils/rate-limiter";
import {
  getCurrentUserController,
  updateProfileController,
  deleteAccountController,
} from "../controllers/user.controller";

const userRoutes = Router();

// Destructive and irreversible - worth bounding even behind auth, same
// reasoning as changePasswordLimiter in auth.route.ts.
const deleteAccountLimiter = createRateLimiter("delete-account", {
  max: 5,
  message: { error: "Too many attempts. Please try again later." },
});

userRoutes.get("/current", getCurrentUserController);
userRoutes.patch("/current", updateProfileController);
userRoutes.delete("/current", deleteAccountLimiter, deleteAccountController);

export default userRoutes;
