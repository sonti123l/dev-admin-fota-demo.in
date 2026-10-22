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

      // Also query the latest historical records that have active packages for each component
      const latestWithDeviceFileRows = await db
        .select()
        .from(tuFotaDetails)
        .where(
          and(
            eq(tuFotaDetails.deviceId, device_id),
            isNotNull(tuFotaDetails.deviceFotaUrl),
            ne(tuFotaDetails.deviceFotaUrl, ""),
          ),
        )
        .orderBy(desc(tuFotaDetails.id))
        .limit(1);
      const latestWithDeviceFile = latestWithDeviceFileRows[0] ?? null;

      const latestWithWebFileRows = await db
        .select()
        .from(tuFotaDetails)
        .where(
          and(
            eq(tuFotaDetails.deviceId, device_id),
            isNotNull(tuFotaDetails.webFotaUrl),
            ne(tuFotaDetails.webFotaUrl, ""),
          ),
        )
        .orderBy(desc(tuFotaDetails.id))
        .limit(1);
      const latestWithWebFile = latestWithWebFileRows[0] ?? null;

      const latestWithFotaFileRows = await db
        .select()
        .from(tuFotaDetails)
        .where(
          and(
            eq(tuFotaDetails.deviceId, device_id),
            isNotNull(tuFotaDetails.fotaUpdateUrl),
            ne(tuFotaDetails.fotaUpdateUrl, ""),
          ),
        )
        .orderBy(desc(tuFotaDetails.id))
        .limit(1);
      const latestWithFotaFile = latestWithFotaFileRows[0] ?? null;

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
        latestWithDeviceFile?.deviceNewVersion ||
        latestFota?.deviceOldVersion ||
        currentDev?.firmwareVersion ||
        currentDev?.deviceVersion ||
        "0.0.0"
      ).trim();

      const currentWebVersion = (
        webOldVersionInput.trim() ||
        (latestFota?.webStatus === 1 ? latestFota.webNewVersion : null) ||
        latestWithWebFile?.webNewVersion ||
        latestFota?.webOldVersion ||
        (currentDev as any)?.web_version ||
        "0.0.0"
      ).trim();

      const currentFotaVersion = (
        fotaOldVersionInput.trim() ||
        (latestFota?.fotaStatus === "APPLIED" ? latestFota.fotaNewVersion : null) ||
        latestWithFotaFile?.fotaNewVersion ||
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
      // 3. PERSISTENCE & FORWARDING: If a track is NOT being updated in this deployment,
      //    carry forward the previous update's package URL and version so that if a device
      //    was offline/off for weeks/months, it still receives the previous track's update
      //    along with this new update!

      let deviceOldVersion = currentDeviceVersion;
      let deviceNewVersion = currentDeviceVersion;
      let deviceStatus = 1;
      let deviceFotaUrl = "";

      if (isDeviceUpdating) {
        deviceNewVersion = deviceNewVersionInput.trim();
        deviceStatus = 0; // Pending
        deviceFotaUrl = deviceFileName || "";
      } else if (latestWithDeviceFile) {
        // Carry forward previous device update package & version
        deviceOldVersion =
          latestWithDeviceFile.deviceOldVersion || currentDeviceVersion;
        deviceNewVersion =
          latestWithDeviceFile.deviceNewVersion || currentDeviceVersion;
        deviceFotaUrl = latestWithDeviceFile.deviceFotaUrl || "";
        deviceStatus = 1; // Not being updated in this deployment -> success by default
      }

      let webOldVersion = currentWebVersion;
      let webNewVersion = currentWebVersion;
      let webStatus = 1;
      let webFotaUrl = "";

      if (isWebUpdating) {
        webNewVersion = webNewVersionInput.trim();
        webStatus = 0; // Pending
        webFotaUrl = webFileName || "";
      } else if (latestWithWebFile) {
        // Carry forward previous web update package & version
        webOldVersion =
          latestWithWebFile.webOldVersion || currentWebVersion;
        webNewVersion =
          latestWithWebFile.webNewVersion || currentWebVersion;
        webFotaUrl = latestWithWebFile.webFotaUrl || "";
        webStatus = 1; // Not being updated in this deployment -> success by default
      }

      let fotaOldVersion = currentFotaVersion;
      let fotaNewVersion = currentFotaVersion;
      let fotaUpdateUrl = "";

      if (isFotaUpdating) {
        fotaNewVersion = fotaNewVersionInput.trim();
        fotaUpdateUrl = fotaFileName || "";
      } else if (latestWithFotaFile) {
        // Carry forward previous fota update package & version
        fotaOldVersion =
          latestWithFotaFile.fotaOldVersion || currentFotaVersion;
        fotaNewVersion =
          latestWithFotaFile.fotaNewVersion || currentFotaVersion;
        fotaUpdateUrl = latestWithFotaFile.fotaUpdateUrl || "";
      }

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
   * Returns the most recent tu_fota_details row for a given device,
   * carrying forward any active package URLs that were updated in earlier records.
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

    if (latest.length === 0) {
      return c.json({ fotaDetails: null });
    }

    const fotaDetails = { ...latest[0] };

    // If device package URL is missing in latest record, fallback to the latest record that had one
    if (!fotaDetails.deviceFotaUrl) {
      const prevDevice = await db
        .select({
          deviceFotaUrl: tuFotaDetails.deviceFotaUrl,
          deviceNewVersion: tuFotaDetails.deviceNewVersion,
          deviceOldVersion: tuFotaDetails.deviceOldVersion,
        })
        .from(tuFotaDetails)
        .where(
          and(
            eq(tuFotaDetails.deviceId, deviceId),
            isNotNull(tuFotaDetails.deviceFotaUrl),
            ne(tuFotaDetails.deviceFotaUrl, ""),
          ),
        )
        .orderBy(desc(tuFotaDetails.id))
        .limit(1);

      if (prevDevice.length > 0 && prevDevice[0].deviceFotaUrl) {
        fotaDetails.deviceFotaUrl = prevDevice[0].deviceFotaUrl;
        if (
          !fotaDetails.deviceNewVersion ||
          fotaDetails.deviceNewVersion === fotaDetails.deviceOldVersion
        ) {
          fotaDetails.deviceNewVersion = prevDevice[0].deviceNewVersion;
        }
      }
    }

    // If web package URL is missing in latest record, fallback to the latest record that had one
    if (!fotaDetails.webFotaUrl) {
      const prevWeb = await db
        .select({
          webFotaUrl: tuFotaDetails.webFotaUrl,
          webNewVersion: tuFotaDetails.webNewVersion,
          webOldVersion: tuFotaDetails.webOldVersion,
        })
        .from(tuFotaDetails)
        .where(
          and(
            eq(tuFotaDetails.deviceId, deviceId),
            isNotNull(tuFotaDetails.webFotaUrl),
            ne(tuFotaDetails.webFotaUrl, ""),
          ),
        )
        .orderBy(desc(tuFotaDetails.id))
        .limit(1);

      if (prevWeb.length > 0 && prevWeb[0].webFotaUrl) {
        fotaDetails.webFotaUrl = prevWeb[0].webFotaUrl;
        if (
          !fotaDetails.webNewVersion ||
          fotaDetails.webNewVersion === fotaDetails.webOldVersion
        ) {
          fotaDetails.webNewVersion = prevWeb[0].webNewVersion;
        }
      }
    }

    // If fota updater URL is missing in latest record, fallback to the latest record that had one
    if (!fotaDetails.fotaUpdateUrl) {
      const prevFota = await db
        .select({
          fotaUpdateUrl: tuFotaDetails.fotaUpdateUrl,
          fotaNewVersion: tuFotaDetails.fotaNewVersion,
          fotaOldVersion: tuFotaDetails.fotaOldVersion,
        })
        .from(tuFotaDetails)
        .where(
          and(
            eq(tuFotaDetails.deviceId, deviceId),
            isNotNull(tuFotaDetails.fotaUpdateUrl),
            ne(tuFotaDetails.fotaUpdateUrl, ""),
          ),
        )
        .orderBy(desc(tuFotaDetails.id))
        .limit(1);

      if (prevFota.length > 0 && prevFota[0].fotaUpdateUrl) {
        fotaDetails.fotaUpdateUrl = prevFota[0].fotaUpdateUrl;
        if (
          !fotaDetails.fotaNewVersion ||
          fotaDetails.fotaNewVersion === fotaDetails.fotaOldVersion
        ) {
          fotaDetails.fotaNewVersion = prevFota[0].fotaNewVersion;
        }
      }
    }

    return c.json({
      fotaDetails,
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

    let storedFileName = getStoredFileNameForComponent(
      latest[0],
      componentParam,
    );

    // If latest record doesn't have the file for this component, find the latest record that DOES
    if (!storedFileName) {
      const fallbackRecord = await db
        .select()
        .from(tuFotaDetails)
        .where(
          and(
            eq(tuFotaDetails.deviceId, deviceId),
            componentParam === "device"
              ? and(
                  isNotNull(tuFotaDetails.deviceFotaUrl),
                  ne(tuFotaDetails.deviceFotaUrl, ""),
                )
              : componentParam === "web"
                ? and(
                    isNotNull(tuFotaDetails.webFotaUrl),
                    ne(tuFotaDetails.webFotaUrl, ""),
                  )
                : and(
                    isNotNull(tuFotaDetails.fotaUpdateUrl),
                    ne(tuFotaDetails.fotaUpdateUrl, ""),
                  ),
          ),
        )
        .orderBy(desc(tuFotaDetails.id))
        .limit(1);

      if (fallbackRecord.length > 0) {
        storedFileName = getStoredFileNameForComponent(
          fallbackRecord[0],
          componentParam,
        );
      }
    }

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
    const idParam = (c.req.param("fotaId") || c.req.param("deviceId") || "").trim();
    let targetId = parseInt(idParam);

    if (isNaN(targetId)) {
      return c.json({ error: "Invalid ID in route parameter" }, 400);
    }

    let bodyJson: Record<string, any>;

    try {
      bodyJson = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    // Robust parsing: accept device_success, device_status (1: success, 0: pending, -1: failed)
    const parseSuccess = (
      valSuccess: any,
      valStatus: any,
    ): number | undefined => {
      const val = valSuccess !== undefined ? valSuccess : valStatus;
      if (val === undefined || val === null || val === "") return undefined;

      if (val === 1 || val === "1" || val === true || val === "true") return 1;
      if (val === -1 || val === "-1" || val === false || val === "false") return -1;
      if (val === 0 || val === "0") return 0;

      const str = String(val).toUpperCase().trim();
      if (str === "SUCCESS" || str === "APPLIED") return 1;
      if (str === "FAILED") return -1;
      if (str === "PENDING") return 0;

      return undefined;
    };

    const device_success = parseSuccess(
      bodyJson["device_success"],
      bodyJson["device_status"],
    );
    const web_success = parseSuccess(
      bodyJson["web_success"],
      bodyJson["web_status"],
    );
    const fota_success = parseSuccess(
      bodyJson["fota_success"],
      bodyJson["fota_status"],
    );

    if (
      device_success === undefined &&
      web_success === undefined &&
      fota_success === undefined
    ) {
      return c.json(
        {
          error:
            "At least one of device_success/device_status, web_success/web_status, fota_success/fota_status is required",
        },
        400,
      );
    }

    try {
      let existing = await db
        .select()
        .from(tuFotaDetails)
        .where(eq(tuFotaDetails.id, targetId))
        .limit(1);

      if (existing?.length === 0) {
        // Fallback: Check if targetId was passed as a deviceId
        const byDeviceId = await db
          .select()
          .from(tuFotaDetails)
          .where(eq(tuFotaDetails.deviceId, targetId))
          .orderBy(desc(tuFotaDetails.id))
          .limit(1);

        if (byDeviceId?.length > 0) {
          existing = byDeviceId;
        } else {
          return c.json({ error: `No FOTA record found for ID: ${targetId}` }, 404);
        }
      }

      const record = existing[0];
      const fotaId = record.id;
      const updates: Partial<typeof tuFotaDetails.$inferInsert> = {};

      if (device_success === 1) {
        updates.deviceStatus = 1;
        if (record.deviceNewVersion) {
          updates.deviceOldVersion = record.deviceNewVersion;
        }
      } else if (device_success === -1) {
        updates.deviceStatus = -1;
      } else if (device_success === 0) {
        updates.deviceStatus = 0;
      }

      if (web_success === 1) {
        updates.webStatus = 1;
        if (record.webNewVersion) {
          updates.webOldVersion = record.webNewVersion;
        }
      } else if (web_success === -1) {
        updates.webStatus = -1;
      } else if (web_success === 0) {
        updates.webStatus = 0;
      }

      if (fota_success === 1) {
        if (record.fotaNewVersion) {
          updates.fotaOldVersion = record.fotaNewVersion;
        }
      }

      // Which components were targeted for update in this record?
      const wasDeviceTargeted =
        record.deviceStatus === 0 ||
        (Boolean(record.deviceNewVersion) &&
          record.deviceNewVersion !== record.deviceOldVersion);

      const wasWebTargeted =
        record.webStatus === 0 ||
        (Boolean(record.webNewVersion) &&
          record.webNewVersion !== record.webOldVersion);

      const wasFotaTargeted =
        Boolean(record.fotaUpdateUrl) ||
        (Boolean(record.fotaNewVersion) &&
          record.fotaNewVersion !== record.fotaOldVersion);

      // Fallback: If fota_success was explicitly reported as failure (-1), ensure targeted pending tracks are also marked failed
      if (fota_success === -1) {
        if (wasDeviceTargeted && updates.deviceStatus === undefined && record.deviceStatus === 0) {
          updates.deviceStatus = -1;
        }
        if (wasWebTargeted && updates.webStatus === undefined && record.webStatus === 0) {
          updates.webStatus = -1;
        }
      }

      const effDeviceStatus = updates.deviceStatus ?? record.deviceStatus;
      const effWebStatus = updates.webStatus ?? record.webStatus;
      const effFotaSuccess = fota_success;

      const targetedStatuses: number[] = [];
      if (wasDeviceTargeted) targetedStatuses.push(effDeviceStatus ?? 0);
      if (wasWebTargeted) targetedStatuses.push(effWebStatus ?? 0);
      if (wasFotaTargeted) {
        targetedStatuses.push(
          effFotaSuccess === 1
            ? 1
            : effFotaSuccess === -1
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
      const anyTargetedSuccess = statusesToEvaluate.some((s) => s === 1);
      const anyTargetedFailed = statusesToEvaluate.some((s) => s === -1);
      const anyTargetedPending = statusesToEvaluate.some((s) => s === 0);

      if (allTargetedSuccess) {
        updates.fotaStatus = "APPLIED";
      } else if (allTargetedFailed) {
        updates.fotaStatus = "FAILED";
      } else if (anyTargetedSuccess && anyTargetedFailed) {
        updates.fotaStatus = "PARTIALLY_APPLIED";
      } else if (anyTargetedFailed && (fota_success === -1 || !anyTargetedPending)) {
        updates.fotaStatus = "FAILED";
      } else if (anyTargetedPending) {
        updates.fotaStatus = "PENDING";
      } else {
        updates.fotaStatus = anyTargetedFailed ? "FAILED" : "APPLIED";
      }

      if (updates.fotaStatus !== "PENDING") {
        updates.completedAt = new Date();
      }

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
        if (device_success === 1 && record.deviceNewVersion) {
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
