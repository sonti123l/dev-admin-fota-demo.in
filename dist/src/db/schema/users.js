import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const users = sqliteTable("tu_fota_managers", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    name: text("name"),
    role: text("role").default("fota_manager"),
    refreshToken: text("refresh_token"),
    createdAt: text("created_at").default(sql `CURRENT_TIMESTAMP`),
});
