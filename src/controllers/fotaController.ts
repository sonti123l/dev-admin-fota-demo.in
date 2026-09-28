import type { Context } from "hono";
import { db } from "../db/db.js";
import { tuFotaDetails, tuDevices } from "../db/schema/fota_details.js";
import { users } from "../db/schema/users.js";
import { and, ne, isNotNull, eq, desc } from "drizzle-orm";
import fs from "fs";
import { Readable } from "stream";
import jwt from "jsonwebtoken";
import { emailService } from "../services/emailService.js";
import {
  type FotaComponent,
  isValidComponent,
  getStoredFileNameForComponent,
  resolveZipPath,
  saveUploadedZip,
  getContentTypeForFileName,
} from "../utils/fotaStorage.js";
import { validateVersion } from "../utils/versionUtils.js";

const JWT_SECRET =
  process.env.JWT_SECRET || "tu_fota_jwt_secret_key_2026_super_secure_key_12345";

/**
 * Resolve device ID from either an integer ID or a hardware UUID.
 */
export async function resolveDeviceId(param: string): Promise<number | null> {
  const trimmed = (param || "").trim();
  const parsed = parseInt(trimmed);
  if (!isNaN(parsed) && String(parsed) === trimmed) {
    return parsed;
  }
  const matched = await db
    .select({ id: tuDevices.id })
    .from(tuDevices)
    .where(eq(tuDevices.hardwareUuid, trimmed))
    .limit(1);

  if (matched.length > 0) {
    return matched[0].id;
  }

  if (!isNaN(parsed)) {
    return parsed;
  }

  return null;
}

/**
 * Look up the most recent row that has a non-empty value for the given old version column.
 */
async function getLatestNonEmpty(
  column:
    | typeof tuFotaDetails.deviceOldVersion
    | typeof tuFotaDetails.webOldVersion,
  device_id: number,
) {
  return db
    .select()
    .from(tuFotaDetails)
    .where(
      and(
        ne(column, ""),
        isNotNull(column),
        eq(tuFotaDetails.deviceId, device_id),
      ),
    )
    .orderBy(desc(tuFotaDetails.id))
    .limit(1);
}

class FotaController {
  /**
   * POST /add-fota-details
   * Accepts multipart/form-data with package files and version definitions.
   */
  async addFotaDetails(c: Context) {
    const body = await c.req.parseBody();

    const deviceIdRaw = body["device_id"];
    const device_id =
      typeof deviceIdRaw === "string" ? parseInt(deviceIdRaw) : NaN;

    if (isNaN(device_id)) {
      return c.json({ error: "Invalid device ID" }, 400);
    }

    const getStringField = (key: string): string => {
      const value = body[key];
      return typeof value === "string" ? value : "";
    };

    const deviceZipFile = body["device_zip"];
    const webZipFile = body["web_zip"];
    const fotaZipFile = body["fota_zip"];

    const deviceOldVersionInput = getStringField("device_old_version");
    const deviceNewVersionInput = getStringField("device_new_version");
    const webOldVersionInput = getStringField("web_old_version");
    const webNewVersionInput = getStringField("web_new_version");
    const fotaOldVersionInput = getStringField("fota_old_version");
    const fotaNewVersionInput = getStringField("fota_new_version");

    try {
      // 1. Fetch latest deployment record for this device
      const latestRows = await db
        .select()
        .from(tuFotaDetails)
        .where(eq(tuFotaDetails.deviceId, device_id))
        .orderBy(desc(tuFotaDetails.id))
        .limit(1);
      const latestFota = latestRows[0] ?? null;

      // 2. Fetch device record
      const deviceRows = await db
        .select()
        .from(tuDevices)
        .where(eq(tuDevices.id, device_id))
        .limit(1);
      const currentDev = deviceRows[0] ?? null;

      const currentDeviceVersion = (
        deviceOldVersionInput.trim() ||
        (latestFota?.deviceStatus === 1 ? latestFota.deviceNewVersion : null) ||
        latestFota?.deviceOldVersion ||
        currentDev?.firmwareVersion ||
        currentDev?.deviceVersion ||
        "0.0.0"
      ).trim();

      const currentWebVersion = (
        webOldVersionInput.trim() ||
        (latestFota?.webStatus === 1 ? latestFota.webNewVersion : null) ||
        latestFota?.webOldVersion ||
        (currentDev as any)?.web_version ||
        "0.0.0"
      ).trim();

      const currentFotaVersion = (
        fotaOldVersionInput.trim() ||
        (latestFota?.fotaStatus === "APPLIED" ? latestFota.fotaNewVersion : null) ||
        latestFota?.fotaOldVersion ||
        "0.0.0"
      ).trim();

      // Check which components require an update
      const hasDeviceZip = deviceZipFile instanceof File;
      const hasWebZip = webZipFile instanceof File;
      const hasFotaZip = fotaZipFile instanceof File;

      const hasDeviceVersion = Boolean(
        deviceNewVersionInput && deviceNewVersionInput.trim() !== "",
      );
      const hasWebVersion = Boolean(
        webNewVersionInput && webNewVersionInput.trim() !== "",
      );
      const hasFotaVersion = Boolean(
        fotaNewVersionInput && fotaNewVersionInput.trim() !== "",
      );

      const isDeviceUpdating = hasDeviceZip || hasDeviceVersion;
      const isWebUpdating = hasWebZip || hasWebVersion;
      const isFotaUpdating = hasFotaZip || hasFotaVersion;

      if (!isDeviceUpdating && !isWebUpdating && !isFotaUpdating) {
        return c.json(
          {
            error:
              "At least one component (Device Firmware, Web Application, or FOTA Updater) must be selected for update with a greater version and package.",
          },
          400,
        );
      }

      // Strict version validation: Must be valid SemVer and strictly greater than current version
      if (isDeviceUpdating) {
        if (!hasDeviceVersion) {
          return c.json(
            { error: "Device target new version is required when updating device firmware." },
            400,
          );
        }
        const devVal = validateVersion(deviceNewVersionInput, currentDeviceVersion);
        if (!devVal.isValid || !devVal.isGreater) {
          return c.json(
            {
              error:
                devVal.error ||
                `Device new version (${deviceNewVersionInput}) must be strictly greater than current version (${currentDeviceVersion}).`,
            },
            400,
          );
        }
      }

      if (isWebUpdating) {
        if (!hasWebVersion) {
          return c.json(
            { error: "Web target new version is required when updating web application." },
            400,
          );
        }
        const webVal = validateVersion(webNewVersionInput, currentWebVersion);
        if (!webVal.isValid || !webVal.isGreater) {
          return c.json(
            {
              error:
                webVal.error ||
                `Web new version (${webNewVersionInput}) must be strictly greater than current version (${currentWebVersion}).`,
            },
            400,
          );
        }
      }

      if (isFotaUpdating) {
        if (!hasFotaVersion) {
          return c.json(
            { error: "FOTA target new version is required when updating FOTA updater." },
            400,
          );
        }
        const fotaVal = validateVersion(fotaNewVersionInput, currentFotaVersion);
        if (!fotaVal.isValid || !fotaVal.isGreater) {
          return c.json(
            {
              error:
                fotaVal.error ||
                `FOTA new version (${fotaNewVersionInput}) must be strictly greater than current version (${currentFotaVersion}).`,
            },
            400,
          );
        }
      }

      let deviceFileName: string | null = "";
      let webFileName: string | null = "";
      let fotaFileName: string | null = "";

      try {
        if (isDeviceUpdating && hasDeviceZip) {
          deviceFileName = await saveUploadedZip(
            deviceZipFile,
            "device",
            deviceNewVersionInput,
          );
        }
        if (isWebUpdating && hasWebZip) {
          webFileName = await saveUploadedZip(
            webZipFile,
            "web",
            webNewVersionInput,
          );
        }
        if (isFotaUpdating && hasFotaZip) {
          fotaFileName = await saveUploadedZip(
            fotaZipFile,
            "fota",
            fotaNewVersionInput,
          );
        }
      } catch (err) {
        console.error("[ERROR] Failed to save uploaded FOTA archive", err);
        return c.json(
          {
            error:
              err instanceof Error
                ? err.message
                : "Failed to save uploaded file",
          },
          400,
        );
      }

      // User rules:
      // 1. Whichever is going to update enters 'pending' state (status 0).
      // 2. When update is happened only for either web/device, the one that doesn't require update becomes 'success' (status 1) by default!
      const deviceOldVersion = currentDeviceVersion;
      const deviceNewVersion = isDeviceUpdating
        ? deviceNewVersionInput.trim()
        : currentDeviceVersion;
      const deviceStatus = isDeviceUpdating ? 0 : 1;
      const deviceFotaUrl = isDeviceUpdating ? deviceFileName || "" : "";

      const webOldVersion = currentWebVersion;
      const webNewVersion = isWebUpdating
        ? webNewVersionInput.trim()
        : currentWebVersion;
      const webStatus = isWebUpdating ? 0 : 1;
      const webFotaUrl = isWebUpdating ? webFileName || "" : "";

      const fotaOldVersion = currentFotaVersion;
      const fotaNewVersion = isFotaUpdating
        ? fotaNewVersionInput.trim()
        : currentFotaVersion;
      const fotaUpdateUrl = isFotaUpdating ? fotaFileName || "" : "";
      const fotaStatus =
        isDeviceUpdating || isWebUpdating || isFotaUpdating
          ? "PENDING"
          : "APPLIED";

      // Extract proposer user_id from auth token or form fields
      let managerUserId: number | null = null;
      let proposedByEmail = "";
      let proposedByName = "";

      const authHeader = c.req.header("Authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const token = authHeader.split(" ")[1];
          const decoded = jwt.verify(token, JWT_SECRET) as {
            id?: number;
            email?: string;
            name?: string;
          };
          if (decoded?.id) {
            managerUserId = decoded.id;
          }
        } catch {
          // Token expired or invalid
        }
      }

      if (!managerUserId && body["user_id"]) {
        const parsed = parseInt(String(body["user_id"]));
        if (!isNaN(parsed)) {
          managerUserId = parsed;
        }
      }

      // Look up manager directly from tu_fota_managers table
      if (managerUserId) {
        const managerRows = await db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
          })
          .from(users)
          .where(eq(users.id, managerUserId))
          .limit(1);

        if (managerRows.length > 0) {
          proposedByEmail = managerRows[0].email;
          proposedByName = managerRows[0].name || managerRows[0].email.split("@")[0];
        }
      }

      if (!proposedByEmail && body["proposed_by"]) {
        proposedByEmail = String(body["proposed_by"]).trim();
      }
      if (!proposedByName && body["proposed_by_name"]) {
        proposedByName = String(body["proposed_by_name"]).trim();
      }

      if (!proposedByEmail) {
        proposedByEmail = "admin@thirdumpire.ai";
        proposedByName = "FOTA Manager";
      }

      const insertResult = await db
        .insert(tuFotaDetails)
        .values({
          deviceId: device_id,
          userId: managerUserId,
          deviceOldVersion,
          deviceNewVersion,
          webOldVersion,
          webNewVersion,
          deviceStatus,
          webStatus,
          deviceFotaUrl,
          webFotaUrl,
          fotaOldVersion,
          fotaNewVersion,
          fotaUpdateUrl,
          fotaStatus,
          proposedBy: proposedByEmail,
          proposedByName: proposedByName,
        })
        .returning({
          id: tuFotaDetails.id,
        });

      if (insertResult[0]?.id) {
        // Asynchronously dispatch FOTA Initiated email notification
        db.select()
          .from(tuDevices)
          .where(eq(tuDevices.id, device_id))
          .limit(1)
          .then((deviceRows) => {
            const dev = deviceRows[0];
            return emailService.sendFotaInitiatedEmail({
              fotaId: insertResult[0].id,
              deviceId: device_id,
              deviceName: dev?.name,
              hardwareUuid: dev?.hardwareUuid,
              proposedBy: proposedByEmail,
              proposedByName: proposedByName,
              date: new Date(),
              deviceOldVersion,
              deviceNewVersion,
              webOldVersion,
              webNewVersion,
              fotaOldVersion: fotaOldVersionInput,
              fotaNewVersion: fotaNewVersionInput,
              deviceFileName,
              webFileName,
              fotaFileName,
            });
          })
          .catch((emailErr) => {
            console.error(
              "[ERROR] Failed to send FOTA initiation email:",
              emailErr,
            );
          });

        return c.json({
          message: "created successfully",
        });
      }

      return c.json({
        message: "Not created successfully",
      });
    } catch (err) {
      console.error("[ERROR] /add-fota-details failed", err);
      return c.json(
        {
          error: err instanceof Error ? err.message : "Internal server error",
        },
        500,
      );
    }
  }

  /**
   * GET /:deviceId/get-fota-details
   * Returns the most recent tu_fota_details row for a given device.
   */
  async getLatestFotaDetails(c: Context) {
    const deviceId = await resolveDeviceId(c.req.param("deviceId") || "");

    if (!deviceId) {
      return c.json({ error: "Invalid device ID" }, 400);
    }

    const latest = await db
      .select()
      .from(tuFotaDetails)
      .where(eq(tuFotaDetails.deviceId, deviceId))
      .orderBy(desc(tuFotaDetails.id))
      .limit(1);

    return c.json({
      fotaDetails: latest[0],
    });
  }

  /**
   * GET /:deviceId/download-fota/:component
   * Streams the archive file (.zip or .7z) for the device.
   */
  async downloadFotaArchive(c: Context) {
    const deviceId = await resolveDeviceId(c.req.param("deviceId") || "");
    const componentParam = c.req.param("component") || "";

    if (!deviceId) {
      return c.json({ error: "Invalid device ID" }, 400);
    }

    if (!isValidComponent(componentParam)) {
      return c.json(
        { error: "Invalid component. Must be 'device', 'web', or 'fota'." },
        400,
      );
    }

    const latest = await db
      .select()
      .from(tuFotaDetails)
      .where(eq(tuFotaDetails.deviceId, deviceId))
      .orderBy(desc(tuFotaDetails.id))
      .limit(1);

    if (latest.length === 0) {
      return c.json({ error: "No FOTA details found for this device" }, 404);
    }

    const storedFileName = getStoredFileNameForComponent(
      latest[0],
      componentParam,
    );

    if (!storedFileName) {
      return c.json(
        { error: `No ${componentParam} update file available for this device` },
        404,
      );
    }

    const resolved = resolveZipPath(componentParam, storedFileName);

    if (!resolved.ok) {
      return c.json({ error: "Invalid stored filename" }, 400);
    }

    if (!fs.existsSync(resolved.filePath)) {
      return c.json({ error: "Update file not found on server" }, 404);
    }

    const stat = fs.statSync(resolved.filePath);
    const nodeStream = fs.createReadStream(resolved.filePath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

    c.header("Content-Type", getContentTypeForFileName(resolved.fileName));
    c.header(
      "Content-Disposition",
      `attachment; filename="${resolved.fileName}"`,
    );
    c.header("Content-Length", stat.size.toString());

    return c.body(webStream);
  }

  /**
   * GET /:deviceId/fota-details-list
   * Returns all FOTA deployments history for a device.
   */
  async getFotaDetailsList(c: Context) {
    const deviceId = await resolveDeviceId(c.req.param("deviceId") || "");

    if (!deviceId) {
      return c.json({ error: "Invalid device ID" }, 400);
    }

    const list = await db
      .select()
      .from(tuFotaDetails)
      .where(eq(tuFotaDetails.deviceId, deviceId))
      .orderBy(desc(tuFotaDetails.id));

    return c.json({
      fotaDetails: list,
    });
  }

  /**
   * PATCH /:fotaId/update-fota-status
   * Status callback endpoint from device, promoting versions on success.
   */
  async updateFotaStatus(c: Context) {
    const fotaId = parseInt(c.req.param("fotaId") || "");

    if (isNaN(fotaId)) {
      return c.json({ error: "Invalid fota ID" }, 400);
    }

    let bodyJson: {
      device_success?: boolean;
      web_success?: boolean;
      fota_success?: boolean;
    };

    try {
      bodyJson = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    const { device_success, web_success, fota_success } = bodyJson;

    if (
      device_success === undefined &&
      web_success === undefined &&
      fota_success === undefined
    ) {
      return c.json(
        {
          error:
            "At least one of device_success, web_success, fota_success is required",
        },
        400,
      );
    }

    try {
      const existing = await db
        .select()
        .from(tuFotaDetails)
        .where(eq(tuFotaDetails.id, fotaId))
        .limit(1);

      if (existing?.length === 0) {
        return c.json({ error: "No FOTA record found for this fota_id" }, 404);
      }

      const record = existing[0];
      const updates: Partial<typeof tuFotaDetails.$inferInsert> = {};

      if (device_success === true) {
        updates.deviceStatus = 1;
        if (record.deviceNewVersion) {
          updates.deviceOldVersion = record.deviceNewVersion;
        }
      } else if (device_success === false) {
        updates.deviceStatus = -1;
      }

      if (web_success === true) {
        updates.webStatus = 1;
        if (record.webNewVersion) {
          updates.webOldVersion = record.webNewVersion;
        }
      } else if (web_success === false) {
        updates.webStatus = -1;
      }

      if (fota_success === true) {
        if (record.fotaNewVersion) {
          updates.fotaOldVersion = record.fotaNewVersion;
        }
      }

      const effDeviceStatus = updates.deviceStatus ?? record.deviceStatus;
      const effWebStatus = updates.webStatus ?? record.webStatus;
      const effFotaSuccess = fota_success;

      // Which components were targeted for update in this record?
      const wasDeviceTargeted =
        Boolean(record.deviceFotaUrl) ||
        (Boolean(record.deviceNewVersion) &&
          record.deviceNewVersion !== record.deviceOldVersion);

      const wasWebTargeted =
        Boolean(record.webFotaUrl) ||
        (Boolean(record.webNewVersion) &&
          record.webNewVersion !== record.webOldVersion);

      const wasFotaTargeted =
        Boolean(record.fotaUpdateUrl) ||
        (Boolean(record.fotaNewVersion) &&
          record.fotaNewVersion !== record.fotaOldVersion);

      const targetedStatuses: number[] = [];
      if (wasDeviceTargeted) targetedStatuses.push(effDeviceStatus ?? 0);
      if (wasWebTargeted) targetedStatuses.push(effWebStatus ?? 0);
      if (wasFotaTargeted) {
        targetedStatuses.push(
          effFotaSuccess === true
            ? 1
            : effFotaSuccess === false
              ? -1
              : 0,
        );
      }

      // If no component was explicitly targeted, fallback to considering device and web
      const statusesToEvaluate =
        targetedStatuses.length > 0
          ? targetedStatuses
          : [effDeviceStatus ?? 0, effWebStatus ?? 0];

      const allTargetedSuccess = statusesToEvaluate.every((s) => s === 1);
      const allTargetedFailed = statusesToEvaluate.every((s) => s === -1);
      const anyTargetedFailed = statusesToEvaluate.some((s) => s === -1);
      const anyTargetedPending = statusesToEvaluate.some((s) => s === 0);

      if (allTargetedSuccess) {
        updates.fotaStatus = "APPLIED";
      } else if (allTargetedFailed) {
        updates.fotaStatus = "FAILED";
      } else if (anyTargetedFailed) {
        updates.fotaStatus = "PARTIALLY_APPLIED";
      } else if (anyTargetedPending) {
        updates.fotaStatus = "PENDING";
      }

      updates.completedAt = new Date();

      if (
        Object.keys(updates).filter((k) => k !== "completedAt" && k !== "fotaStatus").length === 0 &&
        device_success === undefined &&
        web_success === undefined &&
        fota_success === undefined
      ) {
        return c.json({
          message: "No versions promoted — no status reported",
        });
      }

      const updated = await db
        .update(tuFotaDetails)
        .set(updates)
        .where(eq(tuFotaDetails.id, fotaId))
        .returning();

      // Sync active firmware version to tuDevices on success
      if (record.deviceId) {
        const deviceUpdates: Record<string, string> = {};
        if (device_success === true && record.deviceNewVersion) {
          deviceUpdates.firmwareVersion = record.deviceNewVersion;
          deviceUpdates.deviceVersion = record.deviceNewVersion;
        }
        if (Object.keys(deviceUpdates).length > 0) {
          try {
            await db
              .update(tuDevices)
              .set(deviceUpdates)
              .where(eq(tuDevices.id, record.deviceId));
          } catch (e) {
            console.error("[WARN] Failed to update tuDevices versions:", e);
          }
        }
      }

      // Asynchronously dispatch FOTA Completed email notification
      if (record.deviceId) {
        db.select()
          .from(tuDevices)
          .where(eq(tuDevices.id, record.deviceId))
          .limit(1)
          .then(async (deviceRows) => {
            const dev = deviceRows[0];

            let proposerEmail = record.proposedBy;
            let proposerName = record.proposedByName;

            if (record.userId) {
              const managerRows = await db
                .select({ email: users.email, name: users.name })
                .from(users)
                .where(eq(users.id, record.userId))
                .limit(1);

              if (managerRows.length > 0) {
                proposerEmail = managerRows[0].email;
                proposerName = managerRows[0].name || managerRows[0].email.split("@")[0];
              }
            }

            return emailService.sendFotaCompletedEmail({
              fotaId: record.id,
              deviceId: record.deviceId!,
              deviceName: dev?.name,
              hardwareUuid: dev?.hardwareUuid,
              proposedBy: proposerEmail,
              proposedByName: proposerName,
              startedAt: record.createdAt,
              completedAt: new Date(),
              deviceSuccess: device_success,
              webSuccess: web_success,
              fotaSuccess: fota_success,
              currentDeviceVersion:
                updated[0]?.deviceOldVersion || record.deviceNewVersion || "0.0.0",
              currentWebVersion:
                updated[0]?.webOldVersion || record.webNewVersion || "0.0.0",
              currentFotaVersion:
                updated[0]?.fotaOldVersion || record.fotaNewVersion || "0.0.0",
              status: updated[0]?.fotaStatus || "APPLIED",
            });
          })
          .catch((emailErr) => {
            console.error(
              "[ERROR] Failed to send FOTA completion email:",
              emailErr,
            );
          });
      }

      return c.json({
        message: "FOTA status updated successfully",
        fotaDetails: updated[0],
      });
    } catch (err) {
      console.error("[ERROR] /:fotaId/update-fota-status failed", err);
      return c.json(
        {
          error: err instanceof Error ? err.message : "Internal server error",
        },
        500,
      );
    }
  }
}

export const fotaController = new FotaController();
