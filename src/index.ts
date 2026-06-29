import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db/db.js";
import { tuFotaDetails } from "./db/schema/fota_details.js";
import { eq, desc, and, or } from "drizzle-orm";

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

  const latest = await db
    .select()
    .from(tuFotaDetails)
    .where(eq(tuFotaDetails.deviceId, deviceId))
    .orderBy(desc(tuFotaDetails.id))
    .limit(1);

  const fotaDetails = latest[0];

  if (latest.length === 0) {
    return c.json({ error: "No FOTA details found for this device" }, 404);
  }

  return c.json({ fotaDetails });
});

app.patch("/:deviceId/update-fota-status", async (c) => {
  const deviceId = parseInt(c.req.param("deviceId"));

  if (isNaN(deviceId)) {
    return c.json({ error: "Invalid device ID" }, 400);
  }

  const body = await c.req.json();
  const device_status = body.device_status;
  const web_status = body.web_status

  const latest = await db
    .select({ id: tuFotaDetails.id })
    .from(tuFotaDetails)
    .where(eq(tuFotaDetails.deviceId, deviceId))
    .orderBy(desc(tuFotaDetails.id))
    .limit(1);

  if (latest.length === 0) {
    return c.json({ error: "No FOTA details found for this device" }, 404);
  }

  const updated = await db
    .update(tuFotaDetails)
    .set({ device_status: device_status, web_status: web_status })
    .where(eq(tuFotaDetails.id, latest[0].id))
    .returning();

  return c.json({ data: updated[0] });
});

app.post("/add-fota-details", async (c) => {
  const response = await c.req.json();

  const device_id = response.device_id;

  // const check_device_id_with_same_version_present_or_not = await db
  //   .select({ id: tuFotaDetails.id })
  //   .from(tuFotaDetails)
  //   .where(
  //     and(
  //       eq(tuFotaDetails.deviceId, device_id),
  //       or(
  //         eq(tuFotaDetails.deviceNewVersion, response.device_new_version),
  //         eq(tuFotaDetails.webNewVersion, response.web_new_version),
  //       ),
  //     ),
  //   );

  // console.log(check_device_id_with_same_version_present_or_not);

  // if (check_device_id_with_same_version_present_or_not?.length > 0) {
  //   return c.json({ message: "Already present with same version number" });
  // }

  const insert_into_fota_details = await db
    .insert(tuFotaDetails)
    .values({
      deviceId: device_id,
      deviceOldVersion: response.device_old_version,
      deviceNewVersion: response.device_new_version,
      webOldVersion: response.web_old_version,
      webNewVersion: response.web_new_version,
      device_status: "NEWIMAGE",
      web_status: "NEWIMAGE",
      deviceFotaUrl: response.device_update_url,
      webFotaUrl: response.web_update_url,
    })
    .returning({ id: tuFotaDetails.id });

  if (insert_into_fota_details[0]?.id) {
    return c.json({ message: "created successfully" });
  }

  return c.json({ message: "Not created successfully" });
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
