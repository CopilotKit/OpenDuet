import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { eq } from "drizzle-orm";
import type { AuditInitiator } from "../audit";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import { buildMorningBrief, type CallTool, openduetTools } from "./brief";
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
}): (
  actorId: string,
  botId: string,
  initiator: AuditInitiator,
) => GrantedTool[] {
  return (actorId, botId, initiator) =>
    openduetTools({
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
    });
}
