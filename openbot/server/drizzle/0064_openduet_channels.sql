CREATE TABLE "openduet_channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"icon" text NOT NULL,
	"colour" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openduet_channels_icon_check" CHECK ("openduet_channels"."icon" IN ('check', 'calendar', 'mail', 'dollar', 'chart', 'globe', 'pin', 'home', 'cube', 'video', 'folder', 'pencil', 'search', 'heart', 'people', 'briefcase', 'book', 'plane', 'car', 'food', 'bag', 'gift', 'sprout', 'music')),
	CONSTRAINT "openduet_channels_colour_check" CHECK ("openduet_channels"."colour" IN ('berry', 'blush', 'peach', 'amber', 'sage', 'green', 'sky', 'blue', 'lavender'))
);
--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD COLUMN "from_channel_id" text;--> statement-breakpoint
ALTER TABLE "openduet_tasks" ADD COLUMN "from_channel_id" text;--> statement-breakpoint
ALTER TABLE "openduet_channels" ADD CONSTRAINT "openduet_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_from_channel_id_channels_id_fk" FOREIGN KEY ("from_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openduet_tasks" ADD CONSTRAINT "openduet_tasks_from_channel_id_channels_id_fk" FOREIGN KEY ("from_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;