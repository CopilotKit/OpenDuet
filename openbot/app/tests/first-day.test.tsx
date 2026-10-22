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
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import * as ChannelChatModule from "@/components/channels/channel-chat";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  FIRST_DAY_PLAN,
  firstDayWelcome,
  firstNameOf,
} from "@/components/channels/first-day-greeting";
import { takeFirstMessage } from "@/components/channels/transcript-messages";
import { ChatPresenceProvider } from "@/components/shell/chat-presence";
import { ChatScreen } from "@/components/shell/chat-screen";
import { FIRST_DAY_REQUEST } from "@/components/shell/first-day";
import { agentKeys } from "@/lib/agents/queries";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { frameFirstDay } from "@/lib/channels/first-day";
import { firstDayClaimKey } from "@/lib/channels/first-day-claim";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { queryClient as appQueryClient } from "@/query-client";
import { FIRST_DAY_FRAME } from "@openbot/shared/first-day";
import { settleReactWork } from "./settle-react-work";

/**
 * On the first day the Bot speaks first: Chat opened on nothing sends the first-day request itself,
 * once, and the transcript draws the Bot's greeting where that message sits.
 */

/*
 * The conversation itself is not under test here, and drawing it needs a whole CopilotKit runtime.
 * A namespace spy, restorable in `afterAll`, stands in for it and says which channel it was opened
 * on; `takeFirstMessage` then reads what Chat handed it to send, as the real one does on mount.
 */
const channelChat = spyOn(ChannelChatModule, "ChannelChat");

const originalFetch = global.fetch;
type Request = { method: string; path: string; body: unknown };
let requests: Request[] = [];
let answerMe: () => Promise<Response>;
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

const userNamed = (id: string, name: string | null): AuthenticatedUser => ({
  id,
  email: `${id}@example.com`,
  name,
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
});

const CREATED = summary("created-channel", null);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  channelChat.mockImplementation((({
    channel,
  }: {
    channel: { id: string };
  }) => <div data-channel={channel.id} data-testid="ongoing-chat" />) as never);
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  requests = [];
  window.localStorage.clear();
  appQueryClient.removeQueries({ queryKey: authKeys.currentUser() });
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
    if (path === "/api/route" && method === "POST")
      return Response.json({
        agentId: BOT.id,
        name: BOT.name,
        reason: "named by the person asking",
        fallback: false,
        viaMention: true,
      });
    if (path === "/api/channels" && method === "POST") return answerCreate();
    if (path.startsWith("/api/channels"))
      return Response.json({ channels: [], nextCursor: null });
    return Response.json({});
  }) as unknown as typeof fetch;
}

const routed = () =>
  requests.filter((r) => r.path === "/api/route" && r.method === "POST");
const created = () =>
  requests.filter((r) => r.path === "/api/channels" && r.method === "POST");

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
  if (user === "loading") {
    serve();
  } else {
    answerMe = async () => Response.json({ user });
    client.setQueryData(authKeys.currentUser(), user);
    serve();
  }
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

/** A promise the test settles, for a request that should hang until it says so. */
function held() {
  let settle: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * Storage refused outright, as a private window or blocked site data refuses it. On the window
 * itself rather than on `Storage.prototype`: happy-dom hands out its own copies of the methods once
 * they have been read, so a prototype spy stops reaching them after the first test that stores.
 */
function withoutStorage(): () => void {
  const own = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("Storage is disabled.");
    },
  });
  return () => {
    if (own) Object.defineProperty(window, "localStorage", own);
    else delete (window as { localStorage?: Storage }).localStorage;
  };
}

/** Type into the composer the way its own tests do: a text paste at the caret. */
function typeInto(container: HTMLElement, words: string) {
  const editor = container.querySelector("[contenteditable]") as HTMLElement;
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(caret);
  const clipboardData = {
    files: [],
    items: [],
    types: ["text/plain"],
    getData: (type: string) => (type === "text/plain" ? words : ""),
  };
  editor.dispatchEvent(
    Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
      clipboardData,
    }),
  );
}

describe("what Chat asks for on the first day", () => {
  test("mail and calendar, and an invitation to correct it", () => {
    expect(FIRST_DAY_REQUEST).toMatch(/^Get to know me\./);
    expect(FIRST_DAY_REQUEST).toContain("mail");
    expect(FIRST_DAY_REQUEST).toContain("calendar");
    expect(FIRST_DAY_REQUEST).toContain("three ways");
    expect(FIRST_DAY_REQUEST).toContain("correct");
  });
});

describe("the greeting's words", () => {
  test("greets by first name, and by no name when there is not a real one", () => {
    expect(firstNameOf("Maya Chen")).toBe("Maya");
    expect(firstNameOf("  Maya  ")).toBe("Maya");
    expect(firstNameOf("maya@example.com")).toBeNull();
    expect(firstNameOf("")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf(undefined)).toBeNull();
  });

  test("the welcome says it is the first day, and that it will learn how they work", () => {
    expect(firstDayWelcome("Maya")).toMatch(/^Welcome, Maya\. /);
    expect(firstDayWelcome(null)).toMatch(/^Welcome\. /);
    for (const welcome of [firstDayWelcome("Maya"), firstDayWelcome(null)]) {
      expect(welcome).toContain("first day");
      expect(welcome).toContain("learn how you work");
    }
  });
});

describe("the transcript on the first day", () => {
  const firstDay: Message = {
    id: "first-day",
    role: "user",
    content: frameFirstDay(FIRST_DAY_REQUEST),
  };

  test("draws the Bot's greeting where the message sits, and no bubble for the person", async () => {
    appQueryClient.setQueryData(
      authKeys.currentUser(),
      userNamed("transcript-maya", "Maya Chen"),
    );
    const view = render(<ChatTranscript messages={[firstDay]} />);
    await settleReactWork();

    expect(
      view.getByText(
        "Welcome, Maya. It's our first day together, and I'll learn how you work as we go.",
      ),
    ).toBeTruthy();
    expect(view.getByText(FIRST_DAY_PLAN)).toBeTruthy();
    // Both in the Bot's column; nothing on the person's side, and nothing of the frame or request.
    const rows = view.container.querySelectorAll('[data-slot="message"]');
    expect(rows.length).toBe(1);
    expect(rows[0]?.getAttribute("data-align")).toBe("start");
    expect(view.container.querySelectorAll('[data-slot="bubble"]').length).toBe(
      2,
    );
    expect(view.container.textContent).not.toContain(FIRST_DAY_FRAME[0]);
    expect(view.container.textContent).not.toContain(FIRST_DAY_REQUEST);
  });

  test("says no name when the account's name is only an email address", async () => {
    appQueryClient.setQueryData(
      authKeys.currentUser(),
      userNamed("transcript-email", "maya@example.com"),
    );
    const view = render(<ChatTranscript messages={[firstDay]} />);
    await settleReactWork();

    expect(view.getByText(/^Welcome\. It's our first day/)).toBeTruthy();
    expect(view.container.textContent).not.toContain("maya@example.com");
  });

  test("a person quoting one line of the frame still gets their own bubble", async () => {
    const quoted: Message = {
      id: "quoted",
      role: "user",
      content: FIRST_DAY_FRAME[0],
    };
    const view = render(<ChatTranscript messages={[quoted]} />);
    await settleReactWork();

    expect(view.getByText(FIRST_DAY_FRAME[0])).toBeTruthy();
    const row = view.container.querySelector('[data-slot="message"]');
    expect(row?.getAttribute("data-align")).toBe("end");
    expect(view.queryByText(FIRST_DAY_PLAN)).toBeNull();
  });
});

describe("Chat on the first day", () => {
  test("with no conversation yet, it sends the first-day message once, StrictMode and all", async () => {
    answerCreate = async () => Response.json({ channel: CREATED });
    const view = openChat([], {
      user: userNamed("strict", "Maya"),
      strict: true,
    });

    const ongoing = await view.findByTestId("ongoing-chat");
    expect(ongoing.getAttribute("data-channel")).toBe(CREATED.id);
    expect(created()).toHaveLength(1);
    expect(routed()).toHaveLength(1);
    expect(routed()[0]?.body).toMatchObject({
      text: frameFirstDay(FIRST_DAY_REQUEST),
      agentId: BOT.id,
    });
    // What the conversation is handed to send: the framed request, and only once.
    expect(takeFirstMessage(CREATED.id)).toBe(frameFirstDay(FIRST_DAY_REQUEST));
    await settleReactWork();
    expect(routed()).toHaveLength(1);
  });

  test("draws the greeting while the conversation is being made, with no Get to know me button", async () => {
    const creating = held();
    answerCreate = () => creating.promise;
    const view = openChat([], { user: userNamed("drawing", "Maya") });

    await waitFor(() => expect(created()).toHaveLength(1));
    expect(view.getByText(FIRST_DAY_PLAN)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Get to know me" })).toBeNull();
    expect(view.queryByText("Let's get to know each other")).toBeNull();

    await act(async () => creating.settle(Response.json({ channel: CREATED })));
    await view.findByTestId("ongoing-chat");
    takeFirstMessage(CREATED.id);
  });

  test("with a conversation that has never had a message, it greets into that one", async () => {
    const quiet = summary("quiet-channel", null);
    const view = openChat([quiet], { user: userNamed("quiet", "Maya") });

    const ongoing = await view.findByTestId("ongoing-chat");
    expect(ongoing.getAttribute("data-channel")).toBe(quiet.id);
    expect(created()).toHaveLength(0);
    expect(routed()).toHaveLength(1);
    expect(takeFirstMessage(quiet.id)).toBe(frameFirstDay(FIRST_DAY_REQUEST));
  });

  test("with a conversation that already has a message, it sends nothing", async () => {
    const used = summary("used-channel", "2026-10-22T10:00:00.000Z");
    const view = openChat([used], { user: userNamed("used", "Maya") });

    const ongoing = await view.findByTestId("ongoing-chat");
    expect(ongoing.getAttribute("data-channel")).toBe(used.id);
    await settleReactWork();
    expect(routed()).toHaveLength(0);
    expect(created()).toHaveLength(0);
    expect(takeFirstMessage(used.id)).toBeNull();
  });

  test("opened again while the first greeting is still going, it does not send a second", async () => {
    const creating = held();
    answerCreate = () => creating.promise;
    const user = userNamed("remount", "Maya");
    const first = openChat([], { user });
    await waitFor(() => expect(created()).toHaveLength(1));
    first.unmount();

    openChat([], { user });
    await settleReactWork();
    expect(created()).toHaveLength(1);
    expect(routed()).toHaveLength(1);
    await act(async () => creating.settle(Response.json({ channel: CREATED })));
    takeFirstMessage(CREATED.id);
  });

  test("without storage, opening Chat again after the greeting went does not send another", async () => {
    const restoreStorage = withoutStorage();
    try {
      answerCreate = async () => Response.json({ channel: CREATED });
      const user = userNamed("no-storage", "Maya");
      const first = openChat([], { user, strict: true });
      await first.findByTestId("ongoing-chat");
      takeFirstMessage(CREATED.id);
      first.unmount();

      // The roster has not caught up yet, so Chat opens on nothing again.
      openChat([], { user, strict: true });
      await settleReactWork();
      expect(routed()).toHaveLength(1);
      expect(created()).toHaveLength(1);
    } finally {
      restoreStorage();
    }
  });

  test("another tab that just greeted holds this one off", async () => {
    window.localStorage.setItem(
      firstDayClaimKey(`other-tab:${BOT.id}`),
      String(Date.now()),
    );
    answerCreate = async () => Response.json({ channel: CREATED });
    const view = openChat([], { user: userNamed("other-tab", "Maya") });
    await settleReactWork();

    expect(routed()).toHaveLength(0);
    expect(created()).toHaveLength(0);
    expect(view.queryByText(FIRST_DAY_PLAN)).toBeNull();
  });

  test("another tab in the middle of greeting holds this one off", async () => {
    // happy-dom has no Web Locks, so this stands in for the browser's: one holder per name, and
    // `ifAvailable` handing the callback null rather than waiting.
    const holders = new Set<string>();
    const locks = {
      async request(
        name: string,
        options: { ifAvailable?: boolean },
        callback: (lock: { name: string } | null) => Promise<unknown>,
      ) {
        if (holders.has(name)) {
          if (options.ifAvailable) return callback(null);
          throw new Error("Only ifAvailable is used here.");
        }
        holders.add(name);
        try {
          return await callback({ name });
        } finally {
          holders.delete(name);
        }
      },
    };
    const own = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: locks,
    });
    let release: () => void = () => {};
    const otherTab = locks.request(
      firstDayClaimKey(`mid-send:${BOT.id}`),
      {},
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      answerCreate = async () => Response.json({ channel: CREATED });
      const view = openChat([], { user: userNamed("mid-send", "Maya") });
      await settleReactWork();

      expect(routed()).toHaveLength(0);
      expect(created()).toHaveLength(0);
      expect(view.queryByText(FIRST_DAY_PLAN)).toBeNull();
    } finally {
      release();
      await otherTab;
      if (own) Object.defineProperty(navigator, "locks", own);
      else delete (navigator as { locks?: unknown }).locks;
    }
  });

  test("a greeting another tab sent long ago does not hold this one off", async () => {
    window.localStorage.setItem(
      firstDayClaimKey(`stale-tab:${BOT.id}`),
      String(Date.now() - 60 * 60_000),
    );
    answerCreate = async () => Response.json({ channel: CREATED });
    const view = openChat([], { user: userNamed("stale-tab", "Maya") });

    await view.findByTestId("ongoing-chat");
    expect(routed()).toHaveLength(1);
    takeFirstMessage(CREATED.id);
  });

  test("typing first wins: what the person sends goes, and no greeting does", async () => {
    // The account is still loading, so the greeting is waiting when the person starts typing.
    const me = held();
    answerMe = () => me.promise;
    answerCreate = async () => Response.json({ channel: CREATED });
    const view = openChat([], { user: "loading" });

    await act(async () => typeInto(view.container, "What's on today?"));
    await act(async () =>
      me.settle(Response.json({ user: userNamed("typist", "Maya") })),
    );
    // The account has arrived, so the greeting has had its chance and declined it.
    await waitFor(() =>
      expect(view.client.getQueryData(authKeys.currentUser())).toBeTruthy(),
    );
    await settleReactWork();
    expect(routed()).toHaveLength(0);
    expect(created()).toHaveLength(0);

    await act(async () => {
      view.getByLabelText("Send message").click();
    });
    await view.findByTestId("ongoing-chat");
    expect(routed()).toHaveLength(1);
    expect(routed()[0]?.body).toMatchObject({ text: "What's on today?" });
    expect(takeFirstMessage(CREATED.id)).toBe("What's on today?");
  });
});
