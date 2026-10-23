import { readTaskBrief } from "@openbot/shared/task-brief";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import type { AgentActor } from "../agents/profile-types";
import { PERSON_INITIATOR } from "../audit";
import type { ChannelStore } from "../channels/routes";
import type {
  ProactiveEngineDeps,
  ProactiveScope,
  TaskThreads,
} from "../proactive/engine";
import type { TaskStore } from "./task-store";

/*
 * The two halves of a task the proactive engine leaves to the server's assembly: making its
 * conversation, and running its turn there. Kept here rather than in index.ts so the assembly gains a
 * line each, not a block (see wiring.ts for why that matters).
 */

/**
 * Opens a task in a new conversation with the Bot, and finds that conversation again to run it.
 *
 * A NEW CONVERSATION EVERY TIME, never the person's own with the Bot, so the work stays out of Chat.
 * The channel store leaves task conversations out when it looks for that one (`direct`), and the
 * roster marks them, so Chat and the menu never mistake one for the person's own.
 */
export function createTaskThreads(deps: {
  store: Pick<TaskStore, "create" | "locate">;
  channels: Pick<ChannelStore, "create">;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  /** The conversation as a turn needs it, or null once the person cannot reach it or its Bot. */
  scopeFor: (
    ownerUserId: string,
    channelId: string,
    agentId: string,
  ) => Promise<ProactiveScope | null>;
}): TaskThreads {
  return {
    async open(input) {
      const channel = await deps.channels.create(
        await deps.actorFor(input.ownerUserId),
        [input.agentId],
      );
      const task = await deps.store.create({
        ownerUserId: input.ownerUserId,
        botId: input.agentId,
        channelId: channel.id,
        title: input.title,
        why: input.why,
        origin: input.origin,
        suggestionId: input.suggestionId,
        sourceApp: input.sourceApp,
        sourceLink: input.sourceLink,
        fromChannelId: input.fromChannelId ?? null,
      });
      return { id: task.id, channelId: task.channelId, title: task.title };
    },
    async scope(ownerUserId, taskId) {
      const task = await deps.store.locate(ownerUserId, taskId);
      return task
        ? deps.scopeFor(ownerUserId, task.channelId, task.botId)
        : null;
    },
  };
}

/**
 * A task's turn: the person's ask as their message in the task's conversation, a person-started turn
 * through the runner every started task uses, and the Bot's reply recorded, which is what tells an
 * open conversation to read the thread again.
 *
 * The roster's working dot is lit while it runs, since no browser streams this turn.
 *
 * STOPPING FOR THE PERSON IS NOT FAILING. A turn that reaches Allow once, or asks a question, ends
 * with the request waiting on them; answering it carries the turn on (approvals/resume-sweep.ts). So
 * it is recorded as the Bot's line and the turn is done, rather than thrown as an error the queue
 * would log and hold.
 */
export function createTaskTurn(deps: {
  channels: Pick<ChannelStore, "recordActivity" | "signalBusy">;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  runTurn: TurnRunner;
}): ProactiveEngineDeps["startTask"] {
  return async (scope, input) => {
    const actor = await deps.actorFor(scope.ownerUserId);
    const record = (text: string, agentId: string | null, id: string) =>
      deps.channels.recordActivity(
        actor,
        scope.channelId,
        { text, agentId, at: new Date() },
        { id },
      );
    // The roster's line is the person's ask, never the frame the model reads around it.
    await record(
      readTaskBrief(input.text) ?? input.text,
      null,
      `${input.runId}:input`,
    );
    await deps.channels.signalBusy(scope.threadId, true).catch(() => {});
    try {
      const result = await deps.runTurn({
        ...scope,
        routineId: input.runId,
        instruction: input.text,
        userMessage: { id: input.runId, role: "user", content: input.text },
        initiator: PERSON_INITIATOR,
        signal: input.signal,
      });
      if (result.replyText)
        await record(result.replyText, scope.agentId, `${input.runId}:reply`);
    } catch (error) {
      if (!(error instanceof HeadlessToolSuspension)) throw error;
      await record(error.message, scope.agentId, `${input.runId}:waiting`);
    } finally {
      await deps.channels.signalBusy(scope.threadId, false).catch(() => {});
    }
  };
}
