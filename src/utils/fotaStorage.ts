import fs from "fs";
import path from "path";
import { tuFotaDetails } from "../db/schema/fota_details.js";

// Root upload directory
export const UPLOAD_DIR = "/fota";

// Release directory
export const RELEASE_DIR = path.join(UPLOAD_DIR, "release");

// Device and Web directories
export const DEVICE_DIR = path.join(RELEASE_DIR, "device");
export const WEB_DIR = path.join(RELEASE_DIR, "web");

/**
 * Create a directory only if it doesn't already exist.
 */
export function createDirectoryIfNotExists(directoryPath: string) {
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
export function initializeFotaDirectories() {
  try {
    createDirectoryIfNotExists(UPLOAD_DIR);
    createDirectoryIfNotExists(RELEASE_DIR);
    createDirectoryIfNotExists(DEVICE_DIR);
    createDirectoryIfNotExists(WEB_DIR);
    console.log("[OK] FOTA directory structure initialized");
  } catch (error) {
    console.error("[ERROR] Failed to initialize FOTA directories", error);
    process.exit(1);
  }
}

export type FotaComponent = "device" | "web" | "fota";

export function isValidComponent(value: string): value is FotaComponent {
  return value === "device" || value === "web" || value === "fota";
}

export function getReleaseDir(component: FotaComponent): string {
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
 */
export function getStoredFileNameForComponent(
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
 * Resolve a safe absolute path for a component + filename.
 */
export function resolveZipPath(
  component: FotaComponent,
  fileName: string,
): { ok: true; filePath: string; fileName: string } | { ok: false } {
  const releaseDir = getReleaseDir(component);
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

export function sanitizeVersionForFilename(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]/g, "");
}

export const ALLOWED_ARCHIVE_EXTENSIONS = [".zip", ".7z"] as const;
export type ArchiveExtension = (typeof ALLOWED_ARCHIVE_EXTENSIONS)[number];

export const ARCHIVE_CONTENT_TYPES: Record<ArchiveExtension, string> = {
  ".zip": "application/zip",
  ".7z": "application/x-7z-compressed",
};

export function getArchiveExtension(fileName: string): ArchiveExtension | null {
  const lower = fileName.toLowerCase();
  return ALLOWED_ARCHIVE_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

export function getContentTypeForFileName(fileName: string): string {
  const ext = getArchiveExtension(fileName);
  return ext ? ARCHIVE_CONTENT_TYPES[ext] : ARCHIVE_CONTENT_TYPES[".zip"];
}

export async function saveUploadedZip(
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

  const cleanVersion = safeVersion.replace(/^v/i, "");
  const fileName = `${component}v${cleanVersion}${extension}`;

  const resolved = resolveZipPath(component, fileName);
  if (!resolved.ok) {
    throw new Error(`Unsafe filename rejected for ${component}: ${fileName}`);
  }

  const arrayBuffer = await file.arrayBuffer();
  await fs.promises.writeFile(resolved.filePath, Buffer.from(arrayBuffer));

  return resolved.fileName;
}
