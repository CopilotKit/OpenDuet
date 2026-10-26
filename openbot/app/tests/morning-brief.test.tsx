import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MORNING_BRIEF_FRAME } from "@openbot/shared/morning-brief";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, StrictMode, useState } from "react";
import * as ChannelChatModule from "@/components/channels/channel-chat";
import {
  repliesLast,
  toVisibleChatItems,
} from "@/components/channels/chat-messages";
import {
  ChatTranscript,
  FIRST_DAY_REPLIES,
  newestTurnIsBrief,
} from "@/components/channels/chat-transcript";
import { ConversationSendContext } from "@/components/channels/conversation-send";
import { ConversationView } from "@/components/channels/conversation-view";
import { groupToolSteps } from "@/components/channels/tool-activity";
import {
  ChatPresenceProvider,
  useReportChatPresence,
} from "@/components/shell/chat-presence";
import { ChatScreen } from "@/components/shell/chat-screen";
import { FIRST_DAY_REQUEST } from "@/components/shell/first-day";
import { MORNING_BRIEF_REQUEST } from "@/components/shell/morning-brief";
import { agentKeys } from "@/lib/agents/queries";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import {
  conversationTitle,
  firstPersonMessage,
  NEW_CONVERSATION,
} from "@/lib/channels/conversation-title";
import { frameFirstDay } from "@/lib/channels/first-day";
import { frameMorningBrief, localDateOf } from "@/lib/channels/morning-brief";
import { morningBriefClaimKey } from "@/lib/channels/morning-brief-claim";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { MorningBriefTool } from "@/lib/copilot/morning-brief-tool";
import { queryClient as appQueryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * On every day after the first, the Bot speaks first: the first time Chat opens that day it asks the
 * server for the morning brief, once, and the transcript draws the Bot's reply and the brief's card
 * with nothing of the person's where the request sits.
 */

/*
 * The conversation itself is not under test here, as in first-day.test.tsx. The stand-in reports to
 * the shell the way the real one does, so a test can type into it, or have a turn of the person's
 * own already running, and Chat can see that.
 */
const channelChat = spyOn(ChannelChatModule, "ChannelChat");

function StandInConversation({ channel }: { channel: { id: string } }) {
  // A turn the person started here: a typed message, a reply chip or a Start on a card.
  const [working, setWorking] = useState(false);
  const presence = useReportChatPresence(true, { working, failed: false });
  return (
    <div data-channel={channel.id} data-testid="ongoing-chat">
      {/* What the composer reports on a keystroke, without drawing the composer. */}
      <button
        onClick={() => presence?.onTextChange("What's on today?")}
        type="button"
      >
        Type a message
      </button>
      <button onClick={() => setWorking(true)} type="button">
        Sounds right
      </button>
    </div>
  );
}

const originalFetch = global.fetch;
type Request = { method: string; path: string; body: unknown };
let requests: Request[] = [];
let answerMe: () => Promise<Response>;
let answerBrief: () => Promise<Response>;
let answerCreate: () => Promise<Response>;

const BOT = {
  id: "openduet",
  name: "OpenDuet",
  title: "Your proactive assistant",
  roleDescription: "",
  avatarSeed: "openduet",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
};

const userNamed = (id: string): AuthenticatedUser => ({
  id,
  email: `${id}@example.com`,
  name: "Maya Chen",
  role: "user",
  onboarding: null,
});

const summary = (id: string, lastMessageAt: string | null): ChannelSummary => ({
  id,
  name: "OpenDuet",
  agentIds: [BOT.id],
  threadId: `thread-${id}`,
  active: true,
  lastMessageAt,
  summary: null,
  lastMessage: lastMessageAt ? "Earlier" : null,
  lastMessageAgentId: null,
  createdAt: "2026-10-22T09:00:00.000Z",
  pinned: false,
  lastReadAt: lastMessageAt,
  busy: false,
  taskId: null,
  openduetChannel: false,
});

/** A conversation the person has used before: a later day. */
const USED = summary("used-channel", "2026-10-25T17:00:00.000Z");

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  channelChat.mockImplementation(StandInConversation as never);
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  requests = [];
  window.localStorage.clear();
  appQueryClient.clear();
});

afterAll(async () => {
  channelChat.mockRestore();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function serve() {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ method, path, body });
    if (path === "/api/me") return answerMe();
    if (path === "/api/channels/morning-brief" && method === "POST")
      return answerBrief();
    if (path === "/api/channels/first-day" && method === "POST")
      return answerCreate();
    if (path === "/api/route" && method === "POST")
      return Response.json({
        agentId: BOT.id,
        name: BOT.name,
        reason: "named by the person asking",
        fallback: false,
        viaMention: true,
      });
    if (path === "/api/bots/attention") return Response.json({ bots: [] });
    if (path.startsWith("/api/plugins/for/"))
      return Response.json({
        app: { key: "google-workspace", state: "ready" },
      });
    if (path.startsWith("/api/channels"))
      return Response.json({ channels: [], nextCursor: null });
    return Response.json({});
  }) as unknown as typeof fetch;
}

const briefs = () =>
  requests.filter(
    (r) => r.path === "/api/channels/morning-brief" && r.method === "POST",
  );

/** Chat in the shell, with its Bot and its roster already loaded, as the app opens it. */
function openChat(
  channels: ChannelSummary[],
  {
    user,
    strict = false,
  }: { user: AuthenticatedUser | "loading"; strict?: boolean },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentKeys.list(false), [BOT]);
  client.setQueryData(channelKeys.list(), {
    pages: [{ channels, nextCursor: null }],
    pageParams: [""],
  });
  if (user !== "loading") {
    answerMe = async () => Response.json({ user });
    client.setQueryData(authKeys.currentUser(), user);
  }
  serve();
  const screen: ReactNode = (
    <QueryClientProvider client={client}>
      <ChatPresenceProvider>
        <ChatScreen />
      </ChatPresenceProvider>
    </QueryClientProvider>
  );
  return Object.assign(
    render(strict ? <StrictMode>{screen}</StrictMode> : screen),
    { client },
  );
}

function held() {
  let settle: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe("Chat on a later day", () => {
  test("asks for the morning brief once, with today's local date and no text of its own, StrictMode and all", async () => {
    answerBrief = async () =>
      Response.json({ brief: { channel: USED, claimed: true } });
    const view = openChat([USED], {
      user: userNamed("later-day"),
      strict: true,
    });

    await view.findByTestId("ongoing-chat");
    await waitFor(() => expect(briefs()).toHaveLength(1));
    // The server writes the brief's message itself (`morningBriefMessage`); the app sends none.
    expect(briefs()[0]?.body).toEqual({
      agentId: BOT.id,
      date: localDateOf(new Date()),
    });
    await settleReactWork();
    expect(briefs()).toHaveLength(1);
  });

  test("opened again the same day, it does not ask again", async () => {
    answerBrief = async () =>
      Response.json({ brief: { channel: USED, claimed: true } });
    const user = userNamed("same-day");
    const first = openChat([USED], { user });
    await waitFor(() => expect(briefs()).toHaveLength(1));
    first.unmount();

    openChat([USED], { user });
    await settleReactWork();
    expect(briefs()).toHaveLength(1);
  });

  test("another tab that asked today holds this one off", async () => {
    window.localStorage.setItem(
      morningBriefClaimKey(`other-tab:${BOT.id}:${localDateOf(new Date())}`),
      String(Date.now()),
    );
    answerBrief = async () =>
      Response.json({ brief: { channel: USED, claimed: true } });
    openChat([USED], { user: userNamed("other-tab") });
    await settleReactWork();
    expect(briefs()).toHaveLength(0);
  });

  test("an ask that failed gives the claim back, and the next open asks again", async () => {
    answerBrief = async () =>
      Response.json({ error: "Try again." }, { status: 503 });
    const user = userNamed("failed-ask");
    const first = openChat([USED], { user });
    await waitFor(() => expect(briefs()).toHaveLength(1));
    await settleReactWork();
    first.unmount();

    answerBrief = async () =>
      Response.json({ brief: { channel: USED, claimed: true } });
    openChat([USED], { user });
    await waitFor(() => expect(briefs()).toHaveLength(2));
  });

  test("typing first wins: nothing is asked for", async () => {
    // The account is still loading, so the brief is waiting when the person starts typing.
    const me = held();
    answerMe = () => me.promise;
    answerBrief = async () =>
      Response.json({ brief: { channel: USED, claimed: true } });
    const view = openChat([USED], { user: "loading" });

    fireEvent.click(
      await view.findByRole("button", { name: "Type a message" }),
    );
    await act(async () =>
      me.settle(Response.json({ user: userNamed("typist") })),
    );
    // The account has arrived, so the brief has had its chance and declined it.
    await waitFor(() =>
      expect(view.client.getQueryData(authKeys.currentUser())).toBeTruthy(),
    );
    await settleReactWork();
    expect(briefs()).toHaveLength(0);
  });

  test("a turn the person starts first wins too: a tapped reply is a message they sent", async () => {
    const me = held();
    answerMe = () => me.promise;
    answerBrief = async () =>
      Response.json({ brief: { channel: USED, claimed: true } });
    const view = openChat([USED], { user: "loading" });

    fireEvent.click(await view.findByRole("button", { name: "Sounds right" }));
    await act(async () =>
      me.settle(Response.json({ user: userNamed("tapped") })),
    );
    await waitFor(() =>
      expect(view.client.getQueryData(authKeys.currentUser())).toBeTruthy(),
    );
    await settleReactWork();
    expect(briefs()).toHaveLength(0);
  });
});

describe("Chat on the first day", () => {
  test("a conversation with nothing said yet gets the greeting, with today's date for the server, and no brief", async () => {
    const quiet = summary("quiet-channel", null);
    answerCreate = async () =>
      Response.json({ start: { channel: quiet, claimed: true } });
    answerBrief = async () =>
      Response.json({ brief: { channel: quiet, claimed: true } });
    const view = openChat([quiet], { user: userNamed("first-day") });

    await view.findByTestId("ongoing-chat");
    await settleReactWork();
    const created = requests.filter(
      (r) => r.path === "/api/channels/first-day" && r.method === "POST",
    );
    expect(created).toHaveLength(1);
    // The first day takes today's brief on the server, so a later open today posts none under it.
    expect(created[0]?.body).toMatchObject({
      greeting: "with_mail",
      date: localDateOf(new Date()),
    });
    expect(briefs()).toHaveLength(0);
  });
});

const BRIEF_RESULT = {
  at: "2026-10-26T08:05:00",
  name: "Maya",
  needsYou: [
    {
      id: "m1",
      threadId: "t1",
      from: "Ana Pereira",
      subject: "Friday ship date?",
      reason: "Ana needs the Friday date confirmed today.",
      decidedBy: "model:test",
    },
  ],
  canWait: [],
  calendar: [],
  couldNotCheck: [],
  checked: { mail: 1, byRules: 0, byModel: 1 },
};
const REPLY = "Ana's Friday date is the one thing that needs you today.";

/** The thread a morning brief leaves: the framed request, the brief, and the Bot's one sentence. */
const briefed: Message[] = [
  {
    id: "brief",
    role: "user",
    content: frameMorningBrief(MORNING_BRIEF_REQUEST),
  },
  {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-brief",
        type: "function",
        function: { name: "morning_brief", arguments: "{}" },
      },
    ],
  },
  {
    id: "t1",
    role: "tool",
    toolCallId: "call-brief",
    content: JSON.stringify(BRIEF_RESULT),
  },
  { id: "a2", role: "assistant", content: REPLY },
];

describe("the transcript on a later day", () => {
  test("draws the Bot's reply and the brief's card, and nothing of the person's or of the frame", async () => {
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    globalThis.fetch = Object.assign(
      async () => Response.json({ error: "Not found" }, { status: 404 }),
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    const view = render(
      <QueryClientProvider client={queries}>
        <CopilotKitProvider>
          <MorningBriefTool />
          <ConversationView messages={briefed} onSubmit={() => {}} />
        </CopilotKitProvider>
      </QueryClientProvider>,
    );

    expect(await view.findByText(REPLY)).toBeTruthy();
    expect(
      await view.findByText("Ana needs the Friday date confirmed today."),
    ).toBeTruthy();
    for (const line of MORNING_BRIEF_FRAME)
      expect(view.container.textContent).not.toContain(line);
    expect(view.container.textContent).not.toContain(MORNING_BRIEF_REQUEST);
    expect(
      view.container.querySelectorAll('[data-slot="message"][data-align="end"]')
        .length,
    ).toBe(0);
    // The brief is not the person speaking, so nothing reads "Seen" under it.
    await settleReactWork();
    expect(view.queryByText("Seen")).toBeNull();
  });

  test("its first row is held at the top, so a tall brief arrives top first rather than bottom first", async () => {
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    globalThis.fetch = Object.assign(
      async () => Response.json({ error: "Not found" }, { status: 404 }),
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    const view = render(
      <QueryClientProvider client={queries}>
        <CopilotKitProvider>
          <MorningBriefTool />
          <ConversationView messages={briefed} onSubmit={() => {}} />
        </CopilotKitProvider>
      </QueryClientProvider>,
    );
    const card = await view.findByText(
      "Ana needs the Friday date confirmed today.",
    );
    const anchors = view.container.querySelectorAll(
      '[data-scroll-anchor="true"]',
    );
    // One anchor, the brief's own row: the card is inside it, the Bot's sentence under it is not.
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.contains(card)).toBe(true);
    expect(anchors[0]?.textContent).not.toContain(REPLY);
    await settleReactWork();
  });

  test("a brief after an unanswered first day ends that day's answer: its replies are not offered under the brief", async () => {
    appQueryClient.setQueryData(authKeys.currentUser(), userNamed("both-days"));
    const firstDay: Message[] = [
      { id: "fd", role: "user", content: frameFirstDay(FIRST_DAY_REQUEST) },
      { id: "fd-answer", role: "assistant", content: "You run Marlow." },
    ];
    const reply: Message = { id: "a2", role: "assistant", content: REPLY };
    const later: Message = {
      id: "brief",
      role: "user",
      content: frameMorningBrief(MORNING_BRIEF_REQUEST),
    };

    const draw = (messages: Message[]) =>
      render(
        <ConversationSendContext.Provider
          value={{ send: () => true, isLatestTurn: () => true }}
        >
          <ChatTranscript messages={messages} />
        </ConversationSendContext.Provider>,
      );

    // The first day alone still offers its replies.
    const before = draw(firstDay);
    await settleReactWork();
    expect(
      before.getByRole("group", { name: "Suggested replies" }),
    ).toBeTruthy();
    before.unmount();

    const after = draw([...firstDay, later, reply]);
    await settleReactWork();
    expect(
      after.queryByRole("group", { name: "Suggested replies" }),
    ).toBeNull();
    for (const label of FIRST_DAY_REPLIES)
      expect(after.queryByRole("button", { name: label })).toBeNull();
    // The brief's reply is its own message, not one more part of the first day's answer.
    expect(after.getByText(REPLY)).toBeTruthy();
    expect(after.container.textContent).not.toContain(MORNING_BRIEF_FRAME[0]);
  });
});

describe("following the bottom", () => {
  test("is off while the newest turn is a morning brief, so its card arriving does not pull the view to its end", () => {
    const thread = groupToolSteps(
      repliesLast(toVisibleChatItems(briefed)),
      () => true,
    );
    expect(newestTurnIsBrief(thread)).toBe(true);
    const asked = groupToolSteps(
      repliesLast(
        toVisibleChatItems([
          ...briefed,
          { id: "u2", role: "user", content: "What about Northline?" },
        ]),
      ),
      () => true,
    );
    expect(newestTurnIsBrief(asked)).toBe(false);
  });
});

describe("naming a conversation", () => {
  const brief: Message = {
    id: "brief",
    role: "user",
    content: frameMorningBrief(MORNING_BRIEF_REQUEST),
  };

  test("a morning brief is never what the person first said", () => {
    expect(firstPersonMessage([brief])).toBeNull();
    expect(
      firstPersonMessage([
        brief,
        { id: "a", role: "assistant", content: REPLY },
        { id: "p", role: "user", content: "Draft the reply to Ana." },
      ]),
    ).toBe("Draft the reply to Ana.");
  });

  test("a morning brief as the last thing said names nothing", () => {
    expect(
      conversationTitle({
        lastMessage: frameMorningBrief(MORNING_BRIEF_REQUEST),
      }),
    ).toBe(NEW_CONVERSATION);
  });
});
