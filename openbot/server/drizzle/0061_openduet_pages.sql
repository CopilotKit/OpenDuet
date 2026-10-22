CREATE TABLE "openduet_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"channel_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_pages_kind_check" CHECK ("openduet_pages"."kind" IN ('page', 'slides'))
);
--> statement-breakpoint
ALTER TABLE "openduet_pages" ADD CONSTRAINT "openduet_pages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_pages" ADD CONSTRAINT "openduet_pages_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openduet_pages_owner_updated_idx" ON "openduet_pages" USING btree ("owner_user_id","updated_at");