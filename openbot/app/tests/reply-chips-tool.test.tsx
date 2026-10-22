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
  readReplies,
  ReplyChips,
  ReplyChipsTool,
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

  test("draw nothing outside a conversation, where there is nowhere to send", () => {
    const view = render(
      <ReplyChips replies={["Yes", "No"]} toolCallId="call-1" />,
    );
    expect(view.container.innerHTML).toBe("");
  });
});
