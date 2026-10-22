import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { PageContent, PageKind } from "../../openduet/page-content";
import { agents, users } from "./core";
import { jsonb } from "./json";

/**
 * What OpenDuet made for a person when they asked for something to read, present or keep: prep
 * notes, a plan, a dashboard, a deck. Written by the `make_page` tool (openduet/pages.ts), read back
 * by the Pages tab and the viewer, and only ever by the person it was made for.
 *
 * `channel_id` is where it was asked for, when that is known. The tool runs without the conversation
 * in hand today, so it is null until a caller can say.
 */
export const openduetPages = pgTable(
  "openduet_pages",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id"),
    kind: text("kind").$type<PageKind>().notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    content: jsonb("content").$type<PageContent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("openduet_pages_owner_updated_idx").on(
      table.ownerUserId,
      table.updatedAt,
    ),
    check(
      "openduet_pages_kind_check",
      sql`${table.kind} IN ('page', 'slides')`,
    ),
  ],
);
