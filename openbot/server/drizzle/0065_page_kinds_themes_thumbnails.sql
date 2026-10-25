ALTER TABLE "openduet_pages" ADD COLUMN "thumbnail" text;
--> statement-breakpoint
ALTER TABLE "openduet_pages" ADD COLUMN "theme" text DEFAULT 'classic' NOT NULL;
--> statement-breakpoint
ALTER TABLE "openduet_tasks" ADD COLUMN "thumbnail" text;
--> statement-breakpoint
ALTER TABLE "openduet_pages" DROP CONSTRAINT "openduet_pages_kind_check";
--> statement-breakpoint
ALTER TABLE "openduet_pages" ADD CONSTRAINT "openduet_pages_kind_check" CHECK ("openduet_pages"."kind" IN ('page', 'slides', 'dashboard', 'doc', 'design', 'design-system'));
--> statement-breakpoint
ALTER TABLE "openduet_pages" ADD CONSTRAINT "openduet_pages_theme_check" CHECK ("openduet_pages"."theme" IN ('classic', 'studio', 'earth', 'ocean', 'editorial'));
