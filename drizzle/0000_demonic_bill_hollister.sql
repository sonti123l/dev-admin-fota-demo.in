CREATE TABLE `tu_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`hardware_uuid` text NOT NULL,
	`name` text,
	`site_id` integer,
	`status` text DEFAULT 'pending',
	`firmware_version` text,
	`device_version` text,
	`last_heartbeat` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tu_devices_hardware_uuid_unique` ON `tu_devices` (`hardware_uuid`);--> statement-breakpoint
CREATE TABLE `tu_fota_details` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` integer,
	`deviceOldVersion` text DEFAULT '',
	`deviceNewVersion` text DEFAULT '',
	`webOldVersion` text DEFAULT '',
	`webNewVersion` text DEFAULT '',
	`device_status` integer,
	`web_status` integer,
	`devicefotaurl` text,
	`webfotaurl` text,
	`fotaOldVersion` text DEFAULT '',
	`fotaNewVersion` text DEFAULT '',
	`fotaUpdateUrl` text DEFAULT '',
	`fota_status` text DEFAULT '',
	`created_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `tu_devices`(`id`) ON UPDATE no action ON DELETE no action
);
