import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { randomUUID } from "node:crypto";
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
import { type TaskSink, taskDetail, taskTools } from "./tasks";
import type { Complete } from "./triage";

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
}): (
  actorId: string,
  botId: string,
  initiator: AuditInitiator,
) => GrantedTool[] {
  const proactive = createProactiveStore(deps.database);
  /*
   * A task card belongs to the person's research setting for the Bot, which says where Start runs
   * it. One that was never set up is made here with research left OFF, in their own conversation
   * with the Bot: asking for tasks must not start background research nobody turned on. The
   * setting is unique per person and Bot, so a second request racing this one finds theirs.
   */
  const save: TaskSink = async ({ ownerUserId, agentId, tasks }) => {
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
    const runId = `asked:${randomUUID()}`;
    const added: { id: string; title: string }[] = [];
    for (const asked of tasks) {
      const row = await proactive.addSuggestion({
        ownerUserId,
        agentId,
        settingId,
        runId,
        title: asked.title,
        detail: taskDetail(asked),
        sourceApp: asked.source ?? null,
        sourceRef: null,
        sourceLink: asked.link ?? null,
      });
      added.push({ id: row.id, title: row.title });
    }
    return added;
  };
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
    ...taskTools({ actorId, botId, initiator, save }),
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
      save: (input) => pages.save(actorId, botId, input),
      initiator,
    }),
  ];
}
