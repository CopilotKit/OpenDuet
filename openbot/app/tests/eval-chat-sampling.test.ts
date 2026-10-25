import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readChatSnapshot } from "../../scripts/evals/chat-browser";
import {
  type ChatSnapshot,
  type CompletedReply,
  completedReplies,
  type FailedReply,
  sampleBatch,
  samplingFailureReport,
  waitForReply,
} from "../../scripts/evals/chat-sampling";

const question = "Did Sam email me?";
const snapshot = (changes: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  turn: "idle",
  questionVisible: true,
  approval: false,
  stopped: null,
  bubbles: ["Sam emailed about the order."],
  chips: [],
  listItems: 0,
  ...changes,
});
const completed = (ask = question): CompletedReply => ({
  status: "completed",
  ask,
  channelId: "test-channel",
  elapsedMs: 3000,
  bubbles: ["Sam emailed about the order."],
  chips: [],
  listItems: 0,
});
const failed: FailedReply = {
  status: "failed",
  ask: question,
  channelId: "test-channel",
  reason: "timeout",
  detail: "The turn did not settle within 10000ms.",
  elapsedMs: 10_000,
  lastSnapshot: snapshot({ turn: "busy", bubbles: ["Sam emailed about"] }),
};

function sample(read: (elapsedMs: number) => ChatSnapshot) {
  let elapsedMs = 0;
  return waitForReply({
    ask: question,
    channelId: "test-channel",
    timeoutMs: 10_000,
    read: async () => read(elapsedMs),
    now: () => elapsedMs,
    wait: async (ms) => {
      elapsedMs += ms;
    },
  });
}

describe("chat eval completion contract", () => {
  test("waits for the actual turn to settle even when answer text stays unchanged", async () => {
    const result = await sample((ms) =>
      snapshot({ turn: ms < 6000 ? "busy" : "idle" }),
    );
    expect(result.status).toBe("completed");
    expect(result.elapsedMs).toBe(9000);
    expect(completedReplies([result], [question])).toHaveLength(1);
  });

  test("accepts a fast completed ordinary answer even if polling missed its busy interval", async () => {
    const result = await sample(() => snapshot());
    expect(result.status).toBe("completed");
    expect(result.elapsedMs).toBe(3000);
  });

  test("rejects a timeout with partial answer text and preserves failure evidence", async () => {
    const result = await sample(() =>
      snapshot({ turn: "busy", bubbles: ["Sam emailed about"] }),
    );
    expect(result).toMatchObject({
      status: "failed",
      reason: "timeout",
      elapsedMs: 10_000,
    });
    expect(completedReplies([result], [question])).toBeNull();
    const report = samplingFailureReport([result], [question, "Next question"]);
    expect(report).toContain("Sam emailed about");
    expect(report).toContain("test-channel");
    expect(report).toContain('"unattempted": [\n    "Next question"');
    expect(report).toContain("metrics were not calculated");
  });

  test("approval pauses cannot complete even with a full-looking answer", async () => {
    const result = await sample(() => snapshot({ approval: true }));
    expect(result).toMatchObject({ status: "failed", reason: "approval" });
    expect(completedReplies([result], [question])).toBeNull();
  });

  test("a stopped/failed turn cannot score its partial prose", async () => {
    const result = await sample(() =>
      snapshot({ stopped: "The Bot stopped responding." }),
    );
    expect(result).toMatchObject({
      status: "failed",
      reason: "stopped",
      detail: "The Bot stopped responding.",
    });
  });

  test.each([{ bubbles: [] }, { bubbles: ["  \n "] }])(
    "rejects empty settled answers: %j",
    async ({ bubbles }) => {
      const result = await sample(() => snapshot({ bubbles: [...bubbles] }));
      expect(result).toMatchObject({ status: "failed", reason: "empty" });
      expect(completedReplies([result], [question])).toBeNull();
    },
  );

  test("same bubble count is insufficient while text keeps streaming", async () => {
    const result = await sample((ms) =>
      snapshot({ bubbles: [`Still writing ${ms}`] }),
    );
    expect(result).toMatchObject({ status: "failed", reason: "timeout" });
  });

  test("content changes restart the idle settling interval", async () => {
    const result = await sample((ms) =>
      snapshot({
        bubbles: [ms < 2000 ? "Sam emailed" : "Sam emailed about the order."],
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.elapsedMs).toBe(5000);
  });

  test("a new busy interval resets settling even without new bubbles", async () => {
    const result = await sample((ms) =>
      snapshot({ turn: ms >= 2000 && ms < 6000 ? "busy" : "idle" }),
    );
    expect(result.status).toBe("completed");
    expect(result.elapsedMs).toBe(9000);
  });

  test.each([
    snapshot({ turn: "unknown" }),
    snapshot({ questionVisible: false }),
  ])(
    "missing turn state or submitted question never becomes a success",
    async (state) => {
      expect(await sample(() => state)).toMatchObject({
        status: "failed",
        reason: "timeout",
      });
    },
  );

  test("a read crossing the deadline cannot pass", async () => {
    let elapsedMs = 0;
    const result = await waitForReply({
      ask: question,
      channelId: "test-channel",
      timeoutMs: 4000,
      now: () => elapsedMs,
      read: async () => {
        if (elapsedMs === 3000) elapsedMs = 4000;
        return snapshot();
      },
      wait: async (ms) => {
        elapsedMs += ms;
      },
    });
    expect(result).toMatchObject({ status: "failed", reason: "timeout" });
  });

  test("read errors fail with the last observed partial answer", async () => {
    const result = await sample((ms) => {
      if (ms > 0) throw new Error("Page closed during the turn");
      return snapshot({ turn: "busy" });
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "error",
      detail: "Page closed during the turn",
      lastSnapshot: { turn: "busy" },
    });
  });

  test("two examples cannot mask twelve missing everyday answers", () => {
    const questions = Array.from(
      { length: 14 },
      (_, index) => `Question ${index}`,
    );
    const replies = questions.map((ask, index) => ({
      ...completed(ask),
      bubbles: index < 2 ? ["An answer."] : [],
    }));
    expect(completedReplies(replies, questions)).toBeNull();
    expect(
      completedReplies(
        questions.map((ask) => completed(ask)),
        questions,
      ),
    ).toHaveLength(14);
    expect(completedReplies(replies.slice(0, 2), questions)).toBeNull();
  });

  test("missing, duplicate or out-of-order questions do not satisfy the batch", () => {
    expect(completedReplies([], [])).toBeNull();
    expect(
      completedReplies([completed(), completed()], [question, "Next question"]),
    ).toBeNull();
  });

  test("a failed sample closes the browser and never starts the next question", async () => {
    const asked: string[] = [];
    let closed = 0;
    const replies = await sampleBatch({
      questions: [question, "Next question"],
      open: async () => "page",
      ask: async (_page, ask) => {
        asked.push(ask);
        return failed;
      },
      close: async () => {
        closed++;
      },
    });
    expect(replies).toEqual([failed]);
    expect(asked).toEqual([question]);
    expect(closed).toBe(1);
  });

  test.each(["open", "ask"])(
    "closes the browser if %s throws",
    async (stage) => {
      let closed = 0;
      const operation = sampleBatch({
        questions: [question],
        open: async () => {
          if (stage === "open") throw new Error("open failed");
          return "page";
        },
        ask: async () => {
          throw new Error("ask failed");
        },
        close: async () => {
          closed++;
        },
      });
      await expect(operation).rejects.toThrow(`${stage} failed`);
      expect(closed).toBe(1);
    },
  );
});

describe("chat eval reads the app's actual turn markers", () => {
  beforeAll(() => GlobalRegistrator.register());
  afterAll(() => GlobalRegistrator.unregister());
  beforeEach(() => {
    document.body.innerHTML = `
      <form aria-busy="false"><textarea></textarea></form>
      <div data-slot="message" data-align="end"><div data-slot="bubble-content">${question}</div></div>
      <div data-slot="message" data-align="start"><div data-slot="bubble-content">Sam emailed about the order.</div></div>
    `;
  });

  test("finds the submitted question and assistant prose independently", () => {
    expect(readChatSnapshot(question)).toEqual(snapshot());
    document.querySelector('[data-align="end"]')?.remove();
    expect(readChatSnapshot(question).questionVisible).toBe(false);
    expect(readChatSnapshot(question).bubbles).toEqual([
      "Sam emailed about the order.",
    ]);
  });

  test("composer pending, transcript busy and Stop all prevent idle", () => {
    const form = document.querySelector("form")!;
    form.setAttribute("aria-busy", "true");
    expect(readChatSnapshot(question).turn).toBe("busy");
    form.setAttribute("aria-busy", "false");
    const transcript = document.createElement("div");
    transcript.setAttribute("aria-busy", "true");
    document.body.append(transcript);
    expect(readChatSnapshot(question).turn).toBe("busy");
    transcript.remove();
    const stop = document.createElement("button");
    stop.setAttribute("aria-label", "Stop the Bot");
    document.body.append(stop);
    expect(readChatSnapshot(question).turn).toBe("busy");
    stop.remove();
    form.removeAttribute("aria-busy");
    expect(readChatSnapshot(question).turn).toBe("unknown");
  });

  test("reads the transcript's real failure notice", () => {
    const error = document.createElement("p");
    error.dataset.testid = "transcript-stopped";
    error.textContent = "The Bot stopped responding.";
    document.body.append(error);
    expect(readChatSnapshot(question).stopped).toBe(
      "The Bot stopped responding.",
    );
  });
});
