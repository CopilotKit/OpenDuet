import { readFirstDay } from "@openbot/shared/first-day";
import { readMorningBrief } from "@openbot/shared/morning-brief";
import { existsSync } from "node:fs";
import { frameTaskInput, readTaskBrief } from "@openbot/shared/task-brief";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { ThreadLockBusyError } from "@openbot/toolkit/lease";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import type { AgentActor } from "../agents/profile-types";
import { PERSON_INITIATOR } from "../audit";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import {
  type ProactiveEngineDeps,
  type ProactiveScope,
  replyTail,
  replyEnding,
  type TaskThreads,
} from "../proactive/engine";
import type { createTaskReplyContext } from "./task-reply-context";
import { plainFailure, type TaskStore } from "./task-store";

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
  database: Pick<Database, "transaction">;
  store: Pick<
    TaskStore,
    "create" | "locate" | "failedTurn" | "pendingQuestions" | "answerQuestions"
  >;
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
    pendingQuestions: (ownerUserId, taskId) =>
      deps.store.pendingQuestions(ownerUserId, taskId),
    answerQuestions: (ownerUserId, ids) =>
      deps.store.answerQuestions(ownerUserId, ids),
    async open(input) {
      const actor = await deps.actorFor(input.ownerUserId);
      // direct() excludes tasks by their association row. Commit both together so a concurrent
      // Chat/first-day lookup cannot adopt the channel while that row is still being inserted.
      return deps.database.transaction(async (transaction) => {
        const channel = await deps.channels.create(
          actor,
          [input.agentId],
          transaction,
        );
        const task = await deps.store.create(
          {
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
            thumbnail: input.thumbnail,
          },
          transaction,
        );
        return { id: task.id, channelId: task.channelId, title: task.title };
      });
    },
    async scope(ownerUserId, taskId) {
      const task = await deps.store.locate(ownerUserId, taskId);
      return task
        ? deps.scopeFor(ownerUserId, task.channelId, task.botId)
        : null;
    },
    failedTurn: (ownerUserId, taskId) =>
      deps.store.failedTurn(ownerUserId, taskId),
  };
}

/**
 * DEV ONLY. While the file this names exists, every task's turn fails partway through, the way a
 * turn fails when its model provider drops: the run starts for real, so the ask is in the
 * conversation, and is cut at its first words (or after `DEV_FAIL_AFTER_MS`). Unset, as it is
 * everywhere but a developer's own stack, it does nothing. It is how the failed state and Try again
 * are shown on a running stack: create the file, start a task, watch it fail twice, delete the file,
 * press Try again.
 */
export const DEV_FAIL_TASKS_WHILE = "OPENDUET_DEV_FAIL_TASKS_WHILE";
const DEV_FAIL_AFTER_MS = 8_000;

/**
 * The file {@link DEV_FAIL_TASKS_WHILE} names, or undefined where it must do nothing.
 *
 * NOTHING UNDER `NODE_ENV=production`, which every container image and chart install sets. A line
 * left in a `.env` that went on to a deployment would otherwise fail every task its people started
 * whenever a file of that name existed, and say the model provider was down. Said once at boot
 * there, so the line is not mistaken for working.
 */
export function devFailTasksWhile(
  environment: Record<string, string | undefined>,
): string | undefined {
  const named = environment[DEV_FAIL_TASKS_WHILE]?.trim() || undefined;
  if (named === undefined) return undefined;
  if (environment.NODE_ENV?.trim() === "production") {
    console.warn(
      `${DEV_FAIL_TASKS_WHILE} is set and ignored, because NODE_ENV=production. It is for a developer's own stack.`,
    );
    return undefined;
  }
  return named;
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
 *
 * FAILING ON ITS LAST RUN IS SAID. A turn that throws is thrown on, for the queue to hold and retry.
 * On its last run (`final`) the Bot's line says it couldn't finish and why, in plain words, so the
 * conversation does not end on the person's ask with nothing after it.
 */
export function createTaskTurn(deps: {
  channels: Pick<ChannelStore, "recordActivity" | "signalBusy">;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  runTurn: TurnRunner;
  replyContext?: Pick<ReturnType<typeof createTaskReplyContext>, "resolve">;
  /** See `DEV_FAIL_TASKS_WHILE`. Read from the environment when not given. */
  failWhile?: string | undefined;
}): ProactiveEngineDeps["startTask"] {
  const failWhile =
    "failWhile" in deps ? deps.failWhile : devFailTasksWhile(process.env);
  return async (scope, input) => {
    const actor = await deps.actorFor(scope.ownerUserId);
    const record = (
      text: string,
      agentId: string | null,
      id: string,
      needsInput?: boolean,
    ) =>
      deps.channels.recordActivity(
        actor,
        scope.channelId,
        {
          text,
          agentId,
          at: new Date(),
          ...(needsInput === undefined ? {} : { needsInput }),
        },
        { id },
      );
    /*
     * The roster's line is the person's ask, never the frame the model reads around it. A morning
     * brief has no ask: nobody typed it, so it gets no line of the person's at all, as a check-in
     * gets none, and the roster shows the Bot's reply recorded below.
     */
    if (readMorningBrief(input.text) === null)
      await record(
        input.acceptedReply?.text ??
          readTaskBrief(input.text) ??
          readFirstDay(input.text) ??
          (input.text || "Sent attachments"),
        null,
        readTaskBrief(input.text) === null
          ? input.runId
          : `${input.runId}:input`,
      );
    await deps.channels
      .signalBusy(scope.threadId, true, input.runId)
      .catch(() => {});
    try {
      const failing = failWhile !== undefined && existsSync(failWhile);
      const cut = new AbortController();
      const context =
        input.attachmentIds?.length || input.skillIds?.length
          ? await (deps.replyContext?.resolve(scope, input) ??
              Promise.reject(
                new Error("Files and skills are unavailable for this task."),
              ))
          : { attachments: [], skillInstructions: [] };
      // Accepted file-only replies need the same identity as text replies, while the runner's
      // instruction and the attachment parts retain the person's original input unchanged.
      const text = input.acceptedReply
        ? frameTaskInput(input.text, input.acceptedReply)
        : input.text;
      const content = context.attachments.length
        ? [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...context.attachments,
          ]
        : text;
      const turn = deps.runTurn({
        ...scope,
        routineId: input.runId,
        instruction: input.text,
        userMessage: { id: input.runId, role: "user", content },
        ...(context.skillInstructions.length
          ? {
              systemMessages: context.skillInstructions.map(
                (content, index) => ({
                  id: `${input.runId}:skill:${index}`,
                  role: "system" as const,
                  content,
                }),
              ),
            }
          : {}),
        initiator: PERSON_INITIATOR,
        signal: failing
          ? AbortSignal.any([input.signal, cut.signal])
          : input.signal,
        ...(failing ? { onText: () => cut.abort() } : {}),
      });
      if (failing) {
        const timer = setTimeout(() => cut.abort(), DEV_FAIL_AFTER_MS);
        await turn
          .catch((error: unknown) => {
            if (error instanceof ThreadLockBusyError) throw error;
          })
          .finally(() => clearTimeout(timer));
        throw new Error(
          `The model provider is unavailable (simulated: ${DEV_FAIL_TASKS_WHILE} names a file that exists).`,
        );
      }
      const result = await turn;
      /*
       * Recorded as how the reply ends, its next step, rather than how it starts: a task's
       * conversation is never listed by its preview, and Tasks shows this line after the task's
       * status (`TaskRecord.next`). The preview keeps only its first 200 characters, which for a
       * long reply would be its opening, not where it leaves things.
       */
      if (result.replyText)
        await record(
          replyTail(result.replyText) ?? result.replyText,
          scope.agentId,
          `${input.runId}:reply`,
          replyEnding(result.replyText).asks || result.replyChips === true,
        );
    } catch (error) {
      if (!(error instanceof HeadlessToolSuspension)) {
        if (input.final && !(error instanceof ThreadLockBusyError))
          await record(
            `I couldn't finish this: ${plainFailure(error instanceof Error ? error.message : String(error))}.`,
            scope.agentId,
            `${input.runId}:failed`,
          ).catch(() => {});
        throw error;
      }
      await record(error.message, scope.agentId, `${input.runId}:waiting`);
    } finally {
      await deps.channels
        .signalBusy(scope.threadId, false, input.runId)
        .catch(() => {});
    }
  };
}
