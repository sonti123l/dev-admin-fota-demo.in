CREATE TABLE "tu_devices" (
	"id" integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tu_fota_details" (
	"id" serial PRIMARY KEY NOT NULL,
	"device_id" integer,
	"device_old_version" text,
	"device_new_version" text,
	"web_old_version" text,
	"web_new_version" text,
	"status" text,
	"device_fota_url" text,
	"web_fota_url" text
);
--> statement-breakpoint
ALTER TABLE "tu_fota_details" ADD CONSTRAINT "tu_fota_details_device_id_tu_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."tu_devices"("id") ON DELETE no action ON UPDATE no action;