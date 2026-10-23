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
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ComposerDraft } from "@/components/channels/composer/draft";
import {
  type ConversationSend,
  latestTurnToolCalls,
  useConversationSend,
} from "@/components/channels/conversation-send";
import { ConversationView } from "@/components/channels/conversation-view";
import { ReplyChipsTool } from "@/lib/copilot/reply-chips-tool";
import { settleReactWork } from "./settle-react-work";

/**
 * The send a card or a chip inside a conversation uses, through `ConversationView` itself: what it
 * sends has to go exactly where the composer's own words go, including into the queue.
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

function call(id: string) {
  return {
    id,
    type: "function" as const,
    function: { name: "suggest_replies", arguments: "{}" },
  };
}

const ASKED: Message[] = [
  { id: "u1", role: "user", content: "What needs me?" },
  {
    id: "a1",
    role: "assistant",
    content: "Which first?",
    toolCalls: [call("call-1")],
  },
  { id: "t1", role: "tool", toolCallId: "call-1", content: "Shown." },
];

/** Drawn as the conversation's lead, which is inside the transcript, and hands the send out. */
function Probe({ into }: { into: { current: ConversationSend | null } }) {
  into.current = useConversationSend();
  return null;
}

function mount(
  props: {
    messages?: Message[];
    pending?: boolean;
    queueWhileBusy?: boolean;
    disabled?: boolean;
  } = {},
) {
  const sent: ComposerDraft[] = [];
  const into: { current: ConversationSend | null } = { current: null };
  // The provider and the renderer are for the transcript, which draws the Bot's call through them.
  // The transcript reads the approval inbox to tell a held call from a running one.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (next: typeof props) => (
    <QueryClientProvider client={client}>
      <CopilotKitProvider>
        <ReplyChipsTool />
        <ConversationView
          disabled={next.disabled ?? false}
          lead={<Probe into={into} />}
          messages={next.messages ?? ASKED}
          onSubmit={(draft) => {
            sent.push(draft);
          }}
          pending={next.pending ?? false}
          queueWhileBusy={next.queueWhileBusy ?? false}
        />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return {
    view,
    sent,
    send: (text: string) => {
      let went = false;
      act(() => {
        went = into.current?.send(text) ?? false;
      });
      return went;
    },
    current: () => into.current,
    rerender: (next: typeof props) => view.rerender(tree(next)),
  };
}

describe("the latest turn", () => {
  test("is the tool calls since the person last spoke", () => {
    expect(latestTurnToolCalls(ASKED)).toEqual(["call-1"]);
    expect(
      latestTurnToolCalls([
        ...ASKED,
        { id: "u2", role: "user", content: "The first." },
      ]),
    ).toEqual([]);
    expect(
      latestTurnToolCalls([
        ...ASKED,
        { id: "u2", role: "user", content: "The first." },
        {
          id: "a2",
          role: "assistant",
          content: "",
          toolCalls: [call("call-2"), call("call-3")],
        },
      ]).sort(),
    ).toEqual(["call-2", "call-3"]);
    expect(latestTurnToolCalls([])).toEqual([]);
  });
});

describe("sending as the person", () => {
  test("goes out as the composer's own message when the conversation is free", async () => {
    const chat = mount();
    expect(chat.current()?.isLatestTurn("call-1")).toBe(true);
    expect(chat.current()?.isLatestTurn("call-0")).toBe(false);

    expect(chat.send("  Not now ")).toBe(true);

    await waitFor(() => expect(chat.sent).toHaveLength(1));
    expect(chat.sent[0]).toEqual({
      text: "Not now",
      agentId: null,
      commandIds: [],
      isEmpty: false,
      attachments: [],
    });
  });

  test("is parked behind a turn in flight, and goes when it ends", async () => {
    const chat = mount({ pending: true, queueWhileBusy: true });

    expect(chat.send("Yes")).toBe(true);
    await chat.view.findByLabelText(/Remove queued message/);
    expect(chat.sent).toEqual([]);
    // Parked is the person having answered: the turn before it is no longer the latest.
    expect(chat.current()?.isLatestTurn("call-1")).toBe(false);

    chat.rerender({ pending: false, queueWhileBusy: true });
    await waitFor(() => expect(chat.sent.map((d) => d.text)).toEqual(["Yes"]));
  });

  test("is refused where the composer would refuse it", () => {
    const busy = mount({ pending: true });
    expect(busy.send("Yes")).toBe(false);
    cleanup();

    const deleted = mount({ disabled: true });
    expect(deleted.send("Yes")).toBe(false);
    expect(deleted.send("   ")).toBe(false);
    expect(busy.sent).toEqual([]);
    expect(deleted.sent).toEqual([]);
  });

  test("is nothing outside a conversation", () => {
    const into: { current: ConversationSend | null } = {
      current: {} as ConversationSend,
    };
    render(<Probe into={into} />);
    expect(into.current).toBe(null);
  });
});
