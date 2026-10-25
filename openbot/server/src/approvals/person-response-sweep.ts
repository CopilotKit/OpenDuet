import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { z } from "zod";
import type { RunAssertion } from "../agents/callback-token";
import type { Database } from "../db/client";
import { recordQuestionContinuation } from "../proactive/store";
import type { AgentActor } from "../agents/profile-types";
import type { ChannelStore } from "../channels/routes";
import type { DeliveryScope } from "../delivery/types";
import type { ResponsibilityStore } from "../responsibilities/types";
import type { WorkQueue } from "../work/queue";
import { resumePersonQuestion } from "./question-resume";
import {
  type PersonQuestion,
  personQuestionSchema,
  questionConversationBot,
} from "./questions";
import { ApprovalRefusedError } from "./types";

/**
 * One pass of the person-response loop: claim a person's answer to a Bot's question, check the
 * question still belongs where it was asked, resume the turn that asked it, and post the reply
 * back to the channel the question came from.
 *
 * Moved out of index.ts verbatim. `notify` is taken as a function because index.ts assigns
 * delivery after this loop is created: the loop reads it when it runs, never when it is built.
 */
export function createPersonResponseTick(deps: {
  approvalQueue: WorkQueue;
  personResponseOwner: string;
  authoriseQuestion: (question: PersonQuestion) => Promise<unknown>;
  approvalContinuationRunner: TurnRunner;
  responsibilityStore: ResponsibilityStore;
  responsibilityAnswerTurn: NonNullable<
    Parameters<typeof resumePersonQuestion>[0]["responsibilityTurn"]
  >;
  sourceForCoordinationRun: (
    run: RunAssertion,
  ) => Promise<{ channelId: string } | null | undefined>;
  channelStore: ChannelStore;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  notify: (
    scope: DeliveryScope,
    input: { id: string; text: string; kind: "reply" },
  ) => Promise<void>;
  /** For the started task that asked: it takes the reply (proactive/store.ts). */
  database: Database;
}): () => Promise<void> {
  const {
    database,
    approvalQueue,
    personResponseOwner,
    authoriseQuestion,
    approvalContinuationRunner,
    responsibilityStore,
    responsibilityAnswerTurn,
    sourceForCoordinationRun,
    channelStore,
    actorFor,
  } = deps;
  return async () => {
    try {
      const [item] = await approvalQueue.claim({
        kind: "person.response",
        owner: personResponseOwner,
        leaseMs: 10 * 60_000,
        limit: 1,
        maxAttempts: 1,
        serialBy: "taskId",
      });
      if (!item) return;
      try {
        const payload = z
          .object({
            ownerUserId: z.string().min(1),
            // The saved question, initiator included, so the answer resumes the turn that asked.
            question: personQuestionSchema,
            response: z.string().min(1).max(6000),
          })
          .parse(item.payload);
        if (payload.ownerUserId !== payload.question.actorId)
          throw new ApprovalRefusedError(
            "The saved question owner does not match.",
          );
        await authoriseQuestion(payload.question);
        let outcome: { replyText: string };
        try {
          outcome = await resumePersonQuestion({
            ownerUserId: payload.ownerUserId,
            question: payload.question,
            response: payload.response,
            messageId: `person-response:${item.key}`,
            runTurn: approvalContinuationRunner,
            responsibilities: responsibilityStore,
            responsibilityTurn: responsibilityAnswerTurn,
          });
        } catch (error) {
          /*
           * Carried on with the answer, then stopped on a decision only the person can make: the
           * conversation now waits on that, and this answer is done. Thrown, the answer was
           * recorded as failed and the conversation was left waiting on nothing anybody could see.
           * (Builder C's fix on #37, carried here.)
           */
          if (!(error instanceof HeadlessToolSuspension)) throw error;
          await recordQuestionContinuation(database, {
            ownerUserId: payload.ownerUserId,
            questionKey: item.key,
            replyText: null,
            stoppedOn: error.waiting.requestId
              ? { kind: error.waiting.kind, id: error.waiting.requestId }
              : undefined,
          }).catch(() => undefined);
          await approvalQueue.finish({
            kind: item.kind,
            key: item.key,
            owner: personResponseOwner,
          });
          return;
        }
        // A started task that asked this takes the reply as where it now stands. Never thrown:
        // the conversation has already continued.
        await recordQuestionContinuation(database, {
          ownerUserId: payload.ownerUserId,
          questionKey: item.key,
          replyText: outcome.replyText,
        }).catch((error: unknown) =>
          console.error(
            JSON.stringify({
              type: "started-task-continuation-error",
              error: error instanceof Error ? error.name : "UnknownError",
              timestamp: new Date().toISOString(),
            }),
          ),
        );
        const source = await sourceForCoordinationRun({
          ...payload.question,
          botId: questionConversationBot(payload.question),
          depth: 0,
        });
        if (source && outcome.replyText)
          await channelStore.recordActivity(
            await actorFor(payload.ownerUserId),
            source.channelId,
            {
              text: outcome.replyText,
              agentId: questionConversationBot(payload.question),
              at: new Date(),
            },
            { id: `person-response:${item.key}` },
          );
        if (source && outcome.replyText)
          await deps.notify(
            {
              ownerUserId: payload.ownerUserId,
              channelId: source.channelId,
              agentId: questionConversationBot(payload.question),
              threadId: payload.question.threadId,
            },
            {
              id: `person-response:${item.key}`,
              text: outcome.replyText,
              kind: "reply",
            },
          );
        if (
          !(await approvalQueue.finish({
            kind: item.kind,
            key: item.key,
            owner: personResponseOwner,
          }))
        )
          throw new Error(
            "The question response lease was lost before completion.",
          );
      } catch (error) {
        await approvalQueue.release({
          kind: item.kind,
          key: item.key,
          owner: personResponseOwner,
          delayMs: 0,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "person-response-error",
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  };
}
