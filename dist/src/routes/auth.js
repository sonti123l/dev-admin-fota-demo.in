import { Hono } from "hono";
import { db } from "../db/db.js";
import { users, refreshTokens } from "../db/schema/users.js";
import { eq, and, isNull } from "drizzle-orm";
import { hashPassword, verifyPassword, generateAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken, } from "../lib/auth.js";
export const authRouter = new Hono();
/**
 * POST /signup (and /auth/signup)
 * Register a new user with role 'fota_manage'.
 */
authRouter.post("/signup", async (c) => {
    try {
        let body;
        const contentType = c.req.header("Content-Type") || "";
        if (contentType.includes("application/json")) {
            body = await c.req.json();
        }
        else {
            body = await c.req.parseBody();
        }
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        const role = typeof body.role === "string" && body.role.trim() ? body.role.trim() : "fota_manage";
        if (!name) {
            return c.json({ success: false, error: "Name is required" }, 400);
        }
        if (!email || !email.includes("@")) {
            return c.json({ success: false, error: "Valid email address is required" }, 400);
        }
        if (!password || password.length < 6) {
            return c.json({ success: false, error: "Password must be at least 6 characters" }, 400);
        }
        // Check if user already exists
        const existing = await db
            .select()
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
        if (existing.length > 0) {
            return c.json({ success: false, error: "An account with this email already exists" }, 409);
        }
        // Hash password & insert user
        const passwordHash = await hashPassword(password);
        const insertedUsers = await db
            .insert(users)
            .values({
            email,
            passwordHash,
            name,
            role,
        })
            .returning();
        const newUser = insertedUsers[0];
        // Issue tokens
        const accessToken = generateAccessToken({
            userId: newUser.id,
            email: newUser.email,
            name: newUser.name || "",
            role: newUser.role || "fota_manage",
        });
        const rt = generateRefreshToken();
        await db.insert(refreshTokens).values({
            userId: newUser.id,
            tokenHash: rt.tokenHash,
            familyId: rt.familyId,
            expiresAt: rt.expiresAt,
        });
        return c.json({
            success: true,
            session: {
                token: accessToken,
                refreshToken: rt.rawToken,
                user: {
                    id: String(newUser.id),
                    name: newUser.name || "",
                    email: newUser.email,
                    role: newUser.role || "fota_manage",
                    createdAt: newUser.createdAt || new Date().toISOString(),
                },
            },
        }, 201);
    }
    catch (err) {
        console.error("[AUTH] Signup error:", err);
        return c.json({
            success: false,
            error: err instanceof Error ? err.message : "Signup failed",
        }, 500);
    }
});
/**
 * POST /login (and /auth/login)
 * Authenticate existing user by email and password.
 */
authRouter.post("/login", async (c) => {
    try {
        let body;
        const contentType = c.req.header("Content-Type") || "";
        if (contentType.includes("application/json")) {
            body = await c.req.json();
        }
        else {
            body = await c.req.parseBody();
        }
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!email || !password) {
            return c.json({ success: false, error: "Email and password are required" }, 400);
        }
        const userRows = await db
            .select()
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
        if (userRows.length === 0) {
            return c.json({ success: false, error: "Invalid email or password" }, 401);
        }
        const user = userRows[0];
        const isPasswordValid = await verifyPassword(password, user.passwordHash);
        if (!isPasswordValid) {
            return c.json({ success: false, error: "Invalid email or password" }, 401);
        }
        // Issue tokens
        const accessToken = generateAccessToken({
            userId: user.id,
            email: user.email,
            name: user.name || "",
            role: user.role || "fota_manage",
        });
        const rt = generateRefreshToken();
        await db.insert(refreshTokens).values({
            userId: user.id,
            tokenHash: rt.tokenHash,
            familyId: rt.familyId,
            expiresAt: rt.expiresAt,
        });
        return c.json({
            success: true,
            session: {
                token: accessToken,
                refreshToken: rt.rawToken,
                user: {
                    id: String(user.id),
                    name: user.name || "",
                    email: user.email,
                    role: user.role || "fota_manage",
                    createdAt: user.createdAt || new Date().toISOString(),
                },
            },
        });
    }
    catch (err) {
        console.error("[AUTH] Login error:", err);
        return c.json({
            success: false,
            error: err instanceof Error ? err.message : "Login failed",
        }, 500);
    }
});
/**
 * POST /refresh-token (and /auth/refresh-token)
 * Exchange a valid refresh token for a new access token.
 */
authRouter.post("/refresh-token", async (c) => {
    try {
        let body;
        const contentType = c.req.header("Content-Type") || "";
        if (contentType.includes("application/json")) {
            body = await c.req.json();
        }
        else {
            body = await c.req.parseBody();
        }
        const rawToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
        if (!rawToken) {
            return c.json({ success: false, error: "Refresh token is required" }, 400);
        }
        const tokenHash = hashRefreshToken(rawToken);
        // Look up refresh token
        const tokenRows = await db
            .select()
            .from(refreshTokens)
            .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
            .limit(1);
        if (tokenRows.length === 0) {
            return c.json({ success: false, error: "Invalid or revoked refresh token" }, 401);
        }
        const storedToken = tokenRows[0];
        if (new Date(storedToken.expiresAt) < new Date()) {
            return c.json({ success: false, error: "Refresh token has expired" }, 401);
        }
        // Look up user
        const userRows = await db
            .select()
            .from(users)
            .where(eq(users.id, storedToken.userId))
            .limit(1);
        if (userRows.length === 0) {
            return c.json({ success: false, error: "User not found" }, 404);
        }
        const user = userRows[0];
        const newAccessToken = generateAccessToken({
            userId: user.id,
            email: user.email,
            name: user.name || "",
            role: user.role || "fota_manage",
        });
        return c.json({
            success: true,
            access_token: newAccessToken,
            token: newAccessToken,
        });
    }
    catch (err) {
        console.error("[AUTH] Refresh token error:", err);
        return c.json({
            success: false,
            error: err instanceof Error ? err.message : "Token refresh failed",
        }, 500);
    }
});
/**
 * GET /me (and /auth/me)
 * Get authenticated user profile from Authorization header.
 */
authRouter.get("/me", async (c) => {
    try {
        const authHeader = c.req.header("Authorization") || "";
        if (!authHeader.startsWith("Bearer ")) {
            return c.json({ success: false, error: "Missing or invalid authorization header" }, 401);
        }
        const token = authHeader.substring(7).trim();
        const payload = verifyAccessToken(token);
        if (!payload) {
            return c.json({ success: false, error: "Invalid or expired token" }, 401);
        }
        const userRows = await db
            .select()
            .from(users)
            .where(eq(users.id, payload.userId))
            .limit(1);
        if (userRows.length === 0) {
            return c.json({ success: false, error: "User not found" }, 404);
        }
        const user = userRows[0];
        return c.json({
            success: true,
            user: {
                id: String(user.id),
                name: user.name || "",
                email: user.email,
                role: user.role || "fota_manage",
                createdAt: user.createdAt || new Date().toISOString(),
            },
        });
    }
    catch (err) {
        console.error("[AUTH] Get user error:", err);
        return c.json({
            success: false,
            error: err instanceof Error ? err.message : "Failed to get user profile",
        }, 500);
    }
});
/**
 * POST /logout (and /auth/logout)
 * Revoke refresh token and invalidate session.
 */
authRouter.post("/logout", async (c) => {
    try {
        let body = {};
        try {
            const contentType = c.req.header("Content-Type") || "";
            if (contentType.includes("application/json")) {
                body = await c.req.json();
            }
            else {
                body = await c.req.parseBody();
            }
        }
        catch {
            // Body may be empty
        }
        const rawToken = typeof body?.refreshToken === "string" ? body.refreshToken : "";
        if (rawToken) {
            const tokenHash = hashRefreshToken(rawToken);
            await db
                .update(refreshTokens)
                .set({ revokedAt: new Date().toISOString() })
                .where(eq(refreshTokens.tokenHash, tokenHash));
        }
        return c.json({ success: true, message: "Logged out successfully" });
    }
    catch (err) {
        console.error("[AUTH] Logout error:", err);
        return c.json({ success: true }); // Always return success on logout
    }
});
