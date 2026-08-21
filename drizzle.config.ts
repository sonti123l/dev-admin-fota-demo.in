import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/fota_details.ts", // only this file, not a schema dir with tuDevices in it
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_PATH!,
  },
  tablesFilter: ["tu_fota_details"], // belt-and-suspenders: even if tuDevices sneaks in, ignore it
});