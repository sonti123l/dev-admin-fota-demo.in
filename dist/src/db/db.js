import "dotenv/config";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
const dbPath = process.env.DATABASE_PATH || "C:/third_umpire/data/third_umpire.db";
export const sqlite = new Database(dbPath);
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS tu_fota_managers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT DEFAULT 'fota_manager',
    refresh_token TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tu_fota_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER,
    deviceOldVersion TEXT DEFAULT '',
    deviceNewVersion TEXT DEFAULT '',
    webOldVersion TEXT DEFAULT '',
    webNewVersion TEXT DEFAULT '',
    device_status INTEGER,
    web_status INTEGER,
    devicefotaurl TEXT,
    webfotaurl TEXT,
    fotaOldVersion TEXT DEFAULT '',
    fotaNewVersion TEXT DEFAULT '',
    fotaUpdateUrl TEXT DEFAULT '',
    fota_status TEXT DEFAULT '',
    created_at INTEGER,
    FOREIGN KEY (device_id) REFERENCES tu_devices(id)
  );

  CREATE TABLE IF NOT EXISTS tu_device_baseline_water_mark (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    cpu_baseline_percent REAL,
    cpu_watermark_percent REAL,
    ram_baseline_percent REAL,
    ram_watermark_percent REAL,
    temp_baseline_c REAL,
    temp_watermark_c REAL,
    disk_baseline_percent REAL,
    disk_watermark_percent REAL,
    FOREIGN KEY (device_id) REFERENCES tu_devices(id)
  );
  
  CREATE TABLE IF NOT EXISTS tu_fota_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);
// Self-healing: Ensure columns exist if table was created by external scripts
try {
    const columns = sqlite.pragma("table_info(tu_fota_managers)");
    const colNames = new Set(columns.map((c) => c.name));
    if (!colNames.has("refresh_token")) {
        sqlite.exec("ALTER TABLE tu_fota_managers ADD COLUMN refresh_token TEXT;");
    }
    if (!colNames.has("password_hash") && colNames.has("passwordHash")) {
        sqlite.exec("ALTER TABLE tu_fota_managers ADD COLUMN password_hash TEXT;");
        sqlite.exec("UPDATE tu_fota_managers SET password_hash = passwordHash WHERE password_hash IS NULL;");
    }
    if (!colNames.has("created_at")) {
        sqlite.exec("ALTER TABLE tu_fota_managers ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;");
        if (colNames.has("createdAt")) {
            sqlite.exec("UPDATE tu_fota_managers SET created_at = createdAt WHERE created_at IS NULL;");
        }
    }
    if (!colNames.has("role")) {
        sqlite.exec("ALTER TABLE tu_fota_managers ADD COLUMN role TEXT DEFAULT 'fota_manager';");
    }
    if (!colNames.has("name")) {
        sqlite.exec("ALTER TABLE tu_fota_managers ADD COLUMN name TEXT;");
    }
}
catch {
    // Ignored if table already up to date
}
// Self-healing: Ensure proposed_by, proposed_by_name, and completed_at exist in tu_fota_details
try {
    const fotaColumns = sqlite.pragma("table_info(tu_fota_details)");
    const fotaColNames = new Set(fotaColumns.map((c) => c.name));
    if (!fotaColNames.has("user_id")) {
        sqlite.exec("ALTER TABLE tu_fota_details ADD COLUMN user_id INTEGER;");
    }
    if (!fotaColNames.has("proposed_by")) {
        sqlite.exec("ALTER TABLE tu_fota_details ADD COLUMN proposed_by TEXT DEFAULT '';");
    }
    if (!fotaColNames.has("proposed_by_name")) {
        sqlite.exec("ALTER TABLE tu_fota_details ADD COLUMN proposed_by_name TEXT DEFAULT '';");
    }
    if (!fotaColNames.has("completed_at")) {
        sqlite.exec("ALTER TABLE tu_fota_details ADD COLUMN completed_at INTEGER;");
    }
}
catch {
    // Ignored if table already up to date
}
export const db = drizzle(sqlite);
