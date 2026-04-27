DROP INDEX IF EXISTS "session_devices_session_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_devices_session_device_unique_idx" ON "session_devices" USING btree ("session_id","device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_devices_session_idx" ON "session_devices" USING btree ("session_id");