import {
  CHANNEL_COLOURS,
  CHANNEL_ICONS,
  type ChannelColour,
  type ChannelIcon,
} from "@openbot/shared/channel-look";
import type { PageTheme } from "@openbot/shared/page-look";
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
/** Private storage metadata, never accepted in make_page or exposed inside public content. */
export type StoredPageContent = PageContent & { _checklistRevision?: string };

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
    thumbnail: text("thumbnail"),
    theme: text("theme").$type<PageTheme>().notNull().default("classic"),
    content: jsonb("content").$type<StoredPageContent>().notNull(),
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
      "openduet_pages_theme_check",
      sql`${table.theme} IN ('classic', 'studio', 'earth', 'ocean', 'editorial')`,
    ),
    check(
      "openduet_pages_kind_check",
      sql`${table.kind} IN ('page', 'slides', 'dashboard', 'doc', 'design', 'design-system')`,
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
 * `from_channel_id` is the channel it was asked for in, when a channel asked for it: null means
 * Everything, the person's one thread. A channel deleted later leaves the task, untagged.
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
    fromChannelId: text("from_channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    why: text("why"),
    thumbnail: text("thumbnail"),
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

/** The SQL list a check constraint keeps a column to, from one of the shared sets. */
const oneOf = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

/**
 * How one of the person's channels looks, and whether they put it away. A channel is an OpenBot
 * conversation between the person and the Bot that is neither the direct one, which is Everything,
 * nor a task's (openduet/channels.ts). Its name and its purpose stay where OpenBot keeps them,
 * `channels.name` and `channels.description`; this holds only what OpenBot has no column for.
 *
 * A conversation with no row here is still a channel, drawn with the default look: a generic icon
 * and a colour picked stably from its id (`channelLook` in shared/channel-look.ts). The row is
 * written when the person makes the channel, dresses one, opens one from the drawer, or archives
 * one, so there is nothing to backfill.
 *
 * `archived_at` lives here, not on `channel_memberships` beside `pinned_at`, deliberately. An
 * OpenDuet channel has one person in it, so a per-member fact and a per-channel one are the same
 * fact, and keeping it here leaves OpenBot's core tables untouched.
 */
export const openduetChannels = pgTable(
  "openduet_channels",
  {
    channelId: text("channel_id")
      .primaryKey()
      .references(() => channels.id, { onDelete: "cascade" }),
    icon: text("icon").$type<ChannelIcon>().notNull(),
    colour: text("colour").$type<ChannelColour>().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "openduet_channels_icon_check",
      sql`${table.icon} IN (${oneOf(CHANNEL_ICONS)})`,
    ),
    check(
      "openduet_channels_colour_check",
      sql`${table.colour} IN (${oneOf(CHANNEL_COLOURS)})`,
    ),
  ],
);
