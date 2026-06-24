import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

export const tuDevices = pgTable("tu_devices", {
  id: serial("id").primaryKey(),
});

export const tuFotaDetails = pgTable("tu_fota_details", {
  id: serial("id").primaryKey(),
  deviceId: integer("device_id").references(() => tuDevices.id),
  deviceOldVersion: text("device_old_version"),
  deviceNewVersion: text("device_new_version"),
  webOldVersion: text("web_old_version"),
  webNewVersion: text("web_new_version"),
  status: text("status"),
  deviceFotaUrl: text("device_fota_url"),
  webFotaUrl: text("web_fota_url"),
});