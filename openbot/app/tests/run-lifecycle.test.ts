import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { frameFirstDay } from "@/lib/channels/first-day";
import { followTurn, joinOrFollow, liveRun } from "@/lib/channels/follow-turn";
import {
  APPROVAL_DECIDED_RESULT,
  APPROVAL_WAITING_RESULT,
  claimSeed,
  firstDayAsked,
  forgetSeedClaims,
  interruptsToAnswer,
  isThreadBusyError,
  isApprovalWaitingResult,
  isThreadLocked,
  sayableReason,
  seedStillNeeded,
  staleApprovalWaits,
  ThreadBusyError,
  waitingToolCalls,
  withApprovalWaits,
  withoutMessages,
} from "@/lib/channels/run-lifecycle";

describe("isThreadLocked", () => {
  test("reads the realtime runtime's lock error, the HTTP 409 and the server's own words", () => {
    const realtime = new Error(
      "Thread bfd62df0-0381-8137-94f5-bd3d76728013 is locked",
    );
    realtime.name = "AgentThreadLockedError";
    const http = Object.assign(
      new Error('HTTP 409: {"error":"Thread lock denied"}'),
      { status: 409 },
    );
    expect(isThreadLocked(realtime)).toBe(true);
    expect(isThreadLocked(http)).toBe(true);
    expect(isThreadLocked(new Error("Thread lock denied"))).toBe(true);
  });

  test("is not every failure", () => {
    expect(isThreadLocked(new Error("The model refused the request."))).toBe(
      false,
    );
    expect(isThreadLocked("Thread lock denied")).toBe(false);
    expect(isThreadLocked(null)).toBe(false);
  });
});

describe("ThreadBusyError", () => {
  test("says the parity spec's sentence and is recognised by name", () => {
    const error = new ThreadBusyError();
    expect(error.message).toBe(
      "OpenDuet is still finishing something. I'll send this next.",
    );
    expect(isThreadBusyError(error)).toBe(true);
    expect(isThreadBusyError(new Error(error.message))).toBe(false);
  });
});

describe("interruptsToAnswer", () => {
  test("drops the approvals inbox's own waits and keeps the rest", () => {
    const approval = {
      id: "toolu_1",
      reason: "human_input",
      metadata: { openbotWaiting: { approvalId: "a1" } },
    };
    const other = { id: "ask-1", reason: "confirm" };
    expect(interruptsToAnswer([approval, other])).toEqual([other]);
    expect(interruptsToAnswer([approval])).toEqual([]);
  });

  test("hands back the same array when there is nothing to drop", () => {
    const interrupts = [{ id: "ask-1", reason: "confirm", metadata: {} }];
    expect(interruptsToAnswer(interrupts)).toBe(interrupts);
  });
});

describe("withoutMessages", () => {
  const messages = [
    { id: "a", role: "user", content: "one" },
    { id: "b", role: "user", content: "two" },
  ] satisfies Message[];

  test("takes out what a turn added", () => {
    expect(withoutMessages(messages, new Set(["b"]))).toEqual([messages[0]]);
  });

  test("is the same array when none of it is there", () => {
    expect(withoutMessages(messages, new Set(["z"]))).toBe(messages);
  });
});

describe("first day", () => {
  const framed = frameFirstDay("Read my mail and tell me how you can help.");
  const asked: Message = { id: "u1", role: "user", content: framed };

  test("a thread holding a first-day request has been asked", () => {
    expect(firstDayAsked([asked])).toBe(true);
    expect(
      firstDayAsked([
        { id: "u2", role: "user", content: [{ type: "text", text: framed }] },
      ]),
    ).toBe(true);
    expect(firstDayAsked([{ id: "u3", role: "user", content: "Hello" }])).toBe(
      false,
    );
  });

  test("a first-day seed is not sent into a thread that already has one", () => {
    expect(seedStillNeeded(framed, [asked])).toBe(false);
    expect(seedStillNeeded(framed, [])).toBe(true);
  });

  test("a person's own first message is always still needed", () => {
    expect(seedStillNeeded("Book the kiln", [asked])).toBe(true);
  });
});

describe("claimSeed", () => {
  test("claims a channel's creating message once per page", () => {
    forgetSeedClaims();
    expect(claimSeed("c1")).toBe(true);
    expect(claimSeed("c1")).toBe(false);
    expect(claimSeed("c2")).toBe(true);
    forgetSeedClaims();
    expect(claimSeed("c1")).toBe(true);
    forgetSeedClaims();
  });
});

describe("sayableReason", () => {
  test("never passes on a thread id, a tool call id or a transport line", () => {
    for (const raw of [
      "Thread bfd62df0-0381-8137-94f5-bd3d76728013 is locked",
      "Thread has 1 pending interrupt(s) not addressed by resume: toolu_01FNPKUh78",
      'HTTP 502: {"error":"Failed to initialize thread"}',
      "REST run request failed: fetch failed",
      "Failed to fetch",
      "TypeError: NetworkError when attempting to fetch resource.",
    ]) {
      expect(sayableReason(raw)).toBe("Couldn't reach the Bot. Try again.");
    }
  });

  test("keeps a sentence written for people", () => {
    const said = "The Bot stopped responding, so this turn was ended.";
    expect(sayableReason(said)).toBe(said);
  });

  test("a model that could not be reached is said plainly, never in the SDK's words", () => {
    // What the release review saw, word for word: "the computer" is Bun's, not a Bot's computer.
    const seen =
      "Failed after 3 attempts. Last error: Cannot connect to API: Unable to connect. Is the computer able to access the url?";
    expect(sayableReason(seen)).toBe(
      "Couldn't reach the AI model. Check your internet connection, then try again.",
    );
    expect(sayableReason(seen)).not.toContain("computer");
  });

  test("each kind of model failure gets its own next step", () => {
    expect(sayableReason("The operation timed out.")).toBe(
      "That took too long, so it was stopped. Try again.",
    );
    // The retry wrapper names the cause last, and the cause is what is said.
    expect(
      sayableReason("Failed after 3 attempts. Last error: Overloaded"),
    ).toBe("The AI model is busy right now. Try again in a minute.");
    expect(sayableReason("429 Too Many Requests: rate limit reached")).toBe(
      "The AI model is busy right now. Try again in a minute.",
    );
    expect(sayableReason("401 invalid x-api-key")).toBe(
      "The AI model didn't accept this install's key. An admin needs to update it.",
    );
  });

  test("a bare connection error with no model in it is the Bot's endpoint", () => {
    for (const raw of [
      "Unable to connect. Is the computer able to access the url?",
      "connect ECONNREFUSED 127.0.0.1:4210",
      "fetch failed",
    ]) {
      expect(sayableReason(raw)).toBe("Couldn't reach the Bot. Try again.");
    }
  });
});

describe("joinOrFollow", () => {
  const never = new Promise<void>(() => {});

  test("a join that finishes in time is over", async () => {
    const { live } = await joinOrFollow({
      connect: Promise.resolve(),
      deadline: never,
      detach: async () => {
        throw new Error("not asked");
      },
      runOpen: () => true,
    });
    expect(live).toBeNull();
  });

  test("at the deadline, a join with a run open is kept, not ended", async () => {
    let finish: () => void = () => {};
    const connect = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let detached = false;
    const { live } = await joinOrFollow({
      connect,
      deadline: Promise.resolve(),
      detach: async () => {
        detached = true;
      },
      runOpen: () => true,
    });
    expect(live).not.toBeNull();
    expect(detached).toBe(false);
    let over = false;
    void live?.then(() => {
      over = true;
    });
    await Promise.resolve();
    expect(over).toBe(false);
    finish();
    await live;
    expect(over).toBe(true);
  });

  test("at the deadline, a join with no run open is ended", async () => {
    let finish: () => void = () => {};
    const connect = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let detached = false;
    const { live } = await joinOrFollow({
      connect,
      deadline: Promise.resolve(),
      detach: async () => {
        detached = true;
        finish();
      },
      runOpen: () => false,
    });
    expect(live).toBeNull();
    expect(detached).toBe(true);
  });
});

describe("followTurn", () => {
  test("joins again until the turn has landed", async () => {
    let joins = 0;
    let landed = false;
    await followTurn({
      connect: async () => {
        joins += 1;
        if (joins === 3) landed = true;
      },
      done: () => landed,
      stopped: () => false,
      wait: async () => {},
      retryMs: 1,
      maxMs: 60_000,
    });
    expect(joins).toBe(3);
  });

  test("finishes a join already streaming before starting another", async () => {
    const order: string[] = [];
    await followTurn({
      first: Promise.resolve().then(() => order.push("first")),
      connect: async () => {
        order.push("connect");
      },
      stopped: () => false,
      wait: async () => {},
      retryMs: 1,
      maxMs: 60_000,
    });
    expect(order).toEqual(["first"]);
  });

  test("gives the conversation back after the longest wait, and on Stop", async () => {
    let clock = 0;
    let joins = 0;
    await followTurn({
      connect: async () => {
        joins += 1;
      },
      done: () => false,
      stopped: () => false,
      wait: async (ms) => {
        clock += ms;
      },
      retryMs: 1000,
      maxMs: 5000,
      now: () => clock,
    });
    expect(joins).toBe(6);

    let stops = 0;
    await followTurn({
      connect: async () => {
        stops += 1;
      },
      done: () => false,
      stopped: () => stops >= 2,
      wait: async () => {},
      retryMs: 1,
      maxMs: 60_000,
    });
    expect(stops).toBe(2);
  });

  test("a join that throws is a join that is over", async () => {
    let joins = 0;
    await followTurn({
      connect: async () => {
        joins += 1;
        if (joins === 1) throw new Error("socket closed");
      },
      done: () => joins >= 2,
      stopped: () => false,
      wait: async () => {},
      retryMs: 1,
      maxMs: 60_000,
    });
    expect(joins).toBe(2);
  });
});

describe("liveRun", () => {
  const realFetch = globalThis.fetch;
  let asked: { url: string; body: unknown }[] = [];
  afterEach(() => {
    globalThis.fetch = realFetch;
    asked = [];
  });
  function answer(response: () => Response) {
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        asked.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return response();
      },
      { preconnect: realFetch.preconnect },
    );
  }
  const where = { agentId: "openduet", threadId: "thread-1" };

  test("asks the runtime's join for the thread, and reads the run holding it", async () => {
    answer(() => Response.json({ threadId: "thread-1", runId: "run-9" }));
    expect(await liveRun(where)).toBe("run-9");
    expect(asked[0]?.url).toBe("/api/copilotkit/agent/openduet/connect");
    expect(asked[0]?.body).toMatchObject({
      threadId: "thread-1",
      forwardedProps: { openbotAsk: "live-run" },
    });
  });

  test("an answer with no run, or no thread yet, is an idle thread", async () => {
    answer(() => Response.json({ threadId: "thread-1", joinToken: "t" }));
    expect(await liveRun(where)).toBeNull();
    answer(() => new Response(null, { status: 204 }));
    expect(await liveRun(where)).toBeNull();
  });

  test("cannot say when the join answers with a replay, fails, or is unreachable", async () => {
    answer(
      () =>
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    expect(await liveRun(where)).toBeUndefined();
    answer(() => new Response("down", { status: 502 }));
    expect(await liveRun(where)).toBeUndefined();
    answer(() => {
      throw new Error("offline");
    });
    expect(await liveRun(where)).toBeUndefined();
  });
});

describe("approval waits in the history sent to the model", () => {
  const ask = {
    id: "ask",
    role: "assistant",
    toolCalls: [
      {
        id: "call-send",
        type: "function",
        function: { name: "gmail_send_reply", arguments: "{}" },
      },
    ],
  } as Message;
  const question: Message = { id: "q", role: "user", content: "Who is Leo?" };
  let minted = 0;
  const mint = () => `minted-${++minted}`;

  test("the inbox's waits name their calls", () => {
    expect(
      waitingToolCalls([
        {
          id: "toolu_1",
          metadata: { openbotWaiting: { approvalId: "a" } },
        },
        {
          id: "i2",
          toolCallId: "call-2",
          metadata: { openbotWaiting: {} },
        },
        { id: "ask-3", metadata: {} },
      ]),
    ).toEqual(new Set(["toolu_1", "call-2"]));
  });

  test("a call still waiting in its card is answered with the truth, right after the call", () => {
    const sent = withApprovalWaits(
      [ask, question],
      new Set(["call-send"]),
      mint,
    );
    expect(sent.map((message) => message.id)).toEqual([
      "ask",
      expect.stringMatching(/^minted-/),
      "q",
    ]);
    expect(sent[1]).toMatchObject({
      role: "tool",
      toolCallId: "call-send",
      content: APPROVAL_WAITING_RESULT,
    });
    expect(isApprovalWaitingResult(sent[1] as Message)).toBe(true);
    expect(APPROVAL_WAITING_RESULT).not.toMatch(/interrupted/i);
  });

  test("once the action's real result arrives, it takes the placeholder's place", () => {
    const placeholder = {
      id: "wait",
      role: "tool",
      toolCallId: "call-send",
      content: APPROVAL_WAITING_RESULT,
    } as Message;
    const real = {
      id: "real",
      role: "tool",
      toolCallId: "call-send",
      content: "Sent.",
    } as Message;
    const reply: Message = {
      id: "r",
      role: "assistant",
      content: "Sent to Ana.",
    };
    const sent = withApprovalWaits(
      [ask, placeholder, question, real, reply],
      new Set(),
      mint,
    );
    expect(sent.map((message) => message.id)).toEqual([
      "ask",
      "real",
      "q",
      "r",
    ]);
  });

  test("a placeholder whose card was decided, with no result here yet, says so without inventing one", () => {
    const placeholder = {
      id: "wait",
      role: "tool",
      toolCallId: "call-send",
      content: APPROVAL_WAITING_RESULT,
    } as Message;
    expect(staleApprovalWaits([ask, placeholder], new Set())).toBe(true);
    expect(staleApprovalWaits([ask, placeholder], new Set(["call-send"]))).toBe(
      false,
    );
    const sent = withApprovalWaits(
      [ask, placeholder, question],
      new Set(),
      mint,
    );
    expect(sent[1]).toMatchObject({
      id: "wait",
      content: APPROVAL_DECIDED_RESULT,
    });
    // Still waiting: unchanged.
    const waiting = [ask, placeholder, question];
    expect(withApprovalWaits(waiting, new Set(["call-send"]), mint)).toBe(
      waiting,
    );
  });

  test("nothing waiting and nothing to settle is the same array", () => {
    const messages = [ask, question];
    expect(withApprovalWaits(messages, new Set(), mint)).toBe(messages);
    const answered = [
      ask,
      { id: "t", role: "tool", toolCallId: "call-send", content: "Sent." },
    ] as Message[];
    expect(withApprovalWaits(answered, new Set(["call-send"]), mint)).toBe(
      answered,
    );
  });
});
