import { describe, expect, test } from "bun:test";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { createPersonResponseTick } from "../src/approvals/person-response-sweep";
import { createApprovalResumeTick } from "../src/approvals/resume-sweep";
import { routineRuns } from "../src/db/schema";

/**
 * A decision carried out, whose conversation then stops on another decision the person has to
 * make. That is the conversation waiting, not the decision failing: retried, every retry carried
 * the turn on again from here and repeated what it had already done (the same email sent again).
 */
describe("carrying a decision out, when the conversation stops on another", () => {
  test("finishes the decision once, never retries it, and moves a waiting routine on", async () => {
    const calls: string[] = [];
    /** A query builder that records which tables were written and answers every read with nothing. */
    const builder = (): unknown =>
      new Proxy(() => undefined, {
        get: (_target, property) =>
          property === "then"
            ? (resolve: (rows: unknown[]) => void) => resolve([])
            : () => builder(),
        apply: () => builder(),
      });
    const database = {
      select: () => builder(),
      update: (table: unknown) => {
        calls.push(table === routineRuns ? "update routine run" : "update");
        return builder();
      },
    };
    let runs = 0;
    const tick = createApprovalResumeTick({
      approvalQueue: {
        claim: async () => [
          {
            kind: "approval.resume",
            key: "approval-1",
            payload: { ownerUserId: "owner", approvalId: "approval-1" },
            attempts: 1,
          },
        ],
        finish: async () => {
          calls.push("finish");
          return true;
        },
        release: async () => {
          calls.push("release");
          return true;
        },
      } as never,
      approvalOwner: "replica",
      approvalService: {
        store: {
          get: async () => ({
            id: "approval-1",
            createdAt: new Date(),
            action: { botId: "openduet" },
          }),
        },
        resume: async (
          _owner: string,
          _id: string,
          dependencies: { continue: (input: unknown) => Promise<void> },
        ) => {
          await dependencies.continue({
            approvalId: "approval-1",
            messageId: "approval:approval-1",
            continuation: { threadId: "thread" },
            result: { content: "Sent." },
          });
          calls.push("resumed");
        },
        abandon: async () => {
          calls.push("abandon");
        },
      } as never,
      executeApprovedAction: (async () => "") as never,
      database: database as never,
      responsibilityStore: {} as never,
      groupConversations: {
        continueWaiting: async (_id: string, run: () => Promise<unknown>) =>
          run() as never,
      },
      approvalContinuationRunner: (async () => {
        runs += 1;
        throw new HeadlessToolSuspension(
          "Waiting for permission to share private information with google-workspace: rosa@example.test.",
          {
            kind: "approval",
            approvalId: "approval-2",
            requestId: "approval-2",
          },
        );
      }) as never,
      channelStore: {
        recordActivity: async () => {
          calls.push("activity");
        },
      } as never,
      actorFor: async () => ({ id: "owner" }) as never,
      notify: async () => {
        calls.push("notify");
      },
    });
    await tick();
    expect(runs).toBe(1);
    expect(calls).toContain("finish");
    expect(calls).toContain("resumed");
    expect(calls).toContain("update routine run");
    expect(calls).not.toContain("release");
    expect(calls).not.toContain("abandon");
    // Nothing new was said: the conversation is waiting on the next decision.
    expect(calls).not.toContain("activity");
  });
});

describe("carrying a person's answer on, when the conversation stops on a decision", () => {
  test("finishes the answer once, and the conversation waits on that decision", async () => {
    const calls: string[] = [];
    const builder = (): unknown =>
      new Proxy(() => undefined, {
        get: (_target, property) =>
          property === "then"
            ? (resolve: (rows: unknown[]) => void) => resolve([])
            : () => builder(),
        apply: () => builder(),
      });
    let runs = 0;
    const tick = createPersonResponseTick({
      approvalQueue: {
        claim: async () => [
          {
            kind: "person.response",
            key: "question-1",
            attempts: 1,
            payload: {
              ownerUserId: "owner",
              response: "Yes, go ahead.",
              question: {
                actorId: "owner",
                botId: "openduet",
                threadId: "thread",
                runId: "run",
                question: "Should I send it?",
                mode: "completed_question",
                initiator: { kind: "person" },
              },
            },
          },
        ],
        finish: async () => {
          calls.push("finish");
          return true;
        },
        release: async () => {
          calls.push("release");
          return true;
        },
      } as never,
      database: { select: () => builder(), update: () => builder() } as never,
      personResponseOwner: "replica",
      authoriseQuestion: async () => undefined,
      approvalContinuationRunner: (async () => {
        runs += 1;
        throw new HeadlessToolSuspension(
          "Waiting for permission to share private information with google-workspace: ana@example.test.",
          { kind: "approval", approvalId: "share-1", requestId: "share-1" },
        );
      }) as never,
      responsibilityStore: {} as never,
      responsibilityAnswerTurn: (() => undefined) as never,
      sourceForCoordinationRun: async () => null,
      channelStore: {
        recordActivity: async () => {
          calls.push("activity");
        },
      } as never,
      actorFor: async () => ({ id: "owner" }) as never,
      notify: async () => {
        calls.push("notify");
      },
    });
    await tick();
    expect(runs).toBe(1);
    expect(calls).toEqual(["finish"]);
  });
});
