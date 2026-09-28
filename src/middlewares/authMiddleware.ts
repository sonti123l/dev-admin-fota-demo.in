import type { Context, Next } from "hono";
import jwt from "jsonwebtoken";
import { db } from "../db/db.js";
import { users } from "../db/schema/users.js";
import { eq } from "drizzle-orm";

const JWT_SECRET =
  process.env.JWT_SECRET || "tu_fota_jwt_secret_key_2026_super_secure_key_12345";

export interface AuthenticatedUser {
  id: number;
  email: string;
  name: string | null;
  role: string | null;
  createdAt: string | null;
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthenticatedUser;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization token" }, 401);
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: number;
      email: string;
      role?: string;
    };

    if (!decoded?.id) {
      return c.json({ error: "Invalid token payload" }, 401);
    }

    const matchedUsers = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, decoded.id))
      .limit(1);

    if (!matchedUsers || matchedUsers.length === 0) {
      return c.json({ error: "User not found or account deactivated" }, 401);
    }

    c.set("user", matchedUsers[0]);
    await next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return c.json({ error: "Token expired" }, 401);
    }
    return c.json({ error: "Invalid token" }, 401);
  }
}
