import { describe, expect, test } from "bun:test";
import { frameTaskBrief } from "@openbot/shared/task-brief";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { taskStatus } from "../src/openduet/task-store";
import { createTaskTurn } from "../src/openduet/task-threads";

const SCOPE = {
  ownerUserId: "owner",
  channelId: "task-channel",
  agentId: "openduet",
  threadId: "task-thread",
};
const ASK = "Prepare notes for the Hearth & Co visit.";

function turnWith(runTurn: TurnRunner) {
  const said: { text: string; agentId: string | null; id: string }[] = [];
  const busy: boolean[] = [];
  const run = createTaskTurn({
    channels: {
      recordActivity: async (_actor, channelId, activity, source) => {
        expect(channelId).toBe(SCOPE.channelId);
        said.push({
          text: activity.text,
          agentId: activity.agentId,
          id: source?.id ?? "",
        });
      },
      signalBusy: async (threadId, value) => {
        expect(threadId).toBe(SCOPE.threadId);
        busy.push(value);
      },
    },
    actorFor: async (id) => ({ id, role: "user" }),
    runTurn,
  });
  return {
    said,
    busy,
    start: () =>
      run(SCOPE, {
        runId: "task-1",
        text: frameTaskBrief(ASK),
        signal: new AbortController().signal,
      }),
  };
}

describe("a task's turn", () => {
  test("is the person's ask in the task's conversation, with the dot lit while it runs", async () => {
    const asked: Parameters<TurnRunner>[0][] = [];
    const turn = turnWith(async (input) => {
      asked.push(input);
      return { replyText: "Here are your notes." };
    });
    await turn.start();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      ...SCOPE,
      instruction: frameTaskBrief(ASK),
      userMessage: { id: "task-1", role: "user", content: frameTaskBrief(ASK) },
      initiator: { kind: "person" },
    });
    // The roster reads the ask, never the frame around it, then the Bot's reply.
    expect(turn.said).toEqual([
      { text: ASK, agentId: null, id: "task-1:input" },
      { text: "Here are your notes.", agentId: "openduet", id: "task-1:reply" },
    ]);
    expect(turn.busy).toEqual([true, false]);
  });

  test("that stops for Allow once ends waiting on the person, not failed", async () => {
    const turn = turnWith(async () => {
      throw new HeadlessToolSuspension(
        "This action is waiting for your approval.",
        { kind: "approval", approvalId: "a" },
      );
    });
    await turn.start();
    expect(turn.said.at(-1)).toEqual({
      text: "This action is waiting for your approval.",
      agentId: "openduet",
      id: "task-1:waiting",
    });
    expect(turn.busy).toEqual([true, false]);
  });

  test("that fails still puts the dot out, and says so to the queue", async () => {
    const turn = turnWith(async () => {
      throw new Error("The model is unavailable.");
    });
    await expect(turn.start()).rejects.toThrow("The model is unavailable.");
    expect(turn.busy).toEqual([true, false]);
  });
});

describe("taskStatus", () => {
  const at = (needsInput: boolean, working: boolean, resolved: boolean) =>
    taskStatus({ needsInput, working, resolved });

  test("puts what waits on the person first, then work under way, then the person's done", () => {
    expect(at(false, false, false)).toBe("ready_for_review");
    expect(at(false, false, true)).toBe("resolved");
    expect(at(false, true, false)).toBe("working");
    expect(at(false, true, true)).toBe("working");
    expect(at(true, true, false)).toBe("needs_input");
    expect(at(true, false, true)).toBe("needs_input");
  });
});
