import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { sqlite } from "../db/db.js";
const JWT_SECRET = process.env.JWT_SECRET || "tu_fota_jwt_secret_key_2026_super_secure_key_12345";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const REFRESH_TOKEN_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS) || 30;
/**
 * Hash a plain password using bcrypt (10 rounds).
 */
export async function hashPassword(password) {
    return await bcrypt.hash(password, 10);
}
/**
 * Multi-algorithm password verification.
 * Supports:
 * 1. bcrypt ($2a$, $2b$, $2y$)
 * 2. Werkzeug / Passlib scrypt format (scrypt:N:r:p$salt$hash)
 * 3. SHA-256 (64 hex characters)
 * 4. Plaintext fallback
 */
export async function verifyPassword(password, storedHash) {
    if (!storedHash || !password)
        return false;
    try {
        // 1. bcrypt check
        if (storedHash.startsWith("$2a$") || storedHash.startsWith("$2b$") || storedHash.startsWith("$2y$")) {
            return await bcrypt.compare(password, storedHash);
        }
        // 2. Python werkzeug scrypt format
        if (storedHash.startsWith("scrypt:")) {
            const parts = storedHash.split("$");
            if (parts.length === 3) {
                const [method, salt, key] = parts;
                const configParts = method.split(":");
                if (configParts.length === 4) {
                    const N = parseInt(configParts[1], 10);
                    const r = parseInt(configParts[2], 10);
                    const p = parseInt(configParts[3], 10);
                    const derived = crypto
                        .scryptSync(password, salt, key.length / 2, {
                        N,
                        r,
                        p,
                        maxmem: 64 * 1024 * 1024,
                    })
                        .toString("hex");
                    return crypto.timingSafeEqual(Buffer.from(derived, "hex"), Buffer.from(key, "hex"));
                }
            }
        }
        // 3. SHA-256 hex hash check
        if (storedHash.length === 64 && /^[0-9a-f]{64}$/i.test(storedHash)) {
            const sha256 = crypto.createHash("sha256").update(password).digest("hex");
            return sha256.toLowerCase() === storedHash.toLowerCase();
        }
        // 4. Plain text equality fallback
        return password === storedHash;
    }
    catch (err) {
        console.error("[AUTH] Error verifying password:", err);
        return false;
    }
}
/**
 * Issue a signed JWT access token.
 */
export function generateAccessToken(payload) {
    return jwt.sign(payload, JWT_SECRET, {
        expiresIn: JWT_EXPIRES_IN,
    });
}
/**
 * Verify and decode a JWT access token.
 */
export function verifyAccessToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    }
    catch {
        return null;
    }
}
/**
 * Hash a refresh token string using SHA-256 for secure storage.
 */
export function hashRefreshToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}
/**
 * Generate a new random refresh token and calculate its expiration date.
 */
export function generateRefreshToken() {
    const rawToken = crypto.randomBytes(40).toString("hex");
    const tokenHash = hashRefreshToken(rawToken);
    const familyId = crypto.randomUUID();
    const expiresDate = new Date();
    expiresDate.setDate(expiresDate.getDate() + REFRESH_TOKEN_DAYS);
    return {
        rawToken,
        tokenHash,
        familyId,
        expiresAt: expiresDate.toISOString(),
    };
}
/**
 * Ensure database table schemas and default demo admin exist.
 */
export async function ensureAuthSchemaReady() {
    try {
        // 1. Ensure `users` table exists
        sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT,
        role TEXT DEFAULT 'fota_manage',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        // 2. Ensure `role` column exists in `users`
        const userColumns = sqlite.prepare("PRAGMA table_info(users)").all();
        const hasRole = userColumns.some((col) => col.name === "role");
        if (!hasRole) {
            sqlite.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'fota_manage'");
            console.log("[AUTH] Added 'role' column to users table");
        }
        // 3. Ensure `refresh_tokens` table exists
        sqlite.exec(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL,
        family_id TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
        // 4. Seed demo admin user if absent
        const demoEmail = "admin@thirdumpire.ai";
        const existing = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(demoEmail);
        if (!existing) {
            const hashedDemoPassword = await hashPassword("Admin@12345");
            sqlite
                .prepare("INSERT OR IGNORE INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'fota_manage')")
                .run(demoEmail, hashedDemoPassword, "FOTA Administrator");
            console.log(`[AUTH] Seeded default demo admin: ${demoEmail}`);
        }
    }
    catch (err) {
        console.error("[AUTH] Error initializing auth schema:", err);
    }
}
