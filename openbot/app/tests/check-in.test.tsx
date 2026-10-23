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
import { CHECK_IN_FRAME, frameCheckIn } from "@openbot/shared/check-in";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { checkInTime } from "@/components/channels/chat-transcript";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  ChatSuggestionCard,
  ChatSuggestionProvider,
} from "@/components/shell/chat-suggestion";
import {
  CHECK_IN_ARRIVAL_SLACK_MS,
  checkInNotice,
  useCheckInNotifications,
} from "@/components/shell/check-in-notifier";
import { CheckInArrivalContext } from "@/lib/channels/check-in";
import { OfferTaskTool, readOffer } from "@/lib/copilot/offer-task-tool";
import { settleReactWork } from "./settle-react-work";

/**
 * A check-in as a person meets it in Chat: a quiet line where the framed message sits, the Bot's
 * short message, and the task it offers as the same card Chat shows above the composer, drawn by
 * the real renderer in the real transcript.
 */

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const BOT = { id: "openduet", name: "OpenDuet" };
const CHECKED_AT = "2026-10-22T17:32:00.000Z";
const PRIYA = {
  id: "s-priya",
  title: "Send Priya replacement mugs today",
  detail:
    "Two of her six mugs arrived broken and Hearth & Co opens on Saturday.\n\nNext: Reply that new ones ship today.",
  source: "Gmail",
  status: "open" as const,
};

/** The thread a check-in leaves: its framed message, the Bot's line, and the card it offered. */
function checkedIn(offered: unknown): Message[] {
  return [
    {
      id: "check-in",
      role: "user",
      content: frameCheckIn({
        checkedAt: CHECKED_AT,
        offers: [{ id: PRIYA.id, title: PRIYA.title, why: PRIYA.detail }],
      }),
    },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "offer_task",
            arguments: JSON.stringify({ suggestionId: PRIYA.id }),
          },
        },
      ],
    },
    {
      id: "t1",
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify(offered),
    },
    {
      id: "a2",
      role: "assistant",
      content:
        "Priya's order from Hearth & Co arrived broken. She needs new mugs today.",
    },
  ];
}

/**
 * Answers the one suggestion with `status`, the open list with what is still open, and records
 * each start or dismiss.
 */
/** What each start or dismiss sent, in order. */
const bodies: unknown[] = [];

function serve(initial: "open" | "started" | "dismissed") {
  let status = initial;
  const calls: string[] = [];
  bodies.length = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^.*\/api/, "/api");
      if (init?.method === "POST") {
        calls.push(`POST ${path}`);
        bodies.push(init.body ? JSON.parse(String(init.body)) : undefined);
        status = path.endsWith("/start") ? "started" : "dismissed";
        return Response.json({ suggestion: { ...PRIYA, status } });
      }
      if (path === `/api/proactive/suggestions/${PRIYA.id}`)
        return Response.json({
          suggestion: {
            ...PRIYA,
            agentId: BOT.id,
            sourceApp: PRIYA.source,
            sourceLink: null,
            createdAt: CHECKED_AT,
            status,
          },
        });
      if (path === "/api/proactive/suggestions")
        return Response.json({
          suggestions:
            status === "open"
              ? [
                  {
                    ...PRIYA,
                    agentId: BOT.id,
                    sourceApp: PRIYA.source,
                    sourceLink: null,
                    createdAt: CHECKED_AT,
                  },
                ]
              : [],
        });
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  return calls;
}

function Chat({
  messages,
  dock = false,
}: {
  messages: Message[];
  dock?: boolean;
}) {
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queries}>
      <CopilotKitProvider>
        <OfferTaskTool />
        <ChatSuggestionProvider bot={BOT}>
          <ConversationView messages={messages} onSubmit={() => {}} />
          {dock ? <ChatSuggestionCard /> : null}
        </ChatSuggestionProvider>
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

describe("a check-in in Chat", () => {
  test("is a quiet line with the time, never the person's bubble, and none of the frame shows", async () => {
    serve("open");
    const view = render(<Chat messages={checkedIn(PRIYA)} />);
    const line = await view.findByText(/^Checked your mail and calendar/);
    expect(line.textContent).toBe(
      `Checked your mail and calendar · ${checkInTime(CHECKED_AT)}`,
    );
    expect(view.container.textContent).not.toContain(CHECK_IN_FRAME[0]);
    expect(view.container.textContent).not.toContain("suggestionId");
    // Nothing on the person's side of the conversation.
    expect(
      view.container.querySelectorAll('[data-slot="message"][data-align="end"]')
        .length,
    ).toBe(0);
  });

  test("ends on the offered task as the same card, under the Bot's words, with Hide and Start", async () => {
    serve("open");
    const view = render(<Chat messages={checkedIn(PRIYA)} />);
    const card = await view.findByRole("region", {
      name: "OpenDuet could take this on",
    });
    expect(within(card).getByText(PRIYA.title)).toBeTruthy();
    expect(
      within(card).getByText(/Two of her six mugs arrived broken/),
    ).toBeTruthy();
    expect(within(card).getByText("From Gmail")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Hide" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Start" })).toBeTruthy();
    const words = view.getByText(/She needs new mugs today/);
    expect(
      words.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("Start on the card starts it, and the card then says Started instead of offering buttons", async () => {
    const calls = serve("open");
    const view = render(<Chat messages={checkedIn(PRIYA)} />);
    const card = await view.findByRole("region", {
      name: "OpenDuet could take this on",
    });
    fireEvent.click(within(card).getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(calls).toEqual([
        `POST /api/proactive/suggestions/${PRIYA.id}/start`,
      ]),
    );
    // It opens as a task that began at this check-in.
    expect(bodies).toEqual([{ from: "check_in" }]);
    await waitFor(() => expect(view.getByText("Started")).toBeTruthy());
    // The same card, with its title, and the line where its buttons were.
    const answered = view.getByRole("region", {
      name: "OpenDuet could take this on",
    });
    expect(within(answered).getByText(PRIYA.title)).toBeTruthy();
    expect(within(answered).queryByRole("button")).toBeNull();
  });

  test("a task already hidden elsewhere reads Hidden, with nothing to press", async () => {
    serve("dismissed");
    const view = render(<Chat messages={checkedIn(PRIYA)} />);
    await waitFor(() => expect(view.getByText("Hidden")).toBeTruthy());
    expect(view.queryByRole("button", { name: "Start" })).toBeNull();
    expect(view.getByText(PRIYA.title)).toBeTruthy();
  });

  test("a task offered in the thread is not drawn again above the composer", async () => {
    serve("open");
    const view = render(<Chat dock messages={checkedIn(PRIYA)} />);
    await view.findByText(/She needs new mugs today/);
    await settleReactWork();
    expect(
      view.getAllByRole("region", { name: "OpenDuet could take this on" }),
    ).toHaveLength(1);
  });

  test("a refused offer draws no card", async () => {
    serve("open");
    const view = render(
      <Chat
        messages={checkedIn(
          "Refused. offer_task takes the suggestionId of one of this person's suggestions.",
        )}
      />,
    );
    await view.findByText(/She needs new mugs today/);
    expect(
      view.container.querySelector(
        '[aria-label="OpenDuet could take this on"]',
      ) === null,
    ).toBe(true);
    expect(readOffer(JSON.stringify(JSON.stringify(PRIYA)))).toMatchObject({
      id: PRIYA.id,
    });
  });
});

describe("the check-in notification", () => {
  const checkIn = {
    checkedAt: new Date().toISOString(),
    offers: [
      { id: PRIYA.id, title: PRIYA.title, why: PRIYA.detail },
      { id: "s-kiln", title: "Confirm the kiln delivery", why: "" },
    ],
  };

  test("is the Bot's name over the first task it offers", () => {
    expect(checkInNotice("OpenDuet", checkIn)).toEqual({
      title: "OpenDuet",
      body: `${PRIYA.title}, and 1 more`,
    });
    expect(
      checkInNotice("OpenDuet", {
        ...checkIn,
        offers: checkIn.offers.slice(0, 1),
      }),
    ).toEqual({ title: "OpenDuet", body: PRIYA.title });
    expect(
      checkInNotice("OpenDuet", { checkedAt: null, offers: [] }),
    ).toBeNull();
  });

  /** Draws the check-in's line through the transcript, as Chat does, and counts notifications. */
  function arrive(options: {
    hidden: boolean;
    permission: string;
    muted?: boolean;
    checkedAt?: string;
  }) {
    const shown: { title: string; body?: string }[] = [];
    const original = globalThis.Notification;
    class FakeNotification {
      static permission = options.permission;
      constructor(title: string, init?: { body?: string }) {
        shown.push({ title, ...(init?.body ? { body: init.body } : {}) });
      }
    }
    globalThis.Notification =
      FakeNotification as unknown as typeof Notification;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => options.hidden,
    });
    function Notifying({ messages }: { messages: Message[] }) {
      const arrived = useCheckInNotifications({
        name: "OpenDuet",
        muted: options.muted ?? false,
      });
      return (
        <CheckInArrivalContext.Provider value={arrived}>
          <Chat messages={messages} />
        </CheckInArrivalContext.Provider>
      );
    }
    const messages: Message[] = [
      {
        id: "check-in",
        role: "user",
        content: frameCheckIn({
          checkedAt: options.checkedAt ?? checkIn.checkedAt,
          offers: checkIn.offers,
        }),
      },
    ];
    serve("open");
    const view = render(<Notifying messages={[]} />);
    return {
      shown,
      deliver: async () => {
        view.rerender(<Notifying messages={messages} />);
        await view.findByText(/^Checked your mail and calendar/);
        // Drawn again, as a streamed reply redraws the transcript: still one notification.
        view.rerender(<Notifying messages={[...messages]} />);
        await settleReactWork();
      },
      restore: () => {
        globalThis.Notification = original;
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => false,
        });
      },
    };
  }

  test("fires once when a check-in arrives while the page is hidden and notifications are allowed", async () => {
    const run = arrive({ hidden: true, permission: "granted" });
    try {
      await run.deliver();
      expect(run.shown).toEqual([
        { title: "OpenDuet", body: `${PRIYA.title}, and 1 more` },
      ]);
    } finally {
      run.restore();
    }
  });

  test("stays quiet while the person is looking, without permission, when muted, or for history", async () => {
    for (const options of [
      { hidden: false, permission: "granted" },
      { hidden: true, permission: "default" },
      { hidden: true, permission: "granted", muted: true },
      {
        hidden: true,
        permission: "granted",
        checkedAt: new Date(
          Date.now() - CHECK_IN_ARRIVAL_SLACK_MS - 60_000,
        ).toISOString(),
      },
    ]) {
      const run = arrive(options);
      try {
        await run.deliver();
        expect(run.shown).toEqual([]);
      } finally {
        run.restore();
        cleanup();
      }
    }
  });
});
