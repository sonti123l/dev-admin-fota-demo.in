import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db/db.js";
import { tuFotaDetails } from "./db/schema/fota_details.js";
import { eq } from "drizzle-orm";

const app = new Hono();

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.use("*", cors());

app.get("/:deviceId/get-fota-details", async (c) => {
  const deviceId = parseInt(c.req.param("deviceId"));

  if (isNaN(deviceId)) {
    return c.json({ error: "Invalid device ID" }, 400);
  }

  const fotaDetails = await db
    .select()
    .from(tuFotaDetails)
    .where(eq(tuFotaDetails.deviceId, deviceId));

  if (fotaDetails.length === 0) {
    return c.json({ error: "No FOTA details found for this device" }, 404);
  }

  return c.json({ fotaDetails });
});
serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
