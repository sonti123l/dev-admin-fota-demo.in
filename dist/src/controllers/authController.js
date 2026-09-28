import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db } from "../db/db.js";
import { users } from "../db/schema/users.js";
import { eq } from "drizzle-orm";
const JWT_SECRET = process.env.JWT_SECRET || "tu_fota_jwt_secret_key_2026_super_secure_key_12345";
const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || "7d");
const REFRESH_TOKEN_EXPIRES_DAYS = parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS || "30");
class AuthController {
    /**
     * Register a new FOTA Manager.
     */
    async signup(c) {
        try {
            const body = await c.req.json();
            const { email, password, name } = body;
            if (!email || typeof email !== "string" || !email.includes("@")) {
                return c.json({ error: "A valid email is required" }, 400);
            }
            if (!password || typeof password !== "string" || password.length < 6) {
                return c.json({ error: "Password must be at least 6 characters long" }, 400);
            }
            const normalizedEmail = email.toLowerCase().trim();
            // Check if user already exists
            const existing = await db
                .select()
                .from(users)
                .where(eq(users.email, normalizedEmail))
                .limit(1);
            if (existing.length > 0) {
                return c.json({ error: "A FOTA Manager with this email already exists" }, 409);
            }
            // Hash password
            const passwordHash = await bcrypt.hash(password, 10);
            const managerName = typeof name === "string" && name.trim().length > 0
                ? name.trim()
                : normalizedEmail.split("@")[0];
            // Insert new manager
            const inserted = await db
                .insert(users)
                .values({
                email: normalizedEmail,
                passwordHash,
                name: managerName,
                role: "fota_manager",
            })
                .returning({
                id: users.id,
                email: users.email,
                name: users.name,
                role: users.role,
                createdAt: users.createdAt,
            });
            const newUser = inserted[0];
            // Issue tokens
            const accessToken = jwt.sign({
                id: newUser.id,
                email: newUser.email,
                role: newUser.role,
                name: newUser.name,
            }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
            const refreshToken = jwt.sign({ id: newUser.id, type: "refresh" }, JWT_SECRET, { expiresIn: `${REFRESH_TOKEN_EXPIRES_DAYS}d` });
            // Store refresh token
            await db
                .update(users)
                .set({ refreshToken })
                .where(eq(users.id, newUser.id));
            return c.json({
                message: "FOTA Manager registered successfully",
                access_token: accessToken,
                refresh_token: refreshToken,
                user: {
                    id: newUser.id,
                    email: newUser.email,
                    name: newUser.name,
                    role: newUser.role,
                },
            }, 201);
        }
        catch (err) {
            console.error("[ERROR] Signup failed", err);
            return c.json({ error: err instanceof Error ? err.message : "Signup failed" }, 500);
        }
    }
    /**
     * Log in an existing FOTA Manager.
     */
    async login(c) {
        try {
            const body = await c.req.json();
            const { email, password } = body;
            if (!email || !password) {
                return c.json({ error: "Email and password are required" }, 400);
            }
            const normalizedEmail = String(email).toLowerCase().trim();
            const matched = await db
                .select()
                .from(users)
                .where(eq(users.email, normalizedEmail))
                .limit(1);
            if (matched.length === 0) {
                return c.json({ error: "Invalid email or password" }, 401);
            }
            const user = matched[0];
            const isMatch = await bcrypt.compare(String(password), user.passwordHash);
            if (!isMatch) {
                return c.json({ error: "Invalid email or password" }, 401);
            }
            // Generate tokens
            const accessToken = jwt.sign({
                id: user.id,
                email: user.email,
                role: user.role,
                name: user.name,
            }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
            const refreshToken = jwt.sign({ id: user.id, type: "refresh" }, JWT_SECRET, { expiresIn: `${REFRESH_TOKEN_EXPIRES_DAYS}d` });
            // Persist active refresh token
            await db
                .update(users)
                .set({ refreshToken })
                .where(eq(users.id, user.id));
            return c.json({
                message: "Login successful",
                access_token: accessToken,
                refresh_token: refreshToken,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                },
            });
        }
        catch (err) {
            console.error("[ERROR] Login failed", err);
            return c.json({ error: err instanceof Error ? err.message : "Login failed" }, 500);
        }
    }
    /**
     * Refresh the access token using a valid refresh token.
     */
    async refreshToken(c) {
        try {
            const body = await c.req.json().catch(() => ({}));
            const refreshToken = body["refreshToken"] || body["refresh_token"];
            if (!refreshToken || typeof refreshToken !== "string") {
                return c.json({ error: "Refresh token is required" }, 400);
            }
            let decoded;
            try {
                decoded = jwt.verify(refreshToken, JWT_SECRET);
            }
            catch (err) {
                return c.json({ error: "Invalid or expired refresh token" }, 401);
            }
            if (!decoded?.id || decoded.type !== "refresh") {
                return c.json({ error: "Invalid refresh token payload" }, 401);
            }
            // Verify the user exists and the token matches the stored token
            const matched = await db
                .select()
                .from(users)
                .where(eq(users.id, decoded.id))
                .limit(1);
            if (matched.length === 0 || matched[0].refreshToken !== refreshToken) {
                return c.json({ error: "Refresh token has been revoked or is invalid" }, 401);
            }
            const user = matched[0];
            // Issue new access token
            const newAccessToken = jwt.sign({
                id: user.id,
                email: user.email,
                role: user.role,
                name: user.name,
            }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
            return c.json({
                access_token: newAccessToken,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role: user.role,
                },
            });
        }
        catch (err) {
            console.error("[ERROR] Token refresh failed", err);
            return c.json({ error: err instanceof Error ? err.message : "Token refresh failed" }, 500);
        }
    }
    /**
     * Get current authenticated FOTA Manager profile.
     */
    async getMe(c) {
        const user = c.get("user");
        return c.json({
            user,
        });
    }
    /**
     * Log out manager and invalidate refresh token.
     */
    async logout(c) {
        try {
            const user = c.get("user");
            if (user?.id) {
                await db
                    .update(users)
                    .set({ refreshToken: null })
                    .where(eq(users.id, user.id));
            }
            return c.json({
                message: "Logged out successfully",
            });
        }
        catch (err) {
            console.error("[ERROR] Logout failed", err);
            return c.json({ error: err instanceof Error ? err.message : "Logout failed" }, 500);
        }
    }
}
export const authController = new AuthController();
