import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db/db.js";
import { tuFotaDetails, tuDevices } from "./db/schema/fota_details.js";
import { and, ne, isNotNull } from "drizzle-orm";
import { eq, desc } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

const app = new Hono();

/*
|--------------------------------------------------------------------------
| FOTA Upload Directory Structure
|--------------------------------------------------------------------------
|
| /
| └── fota/
|     └── release/
|         ├── device/   -> *.zip/*.7z images for the device firmware track
|         └── web/      -> *.zip/*.7z images for the web (TU_web) track
|
| NOTE: tu_devices and tu_fota_details already exist in SQLite, created by
| the Python models.py DDL. This service only queries them via Drizzle's
| core query builder (drizzle(sqlite), no schema passed, no migrate()/push
| ever called here). tu_fota_details migrations are handled separately
| (baselined + tablesFilter'd to exclude tu_devices) — see earlier setup.
|
*/

// Root upload directory
const UPLOAD_DIR = "/fota";

// Release directory
const RELEASE_DIR = path.join(UPLOAD_DIR, "release");

// Device and Web directories
const DEVICE_DIR = path.join(RELEASE_DIR, "device");
const WEB_DIR = path.join(RELEASE_DIR, "web");

/**
 * Create a directory only if it doesn't already exist.
 */
function createDirectoryIfNotExists(directoryPath: string) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, {
      recursive: true,
    });

    console.log(`[OK] Created directory: ${directoryPath}`);
  } else {
    console.log(`[OK] Directory already exists: ${directoryPath}`);
  }
}

/**
 * Initialize FOTA directories.
 */
function initializeFotaDirectories() {
  try {
    createDirectoryIfNotExists(UPLOAD_DIR);
    createDirectoryIfNotExists(RELEASE_DIR);
    createDirectoryIfNotExists(DEVICE_DIR);
    createDirectoryIfNotExists(WEB_DIR);

    console.log("[OK] FOTA directory structure initialized");
  } catch (error) {
    console.error("[ERROR] Failed to initialize FOTA directories");
    console.error(error);

    // Stop the server if required directories cannot be created
    process.exit(1);
  }
}

// Initialize directories when backend starts
initializeFotaDirectories();

/*
|--------------------------------------------------------------------------
| FOTA component helpers
|--------------------------------------------------------------------------
|
| Three parallel update tracks exist on tu_fota_details: device, web, and
| the generic "fota" track. device/web share DEVICE_DIR/WEB_DIR; "fota"
| falls back to RELEASE_DIR directly — adjust if that track gets its own
| folder later.
|
*/

type FotaComponent = "device" | "web" | "fota";

function isValidComponent(value: string): value is FotaComponent {
  return value === "device" || value === "web" || value === "fota";
}

function getReleaseDir(component: FotaComponent): string {
  switch (component) {
    case "device":
      return DEVICE_DIR;
    case "web":
      return WEB_DIR;
    case "fota":
      return RELEASE_DIR;
  }
}

/**
 * Which tu_fota_details column holds the saved filename for a component.
 * NOTE: these columns used to hold external drive links. They now hold
 * just the filename saved under that component's release directory.
 */
function getStoredFileNameForComponent(
  row: typeof tuFotaDetails.$inferSelect,
  component: FotaComponent,
): string | null {
  switch (component) {
    case "device":
      return row.deviceFotaUrl || null;
    case "web":
      return row.webFotaUrl || null;
    case "fota":
      return row.fotaUpdateUrl || null;
  }
}

/**
 * Resolve a safe absolute path for a component + filename. Guards against
 * path traversal: strips any directory components from the filename, then
 * verifies the resolved path is still inside the expected release
 * directory before returning it.
 */
function resolveZipPath(
  component: FotaComponent,
  fileName: string,
): { ok: true; filePath: string; fileName: string } | { ok: false } {
  const releaseDir = getReleaseDir(component);

  // Strip any path separators the caller might have smuggled in.
  const safeFileName = path.basename(fileName);
  const filePath = path.join(releaseDir, safeFileName);

  const resolved = path.resolve(filePath);
  const resolvedDir = path.resolve(releaseDir);

  if (
    !resolved.startsWith(resolvedDir + path.sep) &&
    resolved !== resolvedDir
  ) {
    return { ok: false };
  }

  return { ok: true, filePath: resolved, fileName: safeFileName };
}

/**
 * Strip anything that isn't alphanumeric, dot, dash, or underscore from a
 * version string before it becomes part of a filename — blocks path
 * traversal ("../") and other unsafe characters.
 */
function sanitizeVersionForFilename(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]/g, "");
}

/**
 * Archive extensions this service will accept and persist. The saved
 * filename always keeps whichever of these the upload actually was —
 * we no longer force everything to .zip.
 */
const ALLOWED_ARCHIVE_EXTENSIONS = [".zip", ".7z"] as const;
type ArchiveExtension = (typeof ALLOWED_ARCHIVE_EXTENSIONS)[number];

/**
 * Map an archive extension to the MIME type we serve it back with on
 * download.
 */
const ARCHIVE_CONTENT_TYPES: Record<ArchiveExtension, string> = {
  ".zip": "application/zip",
  ".7z": "application/x-7z-compressed",
};

/**
 * Pull the archive extension off an uploaded File's original name.
 * Returns null if it isn't one of ALLOWED_ARCHIVE_EXTENSIONS.
 */
function getArchiveExtension(fileName: string): ArchiveExtension | null {
  const lower = fileName.toLowerCase();
  return ALLOWED_ARCHIVE_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

/**
 * Extension of an already-saved filename, used to pick the right
 * Content-Type on download. Falls back to .zip's MIME type if somehow
 * unrecognized, so older rows saved before .7z support still download.
 */
function getContentTypeForFileName(fileName: string): string {
  const ext = getArchiveExtension(fileName);
  return ext ? ARCHIVE_CONTENT_TYPES[ext] : ARCHIVE_CONTENT_TYPES[".zip"];
}

/**
 * Save an uploaded archive (from multipart form data) into the correct
 * component folder. Filename is always built as
 * {component}v{version}{ext} — the uploaded file's original name is
 * ignored except for its extension, so naming stays consistent regardless
 * of what the file was called locally. Extension is taken from the
 * upload itself (.zip or .7z) rather than hardcoded, so a .7z upload is
 * saved and later downloaded as .7z. Returns the filename that was
 * actually written to disk — this is what gets stored in the DB.
 */
async function saveUploadedZip(
  file: File,
  component: FotaComponent,
  version: string,
): Promise<string> {
  const safeVersion = sanitizeVersionForFilename(version);

  if (!safeVersion) {
    throw new Error(`A version is required to name the ${component} zip`);
  }

  const extension = getArchiveExtension(file.name);
  if (!extension) {
    throw new Error(
      `Unsupported file type for ${component}: expected .zip or .7z`,
    );
  }

  const fileName = `${component}v${safeVersion}${extension}`;

  const resolved = resolveZipPath(component, fileName);
  if (!resolved.ok) {
    throw new Error(`Unsafe filename rejected for ${component}: ${fileName}`);
  }

  const arrayBuffer = await file.arrayBuffer();
  await fs.promises.writeFile(resolved.filePath, Buffer.from(arrayBuffer));

  return resolved.fileName;
}

/**
 * Look up the most recent row (if any) that has a non-empty value for the
 * given "old version" column. Used to fall back to a device's / web app's
 * prior version when the caller doesn't supply one explicitly. Always
 * returns an array (possibly empty) — never throws, never returns
 * undefined, so callers don't need repeated optional-chaining gymnastics.
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

/*
|--------------------------------------------------------------------------
| Routes
|--------------------------------------------------------------------------
*/

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.use("*", cors());

/*
|--------------------------------------------------------------------------
| GET /devices-list
|--------------------------------------------------------------------------
|
| Returns every row in tu_devices. Used by the dashboard to populate the
| "select a device" dropdown — so the frontend only ever submits a
| device_id that actually exists (tu_fota_details.device_id has a FOREIGN
| KEY on tu_devices.id, so an unregistered ID would otherwise fail the
| insert in /add-fota-details with "FOREIGN KEY constraint failed").
|
*/

app.get("/devices-list", async (c) => {
  try {
    const get_all_devices = await db.select().from(tuDevices);

    return c.json({
      list: get_all_devices ?? [],
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
});

/*
|--------------------------------------------------------------------------
| POST /add-fota-details
|--------------------------------------------------------------------------
|
| Accepts multipart/form-data (not JSON) because the dashboard uploads the
| actual archive files alongside the version fields. Uploaded files are
| written to the matching component folder, keeping their original
| .zip/.7z extension; the resulting filename is stored in the DB and later
| served by /:deviceId/download-fota/:component.
|
| The whole handler body (past the initial ID parse) is wrapped in a
| try/catch so any unexpected failure — DB error, bad optional chaining,
| whatever comes next — returns a real JSON error instead of Hono's bare
| "Internal Server Error" text/plain fallback.
|
*/

app.post("/add-fota-details", async (c) => {
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
    let deviceFileName: string | null = "";
    let webFileName: string | null = "";
    let fotaFileName: string | null = "";

    try {
      if (deviceZipFile instanceof File) {
        deviceFileName = await saveUploadedZip(
          deviceZipFile,
          "device",
          deviceNewVersionInput,
        );
      }
      if (webZipFile instanceof File) {
        webFileName = await saveUploadedZip(
          webZipFile,
          "web",
          webNewVersionInput,
        );
      }
      if (fotaZipFile instanceof File) {
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
            err instanceof Error ? err.message : "Failed to save uploaded file",
        },
        400,
      );
    }

    // Independent fallbacks: device and web versions are looked up
    // separately (not else-if), so leaving BOTH blank in the same
    // request still resolves each one from its own history correctly.
    let deviceFallback: string | undefined;
    if (!deviceNewVersionInput) {
      const rows = await getLatestNonEmpty(
        tuFotaDetails.deviceOldVersion,
        device_id,
      );
      deviceFallback = rows[0]?.deviceOldVersion ?? undefined;
      deviceFileName = rows[0]?.deviceFotaUrl ?? "";
    }

    let webFallback: string | undefined;
    if (!webNewVersionInput) {
      const rows = await getLatestNonEmpty(
        tuFotaDetails.webOldVersion,
        device_id,
      );
      webFallback = rows[0]?.webOldVersion ?? undefined;
      webFileName = rows[0]?.webFotaUrl ?? "";
    }

    const deviceOldVersion = deviceOldVersionInput || deviceFallback || "0.0.0";
    const deviceNewVersion = deviceNewVersionInput || deviceFallback || "0.0.0";
    const webOldVersion = webOldVersionInput || webFallback || "0.0.0";
    const webNewVersion = webNewVersionInput || webFallback || "0.0.0";

    const insert_into_fota_details = await db
      .insert(tuFotaDetails)
      .values({
        deviceId: device_id,

        deviceOldVersion,
        deviceNewVersion,

        webOldVersion,
        webNewVersion,

        deviceStatus: deviceFileName ? 1 : 0,
        webStatus: webFileName ? 1 : 0,

        // NOTE: these now hold the saved archive's filename on disk
        // (.zip or .7z), not an external URL — resolved by
        // /:deviceId/download-fota/:component.
        deviceFotaUrl: deviceFileName,
        webFotaUrl: webFileName,

        fotaOldVersion: fotaOldVersionInput,
        fotaNewVersion: fotaNewVersionInput,

        fotaUpdateUrl: fotaFileName,

        fotaStatus: fotaFileName ? "NEWIMAGE" : "",
      })
      .returning({
        id: tuFotaDetails.id,
      });

    if (insert_into_fota_details[0]?.id) {
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
});

/*
|--------------------------------------------------------------------------
| GET /:deviceId/get-fota-details
|--------------------------------------------------------------------------
|
| Returns the most recent tu_fota_details row for a given device. This is
| step 1 of the device's two-step update flow (see the download route
| below for step 2), and is also what the dashboard calls when a device is
| selected, to pre-fill the "old version" fields with that device's last
| recorded version.
|
*/

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

  if (latest.length === 0) {
  }

  return c.json({
    fotaDetails: latest[0],
  });
});

/*
|--------------------------------------------------------------------------
| GET /:deviceId/download-fota/:component
|--------------------------------------------------------------------------
|
| Step 2 of the device's update flow:
|   1. GET /:deviceId/get-fota-details  -> read the version/status fields
|   2. GET /:deviceId/download-fota/:component -> stream the matching
|      archive (.zip or .7z, whichever was uploaded)
|
| The device never supplies a filename directly — it's read from the
| latest tu_fota_details row's stored filename, so there's no way to
| request an arbitrary file by manipulating the URL.
|
*/

app.get("/:deviceId/download-fota/:component", async (c) => {
  const deviceId = parseInt(c.req.param("deviceId"));
  const componentParam = c.req.param("component");

  if (isNaN(deviceId)) {
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
});

/*
|--------------------------------------------------------------------------
| POST /:fotaId/update-fota-status
|--------------------------------------------------------------------------
|
| Called after a device has actually attempted a FOTA update, to record
| whether it succeeded or failed — this is what keeps the dashboard's
| "old version" fields honest.
|
| On SUCCESS for a given track (device / web / fota): that track's
| old_version is promoted to equal its new_version, since the device is
| now confirmed running the new version. Whichever version the dashboard
| shows next as "old version" (via /:deviceId/get-fota-details) will
| therefore be correct.
|
| On FAILURE (or if a track's flag is simply omitted): nothing is
| changed for that track — old_version stays exactly as it was, since the
| device never actually moved to new_version. This is intentional, not a
| bug: we only ever promote versions we've confirmed were applied.
|
| Body (JSON), all fields optional — only send the tracks that were
| actually attempted:
|   {
|     "device_success": true | false,
|     "web_success": true | false,
|     "fota_success": true | false
|   }
|
| Takes the fota_id (the specific tu_fota_details row, NOT the device_id)
| as a route param so it updates that exact record rather than always
| touching "whatever the latest row is" — the caller should pass back
| whichever fota_id was associated with the update it just attempted.
|
*/

app.patch("/:fotaId/update-fota-status", async (c) => {
  const fotaId = parseInt(c.req.param("fotaId"));

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
  } catch (err) {
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

    // Only build fields for tracks that were explicitly reported AND
    // succeeded. Anything false/undefined is left completely untouched —
    // "if not then old version will not be [the] newer version".
    const updates: Partial<typeof tuFotaDetails.$inferInsert> = {};

    if (device_success === true) {
      updates.deviceOldVersion = record.deviceNewVersion;
    }

    if (web_success === true) {
      updates.webOldVersion = record.webNewVersion;
    }

    if (fota_success === true) {
      updates.fotaOldVersion = record.fotaNewVersion;
      // fotaStatus is a free-text field (originally "NEWIMAGE" when an
      // image was uploaded) — mark it applied now that it's confirmed.
      updates.fotaStatus = "APPLIED";
    }

    if (Object.keys(updates).length === 0) {
      // Every reported track was false — nothing to promote, but this
      // isn't an error; the caller correctly told us the update failed.
      return c.json({
        message: "No versions promoted — no successful tracks reported",
      });
    }

    const updated = await db
      .update(tuFotaDetails)
      .set(updates)
      .where(eq(tuFotaDetails.id, fotaId))
      .returning();

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
});

/*
|--------------------------------------------------------------------------
| Global error handler
|--------------------------------------------------------------------------
|
| Safety net for any route/middleware that throws without its own
| try/catch. Without this, Hono's default handler sends a bare
| text/plain "Internal Server Error" with no detail, which is what made
| earlier bugs hard to diagnose from the Network tab.
|
*/

app.onError((err, c) => {
  console.error("[ERROR] Unhandled exception", err);
  return c.json(
    { error: err instanceof Error ? err.message : "Internal server error" },
    500,
  );
});

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
    console.log(`FOTA upload directory: ${UPLOAD_DIR}`);
    console.log(`Device releases: ${DEVICE_DIR}`);
    console.log(`Web releases: ${WEB_DIR}`);
  },
);
