ALTER TABLE "sessions" ADD COLUMN "url_token" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_client_notification_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_csm_notification_at" timestamp with time zone;