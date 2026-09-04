import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const tuDevices = sqliteTable("tu_devices", {
  id: integer("id").primaryKey({ autoIncrement: true }),

  hardwareUuid: text("hardware_uuid").notNull().unique(),

  name: text("name"),

  siteId: integer("site_id"),

  status: text("status").default("pending"),

  firmwareVersion: text("firmware_version"),
  deviceVersion: text("device_version"),


  lastHeartbeat: text("last_heartbeat"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const tuFotaDetails = sqliteTable("tu_fota_details", {
  id: integer("id").primaryKey({ autoIncrement: true }),

  deviceId: integer("device_id").references(() => tuDevices.id),

  deviceOldVersion: text("deviceOldVersion").default(""),
  deviceNewVersion: text("deviceNewVersion").default(""),

  webOldVersion: text("webOldVersion").default(""),
  webNewVersion: text("webNewVersion").default(""),

  deviceStatus: integer("device_status"),
  webStatus: integer("web_status"),

  deviceFotaUrl: text("devicefotaurl"),
  webFotaUrl: text("webfotaurl"),

  fotaOldVersion: text("fotaOldVersion").default(""),
  fotaNewVersion: text("fotaNewVersion").default(""),

  fotaUpdateUrl: text("fotaUpdateUrl").default(""),

  fotaStatus: text("fota_status").default(""),

  createdAt: integer("created_at", { mode: "timestamp" }),
});
