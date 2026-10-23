import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { headlessTurnRefusal } from "../admin/controls";
import type { AgentActor } from "../agents/profile-types";
import { PERSON_INITIATOR } from "../audit";
import type { GroupConversations } from "../channels/group";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import {
  intelligenceChannelMappings,
  responsibilityRuns,
  routineRuns,
} from "../db/schema";
import type { DeliveryScope } from "../delivery/types";
import { recordTaskContinuation } from "../proactive/store";
import type { ResponsibilityStore } from "../responsibilities/types";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "../work/queue";
import type { ApprovalResumeDependencies, ApprovalService } from "./service";

/**
 * One pass of the approval resume loop: claim a decided approval, carry it out, and pick the waiting
 * turn back up — a responsibility run, a group conversation or a routine run — then tell the channel.
 *
 * Moved out of index.ts verbatim. `notify` is taken as a function because index.ts assigns delivery
 * after this loop is created: the loop reads it when it runs, never when it is built.
 */
export function createApprovalResumeTick(deps: {
  approvalQueue: WorkQueue;
  approvalOwner: string;
  approvalService: ApprovalService;
  executeApprovedAction: ApprovalResumeDependencies["execute"];
  database: Database;
  responsibilityStore: ResponsibilityStore;
  groupConversations: Pick<GroupConversations, "continueWaiting">;
  approvalContinuationRunner: TurnRunner;
  channelStore: ChannelStore;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  notify: (
    scope: DeliveryScope,
    input: { id: string; text: string; kind: "reply" },
  ) => Promise<void>;
}): () => Promise<void> {
  const {
    approvalQueue,
    approvalOwner,
    approvalService,
    executeApprovedAction,
    database,
    responsibilityStore,
    groupConversations,
    approvalContinuationRunner,
    channelStore,
    actorFor,
  } = deps;
  return async () => {
    try {
      const [item] = await approvalQueue.claim({
        kind: "approval.resume",
        owner: approvalOwner,
        leaseMs: 15 * 60_000,
        limit: 1,
      });
      if (!item) return;
      // Set once the item is understood, so its last failed try can still tell the Bot.
      let abandon: ((reason: string) => Promise<void>) | undefined;
      try {
        const input = z
          .object({
            ownerUserId: z.string().min(1),
            approvalId: z.string().min(1),
          })
          .parse(item.payload);
        const resumeDependencies: ApprovalResumeDependencies = {
          // Asked before the action runs: with Use Bots off, or the Bot's model off the allowlist,
          // nothing is carried out and the refusal is final rather than retried.
          refusal: (action) =>
            headlessTurnRefusal({
              ownerUserId: action.actorId,
              agentId: action.botId,
            }),
          validate: (action) =>
            approvalService.validateReentry(action, () =>
              executeApprovedAction(action),
            ),
          execute: executeApprovedAction,
          continue: async ({
            continuation: snapshot,
            result,
            messageId,
            approvalId,
          }) => {
            const [waitingRun] = await database
              .select({ id: responsibilityRuns.id })
              .from(responsibilityRuns)
              .where(
                and(
                  eq(responsibilityRuns.status, "waiting"),
                  sql`${responsibilityRuns.waiting}->>'approvalId' = ${approvalId}`,
                ),
              )
              .limit(1);
            if (waitingRun) {
              await responsibilityStore.resumeWaiting(
                input.ownerUserId,
                waitingRun.id,
                result,
              );
              return;
            }
            const request = await approvalService.store.get(
              input.ownerUserId,
              approvalId,
            );
            const [source] = await database
              .select({ channelId: intelligenceChannelMappings.channelId })
              .from(intelligenceChannelMappings)
              .where(
                and(
                  eq(intelligenceChannelMappings.userId, input.ownerUserId),
                  eq(intelligenceChannelMappings.threadId, snapshot.threadId),
                ),
              )
              .limit(1);
            // A group turn's approval also writes the resumed reply into the shared transcript.
            let outcome: { replyText: string };
            try {
              outcome = await groupConversations.continueWaiting(
                approvalId,
                () =>
                  approvalContinuationRunner({
                    ownerUserId: input.ownerUserId,
                    routineId: "approval",
                    agentId: request.action.botId,
                    threadId: snapshot.threadId,
                    instruction: "",
                    initiator: snapshot.initiator ?? PERSON_INITIATOR,
                    continuation: { snapshot, result, messageId },
                  }),
              );
            } catch (error) {
              /*
               * Carried on, then stopped on another decision only the person can make: the
               * conversation now waits on that one, as a routine's does. This decision is done.
               * Thrown, it was retried, and every retry carried the turn on again from here,
               * repeating what it had already done before it stopped.
               */
              if (!(error instanceof HeadlessToolSuspension)) throw error;
              // A routine run waiting on this decision now waits on the next one.
              await database
                .update(routineRuns)
                .set({ waiting: error.waiting })
                .where(
                  and(
                    eq(routineRuns.status, "waiting"),
                    sql`${routineRuns.waiting}->>'approvalId' = ${approvalId}`,
                  ),
                );
              await recordTaskContinuation(database, {
                ownerUserId: input.ownerUserId,
                approvalId,
                channelId: source?.channelId ?? null,
                askedAt: request.createdAt,
                replyText: null,
                stoppedOn: error.waiting.requestId
                  ? { kind: error.waiting.kind, id: error.waiting.requestId }
                  : undefined,
              }).catch((failure: unknown) =>
                console.error(
                  JSON.stringify({
                    type: "started-task-continuation-error",
                    error:
                      failure instanceof Error ? failure.name : "UnknownError",
                    timestamp: new Date().toISOString(),
                  }),
                ),
              );
              return;
            }
            // A started task waiting on this decision, or on the answer that led to it, takes the
            // reply as where it now stands. Never thrown: the conversation has already continued,
            // and a retry here would carry the decision out twice.
            await recordTaskContinuation(database, {
              ownerUserId: input.ownerUserId,
              approvalId,
              channelId: source?.channelId ?? null,
              askedAt: request.createdAt,
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
            if (source && outcome.replyText)
              await channelStore.recordActivity(
                await actorFor(input.ownerUserId),
                source.channelId,
                {
                  text: outcome.replyText,
                  agentId: request.action.botId,
                  at: new Date(),
                },
                { id: messageId },
              );
            // A decision made in Slack, SMS or the phone gets its result back there too.
            if (source && outcome.replyText)
              await deps.notify(
                {
                  ownerUserId: input.ownerUserId,
                  channelId: source.channelId,
                  agentId: request.action.botId,
                  threadId: snapshot.threadId,
                },
                { id: messageId, text: outcome.replyText, kind: "reply" },
              );
            await database
              .update(routineRuns)
              .set({
                status: "succeeded",
                finishedAt: new Date(),
                error: null,
                waiting: null,
              })
              .where(
                and(
                  eq(routineRuns.status, "waiting"),
                  sql`${routineRuns.waiting}->>'approvalId' = ${approvalId}`,
                ),
              );
          },
        };
        abandon = (reason) =>
          approvalService.abandon(
            input.ownerUserId,
            input.approvalId,
            reason,
            resumeDependencies,
          );
        await approvalService.resume(
          input.ownerUserId,
          input.approvalId,
          resumeDependencies,
        );
        if (
          !(await approvalQueue.finish({
            kind: item.kind,
            key: item.key,
            owner: approvalOwner,
          }))
        )
          throw new Error(
            "The approval work lease was lost before completion.",
          );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // The queue will not hand this item out again, so the conversation hears now or never.
        if (abandon && item.attempts >= DEFAULT_MAX_ATTEMPTS) {
          try {
            await abandon(reason);
            await approvalQueue.finish({
              kind: item.kind,
              key: item.key,
              owner: approvalOwner,
            });
            return;
          } catch (failure) {
            console.error(
              JSON.stringify({
                type: "approval-abandon-error",
                error:
                  failure instanceof Error ? failure.message : String(failure),
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }
        await approvalQueue.release({
          kind: item.kind,
          key: item.key,
          owner: approvalOwner,
          delayMs: 10_000,
          reason,
        });
        throw error;
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "approval-resume-error",
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  };
}
