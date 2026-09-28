import type { Context } from "hono";
import { db } from "../db/db.js";
import { tuDevices } from "../db/schema/fota_details.js";

class DeviceController {
  /**
   * GET /devices-list
   * Returns every row in tu_devices for device selection.
   */
  async getDevicesList(c: Context) {
    try {
      const devices = await db.select().from(tuDevices);
      return c.json({
        list: devices ?? [],
      });
    } catch (err) {
      console.error("[ERROR] /devices-list failed", err);
      return c.json(
        {
          error:
            err instanceof Error ? err.message : "Failed to fetch devices list",
        },
        500,
      );
    }
  }
}

export const deviceController = new DeviceController();
