import { randomUUID } from "node:crypto";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { eq } from "drizzle-orm";
import type { AuditInitiator } from "../audit";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import { createProactiveStore } from "../proactive/store";
import { ProactiveNotFoundError } from "../proactive/types";
import { buildMorningBrief, type CallTool, openduetTools } from "./brief";
import { offerTools } from "./offers";
import { createPageStore, type PageStore, pageTools } from "./pages";
import { replyTools } from "./replies";
import { currentRunChannelId } from "./run-channel";
import type { TaskIntake } from "./task-store";
import {
  type TaskSink,
  type TaskStarter,
  taskDetail,
  taskTools,
} from "./tasks";
import type { Complete } from "./triage";

/** How a card the person asked for is told from research's: its run id starts with this. */
export const ASKED_RUN_PREFIX = "asked:";

/** One card for Up next: what to do, the detail under it, and where it came from. */
export type UpNextCard = {
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceLink: string | null;
  /** The OpenDuet channel it was asked for in; absent or null for Everything. */
  fromChannelId?: string | null;
};

/**
 * Puts cards the person asked for on Tasks' Up next, each with Start and Hide: what `add_tasks`
 * saves from a conversation, and what Save for Up next saves from the + on Tasks.
 *
 * A card belongs to the person's research setting for the Bot, which says where Start runs it. One
 * that was never set up is made here with research left OFF, in their own conversation with the
 * Bot: asking for tasks must not start background research nobody turned on. The setting is unique
 * per person and Bot, so a second request racing this one finds theirs.
 */
export function createUpNext(deps: {
  database: Database;
  directChannel: (
    ownerUserId: string,
    agentId: string,
  ) => Promise<{ id: string; threadId: string }>;
}) {
  const proactive = createProactiveStore(deps.database);
  return async ({
    ownerUserId,
    agentId,
    cards,
  }: {
    ownerUserId: string;
    agentId: string;
    cards: UpNextCard[];
  }): Promise<{ id: string; title: string }[]> => {
    const existing = async () =>
      (await proactive.list(ownerUserId)).find(
        (setting) => setting.agentId === agentId,
      );
    let setting = await existing();
    if (!setting) {
      const channel = await deps.directChannel(ownerUserId, agentId);
      try {
        setting = await proactive.create(
          ownerUserId,
          { agentId, channelId: channel.id, enabled: false },
          channel.threadId,
        );
      } catch (error) {
        setting = await existing();
        if (!setting) throw error;
      }
    }
    const settingId = setting.id;
    // One id for the cards asked for together, marked so they can be told from research's.
    const runId = `${ASKED_RUN_PREFIX}${randomUUID()}`;
    const added: { id: string; title: string }[] = [];
    for (const card of cards) {
      const row = await proactive.addSuggestion({
        ownerUserId,
        agentId,
        settingId,
        runId,
        title: card.title,
        detail: card.detail,
        sourceApp: card.sourceApp,
        sourceRef: null,
        sourceLink: card.sourceLink,
        fromChannelId: card.fromChannelId ?? null,
      });
      added.push({ id: row.id, title: row.title });
    }
    return added;
  };
}

/**
 * The + on Tasks: start a task now, through `startTask` as `start_task` does, or save it for Up
 * next, through `createUpNext` as `add_tasks` does.
 */
export function createTaskIntake(deps: {
  database: Database;
  directChannel: (
    ownerUserId: string,
    agentId: string,
  ) => Promise<{ id: string; threadId: string }>;
  startTask: TaskStarter;
}): TaskIntake {
  const upNext = createUpNext(deps);
  return {
    start: (ownerUserId, agentId, task) =>
      deps.startTask({ ownerUserId, agentId, task }),
    async save(ownerUserId, agentId, card) {
      const [added] = await upNext({
        ownerUserId,
        agentId,
        cards: [{ ...card, sourceApp: null, sourceLink: null }],
      });
      if (!added) throw new Error("The card was not saved.");
      return added;
    },
  };
}

/**
 * OpenDuet's tools, assembled once and handed per run to the Bot that runs it.
 *
 * Kept here rather than in index.ts so the server's assembly gains one line, not a block: index.ts is
 * OpenBot's, and every line OpenDuet adds to it is a line an OpenBot update can collide with.
 */
export function createOpenDuetTools(deps: {
  database: Database;
  callTool: CallTool;
  complete: Complete;
  model: string;
  /** The person's own conversation with a Bot, made if they have none; where an asked task starts. */
  directChannel: (
    ownerUserId: string,
    agentId: string,
  ) => Promise<{ id: string; threadId: string }>;
  /** Where `make_page` saves. The same store answers /api/openduet/pages. */
  pages?: PageStore;
  /**
   * Where `start_task` opens a task and starts it: the proactive engine's `startAsked`, which runs
   * started suggestions too. Absent, the tool is not held.
   */
  startTask?: TaskStarter;
  /**
   * The channel the run calling a tool is in. Defaults to the run's own, as the middleware on every
   * Bot sets it (openduet/run-channel.ts); a test passes its own.
   */
  runChannel?: () => string | null;
}): (
  actorId: string,
  botId: string,
  initiator: AuditInitiator,
) => GrantedTool[] {
  const upNext = createUpNext(deps);
  const runChannel = deps.runChannel ?? currentRunChannelId;
  const save: TaskSink = ({ ownerUserId, agentId, tasks, fromChannelId }) =>
    upNext({
      ownerUserId,
      agentId,
      cards: tasks.map((asked) => ({
        title: asked.title,
        detail: taskDetail(asked),
        sourceApp: asked.source ?? null,
        sourceLink: asked.link ?? null,
        fromChannelId,
      })),
    });
  const proactive = createProactiveStore(deps.database);
  const pages = deps.pages ?? createPageStore(deps.database);
  return (actorId, botId, initiator) => [
    ...openduetTools({
      actorId,
      botId,
      initiator,
      person: async () => {
        const [person] = await deps.database
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, actorId));
        return { name: person?.name ?? null, email: person?.email ?? null };
      },
      build: (input) =>
        buildMorningBrief(
          {
            callTool: deps.callTool,
            complete: deps.complete,
            model: deps.model,
          },
          input,
        ),
    }),
    ...replyTools({ initiator }),
    ...taskTools({
      actorId,
      botId,
      initiator,
      save,
      start: deps.startTask,
      channel: runChannel,
    }),
    ...offerTools({
      actorId,
      initiator,
      read: (ownerUserId, suggestionId) =>
        proactive.suggestion(ownerUserId, suggestionId).catch((error) => {
          if (error instanceof ProactiveNotFoundError) return null;
          throw error;
        }),
    }),
    ...pageTools({
      get: (id) => pages.get(actorId, id),
      save: (input) => pages.save(actorId, botId, input),
      initiator,
    }),
  ];
}
