import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameMorningBrief } from "@openbot/shared/morning-brief";
import { frameTaskBrief } from "@openbot/shared/task-brief";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { ThreadLockBusyError } from "@openbot/toolkit/lease";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { plainFailure, taskStatus } from "../src/openduet/task-store";
import {
  createTaskTurn,
  DEV_FAIL_TASKS_WHILE,
  devFailTasksWhile,
} from "../src/openduet/task-threads";

const SCOPE = {
  ownerUserId: "owner",
  channelId: "task-channel",
  agentId: "openduet",
  threadId: "task-thread",
};
const ASK = "Prepare notes for the Hearth & Co visit.";

function turnWith(
  runTurn: TurnRunner,
  options: { final?: boolean; failWhile?: string; text?: string } = {},
) {
  const said: {
    text: string;
    agentId: string | null;
    id: string;
    needsInput?: boolean;
  }[] = [];
  const busy: boolean[] = [];
  const run = createTaskTurn({
    channels: {
      recordActivity: async (_actor, channelId, activity, source) => {
        expect(channelId).toBe(SCOPE.channelId);
        said.push({
          text: activity.text,
          agentId: activity.agentId,
          id: source?.id ?? "",
          ...(activity.needsInput ? { needsInput: true } : {}),
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
        text: options.text ?? frameTaskBrief(ASK),
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

  test("records a long reply by how it ends, its next step, not how it starts", async () => {
    const opening = "I read Danny's email and the thread before it. ".repeat(6);
    const turn = turnWith(async () => ({
      replyText: `${opening}\n\n- Draft A: short\n- Draft B: warm\n\nShall I send draft A? It keeps the Friday date.`,
    }));
    await turn.start();
    expect(turn.said.at(-1)).toEqual({
      text: "Shall I send draft A?",
      needsInput: true,
      agentId: "openduet",
      id: "task-1:reply",
    });
  });

  test("reply chips mark a finished answer as waiting even without a question mark", async () => {
    const turn = turnWith(async () => ({
      replyText: "Choose a direction below.",
      replyChips: true,
    }));
    await turn.start();
    expect(turn.said.at(-1)?.needsInput).toBe(true);
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

  test("initial contention on the final attempt does not announce a terminal failure", async () => {
    const error = new ThreadLockBusyError(new Error("Thread lock denied"));
    const turn = turnWith(
      async () => {
        throw error;
      },
      { final: true },
    );
    await expect(turn.start()).rejects.toBe(error);
    expect(turn.said).toEqual([
      { text: ASK, agentId: null, id: "task-1:input" },
    ]);
    expect(turn.busy).toEqual([true, false]);
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

describe("a morning brief's turn", () => {
  test("puts no line of the person's on the roster, only the Bot's reply: nobody typed it", async () => {
    const brief = frameMorningBrief("Give me my morning brief.");
    const asked: Parameters<TurnRunner>[0][] = [];
    const turn = turnWith(
      async (input) => {
        asked.push(input);
        return { replyText: "Ana's Friday date is the one thing today." };
      },
      { text: brief },
    );
    await turn.start();
    // The model still reads the frame, as the person's message in the thread.
    expect(asked[0]?.userMessage).toMatchObject({
      id: "task-1",
      role: "user",
      content: brief,
    });
    expect(turn.said).toEqual([
      {
        text: "Ana's Friday date is the one thing today.",
        agentId: "openduet",
        id: "task-1:reply",
      },
    ]);
    expect(turn.busy).toEqual([true, false]);
  });
});

describe("the dev flag that fails task turns", () => {
  const folder = mkdtempSync(join(tmpdir(), "task-turn-"));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  test("fails every turn partway through while its file exists, and nothing once it is gone", async () => {
    const flag = join(folder, "fail");
    writeFileSync(flag, "");
    const asked: Parameters<TurnRunner>[0][] = [];
    // A run that starts for real, so the ask reaches the conversation, and stops when it is cut.
    const runTurn: TurnRunner = async (input) => {
      asked.push(input);
      input.onText?.("Here are");
      if (input.signal?.aborted)
        throw new Error("The headless turn was cancelled.");
      return { replyText: "Here are your notes." };
    };
    const failing = turnWith(runTurn, { final: true, failWhile: flag });
    await expect(failing.start()).rejects.toThrow("simulated");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.userMessage).toMatchObject({
      id: "task-1",
      content: frameTaskBrief(ASK),
    });
    expect(asked[0]?.signal?.aborted).toBe(true);
    expect(failing.said.at(-1)?.text).toBe(
      "I couldn't finish this: a service didn't answer.",
    );

    rmSync(flag);
    const fine = turnWith(runTurn, { final: true, failWhile: flag });
    await fine.start();
    expect(asked).toHaveLength(2);
    expect(asked[1]?.signal?.aborted).toBe(false);
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
    // Never the Bot in the third person: each reads after "I couldn't finish this:" too.
    expect(
      plainFailure("This Bot or its channel is no longer available to you."),
    ).toBe("this conversation is gone");
    expect(plainFailure("This Bot is paused.")).toBe("work is paused");
    expect(
      plainFailure(
        "This Bot uses gpt-x, which isn't an allowed model. Ask an admin to allow it.",
      ),
    ).toBe("the model isn't allowed here");
    expect(
      plainFailure("This turn failed before it could be tried again."),
    ).toBe("it failed before it could be tried again");
    expect(plainFailure("fetch failed")).toBe("a service didn't answer");
    expect(plainFailure("invalid x-api-key")).toBe(
      "the model provider turned the request away",
    );
    expect(plainFailure('429 {"error":{"type":"rate_limit"}} at line 3')).toBe(
      "something went wrong during the run",
    );
    // A run cut off by a crash leaves no error of its own.
    expect(plainFailure(null)).toBe("the run was cut off partway through");
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

describe(DEV_FAIL_TASKS_WHILE, () => {
  test("does nothing in production, whatever it names", () => {
    expect(
      devFailTasksWhile({
        [DEV_FAIL_TASKS_WHILE]: "/tmp/fail",
        NODE_ENV: "production",
      }),
    ).toBeUndefined();
    expect(devFailTasksWhile({ [DEV_FAIL_TASKS_WHILE]: "/tmp/fail" })).toBe(
      "/tmp/fail",
    );
    expect(devFailTasksWhile({ [DEV_FAIL_TASKS_WHILE]: " " })).toBeUndefined();
  });
});
