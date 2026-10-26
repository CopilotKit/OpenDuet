import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { frameTaskInput, frameTaskReply } from "@openbot/shared/task-brief";
import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import {
  ChatTranscript,
  seenMessageId,
} from "@/components/channels/chat-transcript";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import { settleReactWork } from "./settle-react-work";

/**
 * The thread's furniture: "Seen" under the person's newest message once the Bot has it, until the
 * Bot answers in words. No "is AI and can make mistakes" line under the thread: OpenDuet leaves it
 * out on purpose.
 */

let realFetch: typeof fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ enabled: true, requests: [], questions: [] })) as never;
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

const noRenderers = {
  copilotkit: { renderToolCalls: [], subscribe: () => ({ unsubscribe() {} }) },
  executingToolCallIds: new Set<string>(),
} as never;

function draw(messages: Message[], busy = false) {
  return render(
    <CopilotKitContext.Provider value={noRenderers}>
      <QueryClientProvider client={new QueryClient()}>
        <ChatTranscript busy={busy} messages={messages} />
      </QueryClientProvider>
    </CopilotKitContext.Provider>,
  );
}

const asked: Message = {
  id: "u1",
  role: "user",
  content: "Anything from Priya?",
};
const searching: Message = {
  id: "a1",
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id: "t1",
      type: "function",
      function: {
        name: "mcp__google-workspace__gmail_search_messages",
        arguments: "{}",
      },
    },
  ],
};
const answer: Message = {
  id: "a2",
  role: "assistant",
  content: "Yes. She needs your VAT sign-off by Thursday.",
};

describe("under the thread", () => {
  test("no line says the Bot is AI and can make mistakes", async () => {
    const view = draw([asked, answer]);
    await view.findByText(/She needs your VAT sign-off/);
    expect(view.queryByText(/can make mistakes/)).toBeNull();
  });
});

describe("Seen", () => {
  const seen = (messages: Message[]) =>
    seenMessageId(toVisibleChatItems(messages));

  test("sits under the person's newest message until the Bot answers it in words", () => {
    expect(seen([asked])).toBe("u1");
    // A tool step is not an answer.
    expect(seen([asked, searching])).toBe("u1");
    expect(seen([asked, searching, answer])).toBeNull();
    expect(seen([asked, answer])).toBeNull();
  });

  test("only on the newest of the person's messages", () => {
    const again: Message = { id: "u2", role: "user", content: "And Sam?" };
    expect(seen([asked, answer, again])).toBe("u2");
  });

  test("task retries keep execution outcomes without another person submission", () => {
    const words = "Friday";
    const messages: Message[] = [];
    const counts: number[] = [];
    const outcomes = [
      "Outcome A",
      "Outcome automatic",
      "Outcome retry",
      "Outcome B",
    ];
    const runs = ["accepted-a", "automatic-a", "try-again-a", "accepted-b"];
    for (const [index, run] of runs.entries()) {
      messages.push({
        id: run,
        role: "user",
        content: frameTaskInput(frameTaskReply("Move the kiln", words), {
          id: index === 3 ? "input-b" : "input-a",
          text: words,
        }),
      });
      const view = draw(messages, true);
      counts.push(view.getAllByText(words).length);
      expect(counts).toEqual([1, 1, 1, 2].slice(0, index + 1));
      // Seen reads the real projection before this execution has answered.
      expect(seenMessageId(toVisibleChatItems(messages))).toBe(
        index === 0 || index === 3 ? run : null,
      );
      expect(
        Array.from(
          view.container.querySelectorAll('[data-scroll-anchor="true"]'),
          (row) => row.getAttribute("data-message-id"),
        ),
      ).toEqual(index === 3 ? ["accepted-a", "accepted-b"] : ["accepted-a"]);
      cleanup();
      messages.push({
        id: `outcome-${run}`,
        role: "assistant",
        content: outcomes[index],
      });
    }
    expect(counts).toEqual([1, 1, 1, 2]);
    const view = draw(messages);
    expect(
      view.getAllByText(/^Outcome /).map((node) => node.textContent),
    ).toEqual(outcomes);
    expect(view.getAllByText(words)).toHaveLength(2);
  });

  test("is drawn once the thread holds still, and survives a reload mid-turn", async () => {
    // A reload mid-turn restores the thread with the question unanswered and nothing running.
    const view = draw([asked, searching], false);
    expect(view.queryByText("Seen")).toBeNull();
    expect(await view.findByText("Seen")).toBeTruthy();
    cleanup();
    const answered = draw([asked, answer]);
    await answered.findByText(/She needs your VAT sign-off/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(answered.queryByText("Seen")).toBeNull();
  });

  test("history replaying in does not flash it under older messages", async () => {
    const older: Message[] = [
      { id: "u0", role: "user", content: "Who is Priya?" },
      { id: "a0", role: "assistant", content: "Your accountant." },
      asked,
      answer,
    ];
    const view = draw(older.slice(0, 1));
    // The rest arrives a moment later, as a replay does.
    await new Promise((resolve) => setTimeout(resolve, 50));
    view.rerender(
      <CopilotKitContext.Provider value={noRenderers}>
        <QueryClientProvider client={new QueryClient()}>
          <ChatTranscript messages={older} />
        </QueryClientProvider>
      </CopilotKitContext.Provider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(view.queryByText("Seen")).toBeNull();
  });
});

describe("the Bot's words", () => {
  test("a bubble draws at the body size, not the primitive's small text", async () => {
    const view = draw([asked, answer]);
    const bubble = (
      await view.findByText(/She needs your VAT sign-off/)
    ).closest('[data-slot="bubble-content"]') as HTMLElement;
    expect(bubble.className).toContain("type-body");
    expect(bubble.className).not.toMatch(/\btext-sm\b|\bleading-relaxed\b/);
  });

  test("separate thoughts are separate bubbles, 8px apart", async () => {
    const view = draw([
      asked,
      {
        id: "a3",
        role: "assistant",
        content:
          "Yes, Priya wrote twice.\n\nShe needs your sign-off by Thursday. Want me to draft it?",
      },
    ]);
    await view.findByText("Yes, Priya wrote twice.");
    const bubbles = view.container.querySelectorAll(
      '[data-slot="bubble-content"]',
    );
    // The person's question, then the Bot's two thoughts.
    expect(bubbles).toHaveLength(3);
    const column = bubbles[1]?.closest(".gap-2");
    expect(column?.contains(bubbles[2] as Node)).toBe(true);
  });
});
