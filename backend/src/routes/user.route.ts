import { Router } from "express";
import { createRateLimiter } from "../utils/rate-limiter";
import {
  getCurrentUserController,
  updateProfileController,
  deleteAccountController,
} from "../controllers/user.controller";

const userRoutes = Router();

const deleteAccountLimiter = createRateLimiter("delete-account", {
  max: 5,
  message: { error: "Too many attempts. Please try again later." },
});

userRoutes.get("/current", getCurrentUserController);
userRoutes.patch("/current", updateProfileController);
userRoutes.delete("/current", deleteAccountLimiter, deleteAccountController);

export default userRoutes;
