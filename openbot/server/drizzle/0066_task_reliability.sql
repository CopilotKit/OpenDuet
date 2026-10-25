ALTER TABLE "channels" ADD COLUMN "last_message_needs_input" boolean;
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "first_day_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "busy_claims" jsonb NOT NULL DEFAULT '{}'::jsonb;
