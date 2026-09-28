import { Hono } from "hono";
import { authController } from "../controllers/authController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
export const authRoutes = new Hono();
authRoutes.post("/signup", (c) => authController.signup(c));
authRoutes.post("/login", (c) => authController.login(c));
authRoutes.post("/refresh-token", (c) => authController.refreshToken(c));
authRoutes.get("/me", authMiddleware, (c) => authController.getMe(c));
authRoutes.post("/logout", authMiddleware, (c) => authController.logout(c));
