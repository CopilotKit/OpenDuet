import {
  type ChannelHello,
  frameChannelHello,
} from "@openbot/shared/channel-hello";
import {
  CHANNEL_COLOURS,
  CHANNEL_ICONS,
  type ChannelColour,
  type ChannelIcon,
  channelLook,
  MAX_CHANNEL_NAME,
  MAX_CHANNEL_PURPOSE,
} from "@openbot/shared/channel-look";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AgentNotFoundError } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import { PERSON_INITIATOR } from "../audit";
import type { AppVariables } from "../auth/guards";
import {
  type AgentChannel,
  type ChannelStore,
  PRIVATE_AGENT_CHANNEL_DESCRIPTION,
} from "../channels/routes";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema";
import { openduetChannels, openduetTasks } from "../db/schema/openduet";

/*
 * The person's channels: named workstreams, each a conversation with the Bot, with a look (an icon
 * on a disc in its colour) and one line of purpose. The drawer lists them under Everything, which is
 * Chat, the one thread.
 *
 * WHAT A CHANNEL IS. An OpenBot conversation of the person's that is neither the direct one with the
 * Bot, which is Everything, nor a task's own (`openduet_tasks.channel_id`). So every conversation the
 * person already has shows up as a channel, with the default look until somebody dresses it, and
 * there is no third kind to keep apart: "Earlier conversations" went away for that reason.
 *
 * WHERE EACH PART LIVES. The name and the purpose are OpenBot's own columns, `channels.name` and
 * `channels.description`. The look and the archived state are OpenDuet's (`openduet_channels`), so
 * OpenBot's tables gain nothing. A conversation with a row there is "dressed": made as a channel,
 * edited, opened from the drawer, or archived. A dressed conversation is never Everything, here, in
 * the channel store's `direct` and in the app's `ongoingChannel`, which all apply that one rule.
 */

export type ChannelRecord = {
  id: string;
  name: string;
  /** The purpose line, or null for a conversation nobody gave one. */
  purpose: string | null;
  icon: ChannelIcon;
  colour: ChannelColour;
  /** Whether it has a look of its own; one that does is never Everything. */
  dressed: boolean;
  archivedAt: string | null;
  agentIds: string[];
  lastMessageAt: string | null;
  createdAt: string;
  /**
   * What the conversation is called while it has no look of its own: its summary, and the last
   * thing said in it, for "Earlier conversations" under Archived. Its thread, so the app can read
   * what the person first asked in it.
   */
  summary: string | null;
  lastMessage: string | null;
  threadId: string;
};

export type ChannelList = {
  /** Everything's conversation, the person's one thread with the Bot, or null before it exists. */
  everythingId: string | null;
  /** Every channel, newest activity first, archived ones included and marked. */
  channels: ChannelRecord[];
};

export type NewChannel = {
  botId: string;
  name: string;
  purpose: string;
  icon: ChannelIcon;
  colour: ChannelColour;
};

export type ChannelPatch = Partial<Omit<NewChannel, "botId">>;

/** What the Bot is told about the conversation a run is in, when it is a dressed channel. */
export type RunChannel = {
  channelId: string;
  name: string;
  purpose: string | null;
};

export class ChannelRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelRefusedError";
  }
}

export class DuetChannelNotFoundError extends Error {
  constructor() {
    super("Couldn't find that channel.");
    this.name = "DuetChannelNotFoundError";
  }
}

/** How many channels the drawer lists. A page is what a drawer shows. */
const LIST_LIMIT = 200;

/** The purpose OpenBot writes on a conversation it made itself is not one the person gave. */
function purposeOf(description: string): string | null {
  const said = description.trim();
  return said && said !== PRIVATE_AGENT_CHANNEL_DESCRIPTION ? said : null;
}

const RECENCY = sql`coalesce(${channels.lastMessageAt}, ${channels.createdAt})`;
const AGENTS_OF_CHANNEL = sql<
  string[]
>`coalesce((select array_agg(${channelAgents.agentId} order by ${channelAgents.agentId}) from ${channelAgents} where ${channelAgents.channelId} = ${channels.id}), '{}')`;
const NOT_A_TASK = sql`not exists (select 1 from ${openduetTasks} where ${openduetTasks.channelId} = ${channels.id})`;

/** Starts the hello turn in a new channel. The server's assembly provides it; see `createChannelHello`. */
export type ChannelHelloStarter = (input: {
  ownerUserId: string;
  agentId: string;
  channel: AgentChannel;
  hello: ChannelHello;
}) => Promise<void>;

export type DuetChannelStore = ReturnType<typeof createDuetChannelStore>;

/** Every read and write is the person's own: another person's channel is the same as none. */
export function createDuetChannelStore(deps: {
  database: Database;
  channels: Pick<ChannelStore, "create">;
  /** Absent, a new channel opens silent. */
  hello?: ChannelHelloStarter;
  now?: () => Date;
}) {
  const { database } = deps;
  const now = deps.now ?? (() => new Date());
  /** Hellos still running, so a test or a shutdown can wait for them. */
  const greeting = new Set<Promise<unknown>>();

  /** The person's reachable, undeleted conversations that are not a task's, newest first. */
  async function rows(ownerUserId: string, channelId?: string) {
    return database
      .select({
        id: channels.id,
        name: channels.name,
        description: channels.description,
        lastMessageAt: channels.lastMessageAt,
        createdAt: channels.createdAt,
        summary: channels.summary,
        lastMessage: channels.lastMessage,
        threadId: intelligenceChannelMappings.threadId,
        icon: openduetChannels.icon,
        colour: openduetChannels.colour,
        archivedAt: openduetChannels.archivedAt,
        dressed: sql<boolean>`${openduetChannels.channelId} is not null`,
        agentIds: AGENTS_OF_CHANNEL,
      })
      .from(channels)
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, ownerUserId),
        ),
      )
      .innerJoin(
        intelligenceChannelMappings,
        and(
          eq(intelligenceChannelMappings.channelId, channels.id),
          eq(intelligenceChannelMappings.userId, ownerUserId),
        ),
      )
      .leftJoin(openduetChannels, eq(openduetChannels.channelId, channels.id))
      .where(
        and(
          isNull(channels.deletedAt),
          NOT_A_TASK,
          channelId ? eq(channels.id, channelId) : undefined,
        ),
      )
      .orderBy(sql`${RECENCY} desc`, desc(channels.id))
      .limit(channelId ? 1 : LIST_LIMIT);
  }

  type Row = Awaited<ReturnType<typeof rows>>[number];

  function recordOf(row: Row): ChannelRecord {
    const look = channelLook(
      row.id,
      row.icon && row.colour ? { icon: row.icon, colour: row.colour } : null,
    );
    return {
      id: row.id,
      name: row.name,
      purpose: purposeOf(row.description),
      icon: look.icon,
      colour: look.colour,
      dressed: row.dressed,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      agentIds: row.agentIds,
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      summary: row.summary,
      lastMessage: row.lastMessage,
      threadId: row.threadId,
    };
  }

  /**
   * Everything's conversation among these rows: the newest undressed one with this Bot alone. The
   * same rule as Chat's `ongoingChannel` and the channel store's `direct`, so the drawer never lists
   * the thread Chat is showing.
   */
  function everythingOf(list: readonly Row[], botId: string) {
    return list.find(
      (row) =>
        !row.dressed && row.agentIds.length === 1 && row.agentIds[0] === botId,
    );
  }

  /** The person's channel by id, refusing Everything and anything that is not theirs. */
  async function channelToChange(ownerUserId: string, channelId: string) {
    const [row] = await rows(ownerUserId, channelId);
    if (!row) throw new DuetChannelNotFoundError();
    if (!row.dressed && row.agentIds.length === 1) {
      const [botId] = row.agentIds as [string];
      if (everythingOf(await rows(ownerUserId), botId)?.id === row.id)
        throw new ChannelRefusedError(
          "That's Everything, not a channel. Make a new channel instead.",
        );
    }
    return row;
  }

  /** A look for a conversation that has none yet: the default it was already drawn with. */
  function lookRow(channelId: string, at: Date) {
    return {
      channelId,
      ...channelLook(channelId, null),
      createdAt: at,
      updatedAt: at,
    };
  }

  async function one(ownerUserId: string, channelId: string) {
    const [row] = await rows(ownerUserId, channelId);
    if (!row) throw new DuetChannelNotFoundError();
    return recordOf(row);
  }

  return {
    async list(ownerUserId: string, botId: string): Promise<ChannelList> {
      const list = await rows(ownerUserId);
      const everything = everythingOf(list, botId);
      return {
        everythingId: everything?.id ?? null,
        channels: list.filter((row) => row.id !== everything?.id).map(recordOf),
      };
    },

    get: one,

    /**
     * A new conversation with the Bot, named, given its purpose and its look, and opened with the
     * Bot's hello. The hello runs after this answers, so the person lands in the channel and sees it
     * arrive.
     */
    async create(actor: AgentActor, input: NewChannel): Promise<ChannelRecord> {
      // direct() and Everything exclude workstreams by this metadata row. Publish the channel
      // and its look together so neither reader can adopt a half-created workstream as Chat.
      const channel = await database.transaction(async (transaction) => {
        const channel = await deps.channels.create(
          actor,
          [input.botId],
          transaction,
        );
        const at = now();
        await transaction
          .update(channels)
          .set({
            name: input.name,
            description: input.purpose,
            updatedAt: at,
          })
          .where(eq(channels.id, channel.id));
        await transaction.insert(openduetChannels).values({
          channelId: channel.id,
          icon: input.icon,
          colour: input.colour,
          createdAt: at,
          updatedAt: at,
        });
        return channel;
      });
      if (deps.hello) {
        const run = deps
          .hello({
            ownerUserId: actor.id,
            agentId: input.botId,
            channel,
            hello: { name: input.name, purpose: input.purpose },
          })
          .catch((error: unknown) => {
            console.error(
              JSON.stringify({
                type: "openduet-channel-hello-error",
                error: error instanceof Error ? error.name : "UnknownError",
                timestamp: new Date().toISOString(),
              }),
            );
          })
          .finally(() => greeting.delete(run));
        greeting.add(run);
      }
      return one(actor.id, channel.id);
    },

    /** Change the look, the name or the purpose. A conversation with no look takes one. */
    async update(
      ownerUserId: string,
      channelId: string,
      patch: ChannelPatch,
    ): Promise<ChannelRecord> {
      const row = await channelToChange(ownerUserId, channelId);
      const at = now();
      await database.transaction(async (transaction) => {
        if (patch.name !== undefined || patch.purpose !== undefined)
          await transaction
            .update(channels)
            .set({
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.purpose !== undefined
                ? { description: patch.purpose }
                : {}),
              updatedAt: at,
            })
            .where(eq(channels.id, row.id));
        const look = {
          ...(patch.icon ? { icon: patch.icon } : {}),
          ...(patch.colour ? { colour: patch.colour } : {}),
        };
        await transaction
          .insert(openduetChannels)
          .values({ ...lookRow(row.id, at), ...look })
          .onConflictDoUpdate({
            target: openduetChannels.channelId,
            set: { ...look, updatedAt: at },
          });
      });
      return one(ownerUserId, row.id);
    },

    /** Put a channel away under Archived, or bring it back. Its conversation stays as it is. */
    async setArchived(
      ownerUserId: string,
      channelId: string,
      archived: boolean,
    ): Promise<ChannelRecord> {
      const row = await channelToChange(ownerUserId, channelId);
      const at = now();
      const archivedAt = archived ? at : null;
      await database
        .insert(openduetChannels)
        .values({ ...lookRow(row.id, at), archivedAt })
        .onConflictDoUpdate({
          target: openduetChannels.channelId,
          set: { archivedAt, updatedAt: at },
        });
      return one(ownerUserId, row.id);
    },

    /**
     * Opened from the drawer: keep it a channel. Without a look of its own, a conversation the person
     * talks in becomes the newest undressed one, and Everything would move to it. Writes the default
     * look it was already drawn with, so nothing on screen changes.
     */
    async keep(ownerUserId: string, channelId: string): Promise<ChannelRecord> {
      const row = await channelToChange(ownerUserId, channelId);
      if (!row.dressed)
        await database
          .insert(openduetChannels)
          .values(lookRow(row.id, now()))
          .onConflictDoNothing();
      return one(ownerUserId, row.id);
    },

    /** Whether this conversation of the person's is a dressed channel. */
    async isChannel(ownerUserId: string, channelId: string) {
      const [row] = await database
        .select({ id: openduetChannels.channelId })
        .from(openduetChannels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, openduetChannels.channelId),
            eq(channelMemberships.userId, ownerUserId),
          ),
        )
        .where(eq(openduetChannels.channelId, channelId))
        .limit(1);
      return row !== undefined;
    },

    /**
     * The dressed channel a run's thread belongs to, for the person running it, or null for
     * Everything, a task's conversation, or any other thread. What the Bot is told, and what the
     * tasks it starts there are tagged with (openduet/run-channel.ts).
     */
    async ofThread(
      ownerUserId: string,
      threadId: string,
    ): Promise<RunChannel | null> {
      const [row] = await database
        .select({
          channelId: channels.id,
          name: channels.name,
          description: channels.description,
        })
        .from(intelligenceChannelMappings)
        .innerJoin(
          channels,
          and(
            eq(channels.id, intelligenceChannelMappings.channelId),
            isNull(channels.deletedAt),
          ),
        )
        .innerJoin(
          openduetChannels,
          eq(openduetChannels.channelId, channels.id),
        )
        .where(
          and(
            eq(intelligenceChannelMappings.threadId, threadId),
            eq(intelligenceChannelMappings.userId, ownerUserId),
            NOT_A_TASK,
          ),
        )
        .limit(1);
      return row
        ? {
            channelId: row.channelId,
            name: row.name,
            purpose: purposeOf(row.description),
          }
        : null;
    },

    /** Settles once every hello started here has finished. For tests and shutdown. */
    async idle() {
      while (greeting.size > 0) await Promise.allSettled([...greeting]);
    },
  };
}

/**
 * The hello in a new channel: the Bot speaks first. Like a check-in, nobody typed the message: it is
 * the framed hello (shared/channel-hello.ts), which the transcript draws as nothing, so the Bot's
 * line opens the conversation. Unlike a check-in, it is the person's own turn, as a task's is, so it
 * holds the person's tools: `suggest_replies` for its Yes, No and Not now, and on a Yes, `add_tasks`.
 *
 * Only the Bot's reply is recorded, which is what tells an open conversation to read the thread
 * again. The roster's working dot is lit while it runs, since no browser streams this turn.
 */
export function createChannelHello(deps: {
  channels: Pick<ChannelStore, "recordActivity" | "signalBusy">;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  runTurn: TurnRunner;
}): ChannelHelloStarter {
  return async ({ ownerUserId, agentId, channel, hello }) => {
    const actor = await deps.actorFor(ownerUserId);
    const runId = `channel-hello-${channel.id}`;
    const text = frameChannelHello(hello);
    const record = (said: string, id: string) =>
      deps.channels.recordActivity(
        actor,
        channel.id,
        { text: said, agentId, at: new Date() },
        { id },
      );
    await deps.channels
      .signalBusy(channel.threadId, true, runId)
      .catch(() => {});
    try {
      const result = await deps.runTurn({
        ownerUserId,
        agentId,
        threadId: channel.threadId,
        routineId: runId,
        runId,
        instruction: text,
        userMessage: { id: runId, role: "user", content: text },
        initiator: PERSON_INITIATOR,
      });
      if (result.replyText) await record(result.replyText, `${runId}:reply`);
    } catch (error) {
      if (!(error instanceof HeadlessToolSuspension)) throw error;
      await record(error.message, `${runId}:waiting`);
    } finally {
      await deps.channels
        .signalBusy(channel.threadId, false, runId)
        .catch(() => {});
    }
  };
}

const name = z.string().trim().min(1).max(MAX_CHANNEL_NAME);
/** Optional: a channel can be only a name. Empty clears it. */
const purpose = z.string().trim().max(MAX_CHANNEL_PURPOSE);
const newSchema = z
  .object({
    botId: z.string().trim().min(1).max(200),
    name,
    purpose: purpose.default(""),
    icon: z.enum(CHANNEL_ICONS),
    colour: z.enum(CHANNEL_COLOURS),
  })
  .strict();
const patchSchema = z
  .object({
    name: name.optional(),
    purpose: purpose.optional(),
    icon: z.enum(CHANNEL_ICONS).optional(),
    colour: z.enum(CHANNEL_COLOURS).optional(),
  })
  .strict();

/** The sentence a refused body gets, by the first field that was wrong. */
function refusalFor(issues: readonly { path: PropertyKey[] }[]): string {
  const field = issues[0]?.path[0];
  if (field === "name")
    return `Give the channel a name, in at most ${MAX_CHANNEL_NAME} characters.`;
  if (field === "purpose")
    return `Keep the purpose to ${MAX_CHANNEL_PURPOSE} characters.`;
  if (field === "icon" || field === "colour")
    return "Pick an icon and a colour from the sheet.";
  if (field === "botId") return "Choose one of your Bots.";
  return "Couldn't read that channel. Try again.";
}

async function readBody<T>(request: Request, schema: z.ZodType<T>) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new ChannelRefusedError("Couldn't read that channel. Try again.");
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    throw new ChannelRefusedError(refusalFor(parsed.error.issues));
  return parsed.data;
}

/**
 * `/api/openduet/channels`: the person's own channels, as the drawer, the New channel sheet and a
 * channel's own screen read and change them.
 */
export function createDuetChannelRoutes(
  store: DuetChannelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 16_384 }));
  routes.onError((error, context) => {
    if (error instanceof DuetChannelNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof AgentNotFoundError)
      return context.json(
        { error: "Couldn't find that Bot. Reload the page." },
        404,
      );
    if (error instanceof ChannelRefusedError)
      return context.json({ error: error.message }, 400);
    console.error(
      JSON.stringify({
        type: "openduet-channels-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json(
      { error: "Couldn't load your channels. Try again." },
      503,
    );
  });
  /** Which Bot Everything is with: the product's own, which the app names. */
  routes.get("/", async (context) => {
    const botId = context.req.query("bot")?.trim();
    if (!botId) throw new ChannelRefusedError("Choose one of your Bots.");
    return context.json(await store.list(context.var.actor.id, botId));
  });
  routes.post("/", async (context) => {
    const input = await readBody(context.req.raw, newSchema);
    return context.json(
      { channel: await store.create(context.var.actor, input) },
      201,
    );
  });
  routes.patch("/:id", async (context) => {
    const patch = await readBody(context.req.raw, patchSchema);
    return context.json({
      channel: await store.update(
        context.var.actor.id,
        context.req.param("id"),
        patch,
      ),
    });
  });
  routes.post("/:id/archive", async (context) =>
    context.json({
      channel: await store.setArchived(
        context.var.actor.id,
        context.req.param("id"),
        true,
      ),
    }),
  );
  routes.post("/:id/unarchive", async (context) =>
    context.json({
      channel: await store.setArchived(
        context.var.actor.id,
        context.req.param("id"),
        false,
      ),
    }),
  );
  routes.post("/:id/keep", async (context) =>
    context.json({
      channel: await store.keep(context.var.actor.id, context.req.param("id")),
    }),
  );
  return routes;
}
