import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameTaskBrief } from "@openbot/shared/task-brief";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { plainFailure, taskStatus } from "../src/openduet/task-store";
import { createTaskTurn } from "../src/openduet/task-threads";

const SCOPE = {
  ownerUserId: "owner",
  channelId: "task-channel",
  agentId: "openduet",
  threadId: "task-thread",
};
const ASK = "Prepare notes for the Hearth & Co visit.";

function turnWith(
  runTurn: TurnRunner,
  options: { final?: boolean; failWhile?: string } = {},
) {
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
    failWhile: options.failWhile,
  });
  return {
    said,
    busy,
    start: () =>
      run(SCOPE, {
        runId: "task-1",
        text: frameTaskBrief(ASK),
        signal: new AbortController().signal,
        final: options.final ?? false,
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
    // Not its last run: it will be tried again, so the Bot says nothing yet.
    expect(turn.said).toEqual([
      { text: ASK, agentId: null, id: "task-1:input" },
    ]);
  });

  test("that fails on its last run says so in the conversation, in plain words", async () => {
    const turn = turnWith(
      async () => {
        throw new Error("The routine's turn was stopped after 300s.");
      },
      { final: true },
    );
    await expect(turn.start()).rejects.toThrow("stopped after 300s");
    expect(turn.said.at(-1)).toEqual({
      text: "I couldn't finish this: the run took longer than 5 minutes.",
      agentId: "openduet",
      id: "task-1:failed",
    });
    expect(turn.busy).toEqual([true, false]);
  });
});

describe("the dev flag that fails task turns", () => {
  const folder = mkdtempSync(join(tmpdir(), "task-turn-"));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  test("fails every turn while its file exists, and nothing once it is gone", async () => {
    const flag = join(folder, "fail");
    writeFileSync(flag, "");
    let ran = 0;
    const runTurn: TurnRunner = async () => {
      ran += 1;
      return { replyText: "Here are your notes." };
    };
    const failing = turnWith(runTurn, { final: true, failWhile: flag });
    await expect(failing.start()).rejects.toThrow("simulated");
    expect(ran).toBe(0);
    expect(failing.said.at(-1)?.text).toBe(
      "I couldn't finish this: a service it needed didn't answer.",
    );

    rmSync(flag);
    const fine = turnWith(runTurn, { final: true, failWhile: flag });
    await fine.start();
    expect(ran).toBe(1);
    expect(fine.said.at(-1)?.text).toBe("Here are your notes.");
  });
});

describe("plainFailure", () => {
  test("says why a run couldn't finish without the error itself", () => {
    expect(plainFailure("The routine's turn was stopped after 300s.")).toBe(
      "the run took longer than 5 minutes",
    );
    expect(plainFailure("The turn finished without saying anything.")).toBe(
      "the run ended without a reply",
    );
    expect(
      plainFailure("This Bot or its channel is no longer available to you."),
    ).toBe("the Bot or its conversation is gone");
    expect(plainFailure("fetch failed")).toBe(
      "a service it needed didn't answer",
    );
    expect(plainFailure('429 {"error":{"type":"rate_limit"}} at line 3')).toBe(
      "something went wrong during the run",
    );
    // A run cut off twice leaves no error on the queue.
    expect(plainFailure(null)).toBe(
      "the run was cut off partway through, twice",
    );
  });
});

describe("taskStatus", () => {
  const at = (needsInput: boolean, working: boolean, resolved: boolean) =>
    taskStatus({ needsInput, working, resolved });

  test("puts what waits on the person first, then work under way, then the person's done", () => {
    expect(at(false, false, false)).toBe("ready_for_review");
    expect(
      taskStatus({
        needsInput: false,
        working: false,
        resolved: false,
        failed: true,
      }),
    ).toBe("failed");
    // Marked done beats failed; a retry under way beats both.
    expect(
      taskStatus({
        needsInput: false,
        working: false,
        resolved: true,
        failed: true,
      }),
    ).toBe("resolved");
    expect(
      taskStatus({
        needsInput: false,
        working: true,
        resolved: false,
        failed: true,
      }),
    ).toBe("working");
    expect(at(false, false, true)).toBe("resolved");
    expect(at(false, true, false)).toBe("working");
    expect(at(false, true, true)).toBe("working");
    expect(at(true, true, false)).toBe("needs_input");
    expect(at(true, false, true)).toBe("needs_input");
  });
});
