import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PageContent, PageKind } from "../../openduet/page-content";
import { agents, channels, users } from "./core";
import { jsonb } from "./json";
import { proactiveSuggestions } from "./proactive";

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

/** How a task began: asked for in Chat, started from a suggestion, or started from a check-in's card. */
export type OpenDuetTaskOrigin = "asked" | "suggestion" | "check_in";

/**
 * Work OpenDuet does for a person in the background, each in a conversation of its own, so Chat stays
 * one thread. Written when `start_task` hands something off from Chat, or when the person starts a
 * suggestion (openduet/task-store.ts); read by Chat's task cards, the task page and Tasks.
 *
 * NO STATUS COLUMN. Whether a task is working, waiting on the person or ready to read is worked out
 * on every read from the ledgers that already say so: the work queue, the approval inbox and the
 * questions a Bot asked. A copy here would drift from them the first time one changed without it.
 * Only the person's own "done" is stored, as `resolved_at`.
 *
 * `channel_id` is the task's own conversation, made with it, one task per conversation.
 */
export const openduetTasks = pgTable(
  "openduet_tasks",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    why: text("why"),
    origin: text("origin").$type<OpenDuetTaskOrigin>().notNull(),
    suggestionId: text("suggestion_id").references(
      () => proactiveSuggestions.id,
      { onDelete: "set null" },
    ),
    sourceApp: text("source_app"),
    sourceLink: text("source_link"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("openduet_tasks_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
    ),
    uniqueIndex("openduet_tasks_channel_idx").on(table.channelId),
    // A suggestion is started once, so it opens one task. Postgres keeps any number of nulls apart.
    uniqueIndex("openduet_tasks_suggestion_idx").on(table.suggestionId),
    check(
      "openduet_tasks_origin_check",
      sql`${table.origin} IN ('asked', 'suggestion', 'check_in')`,
    ),
  ],
);
