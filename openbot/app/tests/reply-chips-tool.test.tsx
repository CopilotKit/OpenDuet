import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComposerDraft } from "@/components/channels/composer/draft";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  ReplyChips,
  ReplyChipsTool,
  readReplies,
} from "@/lib/copilot/reply-chips-tool";
import { settleReactWork } from "./settle-react-work";

/**
 * The chips as a person meets them: drawn by the real renderer, in the real transcript, under the
 * real provider, and sent through the conversation's own submit. What reaches `onSubmit` is what
 * the Bot would be sent.
 */

/** The composer asks for the deployment's capabilities; nothing here depends on the answer. */
const originalFetch = globalThis.fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "Not found" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const ACK =
  "The buttons are on screen, under the last thing you write this turn.";

/** As the server holds a call made beside a read (server/src/openduet/reply-turn.ts), encoded. */
const HELD = JSON.stringify(
  "The buttons are held: they appear under the last thing you write this turn. Nothing is on the person's screen yet, not even what you read. Write your full answer now, as you would with no buttons: what you found, what you recommend, and a short question that doesn't list the choices. Don't call suggest_replies again, and don't mention the buttons.",
);

/** The person asks, the Bot asks back and offers three replies. */
function asked(
  result = ACK,
  question = "Ana needs the ship date, and Hearth & Co moved the visit. Which first?",
): Message[] {
  return [
    { id: "u1", role: "user", content: "What needs me this morning?" },
    {
      id: "a1",
      role: "assistant",
      content: question,
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "suggest_replies",
            arguments: JSON.stringify({
              replies: ["Ana's ship date", "The visit", "Not now"],
            }),
          },
        },
      ],
    },
    { id: "t1", role: "tool", toolCallId: "call-1", content: result },
  ];
}

/**
 * The app's query client, as `main.tsx` provides it. Until `ReplyChipsTool` registers its renderer,
 * the call draws as a plain server line, and that line asks the approvals inbox whether the call is
 * waiting on the person. Every request here answers 404, so nothing is.
 */
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Chat({
  messages,
  sent,
}: {
  messages: Message[];
  sent: ComposerDraft[];
}) {
  return (
    <QueryClientProvider client={queries}>
      <CopilotKitProvider>
        <ReplyChipsTool />
        <ConversationView
          messages={messages}
          onSubmit={(draft) => {
            sent.push(draft);
          }}
          queueWhileBusy
        />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

describe("reading the call", () => {
  test("takes the replies the server accepted, and nothing while it runs or when it refused", () => {
    const args = { replies: [" Yes ", "No", "No", ""] };
    expect(readReplies(args, ACK)).toEqual(["Yes", "No"]);
    // As the runtime delivers a server tool's text: encoded once more.
    expect(readReplies(args, JSON.stringify(ACK))).toEqual(["Yes", "No"]);
    expect(readReplies(args, undefined)).toBe(null);
    expect(
      readReplies(
        args,
        "Refused. suggest_replies takes two or three different replies, each at most 40 characters.",
      ),
    ).toBe(null);
    // Replies the runtime rejected before the tool ran (too long for a chip): it answers for the
    // tool, unencoded, and nothing was accepted.
    expect(
      readReplies(
        args,
        'Error: Invalid input for tool suggest_replies: Type validation failed: Value: {"replies":["Draft a yes to all 200 mugs for next Tuesday","No"]}.',
      ),
    ).toBe(null);
    expect(readReplies({ replies: "Yes" }, ACK)).toBe(null);
    expect(readReplies(undefined, ACK)).toBe(null);
  });
});

describe("the chips", () => {
  test("are drawn under the Bot's question, and a tap sends that reply as the person's message", async () => {
    const sent: ComposerDraft[] = [];
    const user = userEvent.setup({ document });
    const view = render(<Chat messages={asked()} sent={sent} />);

    const group = await view.findByRole("group", { name: "Suggested replies" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "Ana's ship date",
      "The visit",
      "Not now",
    ]);
    expect(chips.every((chip) => !(chip as HTMLButtonElement).disabled)).toBe(
      true,
    );

    await user.click(within(group).getByRole("button", { name: "The visit" }));

    expect(sent.map((draft) => draft.text)).toEqual(["The visit"]);
    expect(sent[0]).toEqual(
      expect.objectContaining({
        agentId: null,
        commandIds: [],
        attachments: [],
      }),
    );
    // Spent: the tapped one is marked, and none of them sends again.
    const after = within(group).getAllByRole("button");
    expect(after.every((chip) => (chip as HTMLButtonElement).disabled)).toBe(
      true,
    );
    expect(
      within(group)
        .getByRole("button", { name: "The visit" })
        .getAttribute("data-chosen"),
    ).toBe("true");
    await user.click(within(group).getByRole("button", { name: "Not now" }));
    expect(sent).toHaveLength(1);
  });

  test("are reached and pressed from the keyboard", async () => {
    const sent: ComposerDraft[] = [];
    const user = userEvent.setup({ document });
    const view = render(<Chat messages={asked()} sent={sent} />);
    const group = await view.findByRole("group", { name: "Suggested replies" });
    const first = within(group).getByRole("button", {
      name: "Ana's ship date",
    });

    first.focus();
    expect(document.activeElement).toBe(first);
    await user.tab();
    expect(document.activeElement).toBe(
      within(group).getByRole("button", { name: "The visit" }),
    );
    await user.keyboard("{Enter}");

    expect(sent.map((draft) => draft.text)).toEqual(["The visit"]);
  });

  test("stand under the Bot's question even when it asked after calling for them", async () => {
    // The call carries no words; the question comes in the step after it.
    const view = render(
      <Chat
        messages={[
          ...asked(ACK, ""),
          { id: "a2", role: "assistant", content: "Which one first?" },
        ]}
        sent={[]}
      />,
    );

    const group = await view.findByRole("group", { name: "Suggested replies" });
    const question = view.getByText("Which one first?");
    expect(
      question.compareDocumentPosition(group) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("can't be pressed once the person has said something since", async () => {
    const sent: ComposerDraft[] = [];
    const later: Message[] = [
      ...asked(),
      { id: "u2", role: "user", content: "Actually, the glaze order." },
      { id: "a2", role: "assistant", content: "On it." },
    ];
    const user = userEvent.setup({ document });
    const view = render(<Chat messages={later} sent={sent} />);

    const group = await view.findByRole("group", { name: "Suggested replies" });
    const chips = within(group).getAllByRole("button");
    expect(chips.every((chip) => (chip as HTMLButtonElement).disabled)).toBe(
      true,
    );
    await user.click(chips[0] as HTMLElement);
    expect(sent).toEqual([]);
  });

  test("go quiet the moment the person types their own answer", async () => {
    const sent: ComposerDraft[] = [];
    const view = render(<Chat messages={asked()} sent={sent} />);
    const group = await view.findByRole("group", { name: "Suggested replies" });
    expect(
      (within(group).getAllByRole("button")[0] as HTMLButtonElement).disabled,
    ).toBe(false);

    view.rerender(
      <Chat
        messages={[
          ...asked(),
          { id: "u2", role: "user", content: "Neither, call Ana." },
        ]}
        sent={sent}
      />,
    );

    const chips = within(
      view.getByRole("group", { name: "Suggested replies" }),
    ).getAllByRole("button");
    expect(chips.every((chip) => (chip as HTMLButtonElement).disabled)).toBe(
      true,
    );
  });

  test("a refused call draws no chips", async () => {
    const sent: ComposerDraft[] = [];
    const view = render(
      <Chat
        messages={asked(
          "Refused. suggest_replies takes two or three different replies, each at most 40 characters.",
        )}
        sent={sent}
      />,
    );
    await view.findByText(/Which first\?/);
    await settleReactWork();
    expect(view.queryByRole("group", { name: "Suggested replies" })).toBe(null);
  });

  test("a held call draws nothing until the Bot's words follow it, so no choice shows before its answer", async () => {
    // While the read and the answer are still on the way: the person's message and the call only.
    // Drawn here, the chips sat live under "Thinking it through…" for seconds, the collapse's picture.
    const rows = (view: ReturnType<typeof render>) =>
      view.container.querySelectorAll('[data-slot="message-scroller-item"]')
        .length;
    const view = render(<Chat messages={asked(HELD, "")} sent={[]} />);
    await view.findByText(/What needs me this morning\?/);
    await settleReactWork();
    expect(view.queryByRole("group", { name: "Suggested replies" })).toBe(null);
    for (const reply of ["Ana's ship date", "The visit", "Not now"])
      expect(view.queryByRole("button", { name: reply })).toBe(null);
    // No empty row for it either: the person's message is the only row.
    expect(rows(view)).toBe(1);

    // The answer arrives, and the chips come with it, under it.
    view.rerender(
      <Chat
        messages={[
          ...asked(HELD, ""),
          { id: "a2", role: "assistant", content: "Which first?" },
        ]}
        sent={[]}
      />,
    );
    const group = await view.findByRole("group", { name: "Suggested replies" });
    expect(
      view.getByText("Which first?").compareDocumentPosition(group) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("a call held until the answer is written is drawn under that answer", async () => {
    // As the server holds a call made beside a read (server/src/openduet/reply-turn.ts): the call
    // carries no words, and the answer comes in the step after it.
    const held = HELD;
    const view = render(
      <Chat
        messages={[
          ...asked(held, ""),
          {
            id: "a2",
            role: "assistant",
            content:
              "Ana needs the ship date by end of day, and Hearth & Co moved the visit to Thursday. Which first?",
          },
        ]}
        sent={[]}
      />,
    );

    const group = await view.findByRole("group", { name: "Suggested replies" });
    const answer = view.getByText(/Ana needs the ship date/);
    expect(
      answer.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("a refused call, such as a second set in one turn, draws nothing at all, not even an empty row", async () => {
    // As the server refuses a second set (server/src/openduet/reply-turn.ts), and as the thread
    // stores it: the tool's text, encoded once more.
    const refused = JSON.stringify(
      "Refused. The buttons are already on screen. End your turn now and write nothing more.",
    );
    const rows = (view: ReturnType<typeof render>) =>
      view.container.querySelectorAll('[data-slot="message-scroller-item"]')
        .length;

    const without = render(
      <Chat messages={asked(ACK).filter((m) => m.role !== "tool")} sent={[]} />,
    );
    await without.findByText(/Which first\?/);
    await settleReactWork();
    // The person's message and the Bot's question; the call with no answer yet draws no row either.
    const expected = rows(without);
    expect(expected).toBe(2);
    cleanup();

    const view = render(<Chat messages={asked(refused)} sent={[]} />);
    await view.findByText(/Which first\?/);
    await settleReactWork();
    expect(view.queryByRole("group", { name: "Suggested replies" })).toBe(null);
    for (const reply of ["Ana's ship date", "The visit", "Not now"])
      expect(view.queryByRole("button", { name: reply })).toBe(null);
    expect(rows(view)).toBe(expected);
  });

  test("draw nothing outside a conversation, where there is nowhere to send", () => {
    const view = render(
      <ReplyChips replies={["Yes", "No"]} toolCallId="call-1" />,
    );
    expect(view.container.innerHTML).toBe("");
  });
});
