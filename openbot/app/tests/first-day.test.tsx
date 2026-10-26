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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import * as ChannelChatModule from "@/components/channels/channel-chat";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  FIRST_DAY_PLAN,
  FIRST_DAY_PLAN_WITHOUT_MAIL,
  FIRST_DAY_REQUEST_WITHOUT_MAIL,
  firstDayPlan,
  firstDayWelcome,
  firstNameOf,
} from "@/components/channels/first-day-greeting";
import { takeFirstMessage } from "@/components/channels/transcript-messages";
import { ChatPresenceProvider } from "@/components/shell/chat-presence";
import { ChatScreen } from "@/components/shell/chat-screen";
import {
  FIRST_DAY_CLOSE,
  FIRST_DAY_REQUEST,
} from "@/components/shell/first-day";
import { agentKeys } from "@/lib/agents/queries";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { frameFirstDay } from "@/lib/channels/first-day";
import { firstDayClaimKey } from "@/lib/channels/first-day-claim";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { updateChannelEventCache } from "@/lib/channels/use-channel-events";
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
const routeAnswer = () =>
  Response.json({
    agentId: BOT.id,
    name: BOT.name,
    reason: "named by the person asking",
    fallback: false,
    viaMention: true,
  });
let answerRoute: () => Promise<Response> = async () => routeAnswer();
/** What app access says about Gmail and Calendar on the Bot. Ready unless a test says otherwise. */
let answerGmail: () => Promise<Response> = async () =>
  Response.json({ app: { key: "google-workspace", state: "ready" } });
const GMAIL_PATH = "/api/plugins/for/openduet/apps/google-workspace";

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
  answerRoute = async () => routeAnswer();
  window.localStorage.clear();
  appQueryClient.removeQueries({ queryKey: authKeys.currentUser() });
  answerGmail = async () =>
    Response.json({ app: { key: "google-workspace", state: "ready" } });
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
    if (path === GMAIL_PATH) return answerGmail();
    if (path === "/api/route" && method === "POST") return answerRoute();
    if (path === "/api/channels/first-day" && method === "POST") {
      const response = await answerCreate();
      if (!response.ok) return response;
      const body = await response.json();
      return Response.json({
        start: body.start ?? { channel: body.channel, claimed: true },
      });
    }
    if (path.startsWith("/api/channels"))
      return Response.json({ channels: [], nextCursor: null });
    return Response.json({});
  }) as unknown as typeof fetch;
}

const routed = () =>
  requests.filter((r) => r.path === "/api/route" && r.method === "POST");
const created = () =>
  requests.filter(
    (r) => r.path === "/api/channels/first-day" && r.method === "POST",
  );

/** Chat in the shell, with its Bot and its roster already loaded, as the app opens it. */
function openChat(
  channels: ChannelSummary[],
  {
    user,
    strict = false,
    nextCursor = null,
    transport,
  }: {
    user: AuthenticatedUser | "loading";
    strict?: boolean;
    nextCursor?: string | null;
    transport?: typeof fetch;
  },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(agentKeys.list(false), [BOT]);
  client.setQueryData(channelKeys.list(), {
    pages: [{ channels, nextCursor }],
    pageParams: [""],
  });
  if (user === "loading") {
    serve();
  } else {
    answerMe = async () => Response.json({ user });
    client.setQueryData(authKeys.currentUser(), user);
    serve();
  }
  if (transport) global.fetch = transport;
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
    // S11.1's three parts, with the lines the transcript splits them at.
    expect(FIRST_DAY_REQUEST).toContain(
      "three parts, with a blank line between them",
    );
    expect(FIRST_DAY_REQUEST).toContain("no bold or headings");
    expect(FIRST_DAY_REQUEST).toContain("at most 450 characters");
    expect(FIRST_DAY_REQUEST).toContain('"How I\'ll help:"');
    // Under 60 asked, so the answer lands under S11.1's 70: asked for 70, bullets ran to 80.
    expect(FIRST_DAY_REQUEST).toContain("under 60 characters");
    expect(FIRST_DAY_REQUEST).toContain(FIRST_DAY_CLOSE);
    // And nothing about reply buttons, which made the model reach for them.
    expect(FIRST_DAY_REQUEST).not.toMatch(/repl|button|tap/i);
  });
});

describe("what Chat asks for when it can't read mail", () => {
  test("no reading, what it can do now, and the card to connect", () => {
    expect(FIRST_DAY_REQUEST_WITHOUT_MAIL).toMatch(/^Get to know me\./);
    expect(FIRST_DAY_REQUEST_WITHOUT_MAIL).toContain("aren't connected");
    expect(FIRST_DAY_REQUEST_WITHOUT_MAIL).toContain("don't try to read them");
    // Named by its id, so the card's tool can find it.
    expect(FIRST_DAY_REQUEST_WITHOUT_MAIL).toContain(
      "show me the card to connect them: it is one app, google-workspace, but don't write that id to me.",
    );
  });

  test("its plan promises no mail, and every other request keeps the mail plan", () => {
    expect(firstDayPlan(FIRST_DAY_REQUEST_WITHOUT_MAIL)).toBe(
      FIRST_DAY_PLAN_WITHOUT_MAIL,
    );
    expect(FIRST_DAY_PLAN_WITHOUT_MAIL).not.toMatch(/check your|read your/);
    expect(firstDayPlan(FIRST_DAY_REQUEST)).toBe(FIRST_DAY_PLAN);
    // A first day sent before the choice existed is drawn as it was sent.
    expect(firstDayPlan("Get to know me.")).toBe(FIRST_DAY_PLAN);
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

  test("draws the plan that went with the request, so no mail is promised without it", async () => {
    appQueryClient.setQueryData(
      authKeys.currentUser(),
      userNamed("transcript-no-mail", "Maya Chen"),
    );
    const view = render(
      <ChatTranscript
        messages={[
          {
            id: "first-day-no-mail",
            role: "user",
            content: frameFirstDay(FIRST_DAY_REQUEST_WITHOUT_MAIL, {
              mail: false,
            }),
          },
        ]}
      />,
    );
    await settleReactWork();

    expect(view.getByText(FIRST_DAY_PLAN_WITHOUT_MAIL)).toBeTruthy();
    expect(view.queryByText(FIRST_DAY_PLAN)).toBeNull();
    expect(view.container.textContent).not.toContain(
      FIRST_DAY_REQUEST_WITHOUT_MAIL,
    );
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
  test("resumes finding its conversation after a busy event interrupts pagination", async () => {
    const other = { ...summary("other", null), agentIds: ["another-bot"] };
    const target = summary("later-chat", "2026-10-22T10:00:00.000Z");
    const targetPage = { channels: [target], nextCursor: null };
    const page = { channels: [{ ...other, busy: true }], nextCursor: "older" };
    const [obsolete, refresh, next] = [held(), held(), held()];
    let firstSignal: AbortSignal | null | undefined;
    const transport = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bots/attention") return Response.json({ bots: [] });
        if (path === "/api/channels") return refresh.promise;
        if (path === "/api/channels?cursor=older") {
          if (!firstSignal) {
            firstSignal = init?.signal;
            return obsolete.promise;
          }
          return next.promise;
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    const view = openChat([other], {
      user: userNamed("interrupted-search", "Maya"),
      nextCursor: "older",
      transport,
    });
    try {
      await waitFor(() => expect(firstSignal).toBeDefined());
      await act(() => Bun.sleep(0));
      await act(async () =>
        updateChannelEventCache(view.client, {
          channelId: other.id,
          busy: true,
          lastMessage: null,
          lastMessageAt: null,
          lastMessageAgentId: null,
        }),
      );
      // Keep recovery pending through the observer notification and Chat's effect.
      await act(() => Bun.sleep(0));
      expect(firstSignal?.aborted).toBe(true);
      expect(view.queryByTestId("ongoing-chat")).toBeNull();
      await act(async () => obsolete.settle(Response.json(targetPage)));
      await act(async () => {
        refresh.settle(Response.json(page));
        next.settle(Response.json(targetPage));
      });
      await waitFor(() => {
        expect(
          view.getByTestId("ongoing-chat").getAttribute("data-channel"),
        ).toBe(target.id);
        expect(view.client.isFetching()).toBe(0);
      });
      for (const query of view.client.getQueryCache().getAll()) {
        expect(query.state.status).toBe("success");
      }
    } finally {
      view.unmount();
      for (const heldRequest of [obsolete, refresh, next])
        heldRequest.settle(Response.json({ channels: [], nextCursor: null }));
      await view.client.cancelQueries();
      view.client.clear();
      global.fetch = originalFetch;
      await settleReactWork();
    }
  });

  test("the greeting owns startup from routing through the channel handoff", async () => {
    const routing = held();
    const creating = held();
    answerRoute = () => routing.promise;
    answerCreate = () => creating.promise;
    const view = openChat([], { user: userNamed("routing-greeting", "Maya") });

    await waitFor(() => expect(routed()).toHaveLength(1));
    expect(created()).toHaveLength(0);
    const words = "Please send this first message";
    await act(async () => typeInto(view.container, words));
    const send = view.getByRole("button", {
      name: "Send message",
    });
    if (!(send instanceof HTMLButtonElement))
      throw new Error("The Send message control is not a button.");
    expect(send.disabled).toBe(true);
    const form = send.closest("form");
    if (!form) throw new Error("The composer form is missing.");
    await act(async () => {
      send.click();
      fireEvent.submit(form);
    });
    // Both the button and the submit handler refuse the draft: nothing was accepted or cleared.
    expect(view.container.querySelector("[contenteditable]")?.textContent).toBe(
      words,
    );
    expect(routed()).toHaveLength(1);

    await act(async () => routing.settle(routeAnswer()));
    await waitFor(() => expect(created()).toHaveLength(1));
    expect(send.disabled).toBe(true);
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(routed()).toHaveLength(1);
    await act(async () => creating.settle(Response.json({ channel: CREATED })));
    const ongoing = await view.findByTestId("ongoing-chat");
    expect(ongoing.getAttribute("data-channel")).toBe(CREATED.id);
    expect(created()).toHaveLength(1);
    expect(created()[0]?.body).toMatchObject({
      greeting: "with_mail",
    });
    expect(takeFirstMessage(CREATED.id)).toBeNull();
  });

  test("a failed greeting releases startup for an explicit first message", async () => {
    const routing = held();
    const creating = held();
    answerRoute = () => routing.promise;
    answerCreate = () => creating.promise;
    const view = openChat([], { user: userNamed("routing-recovery", "Maya") });

    await waitFor(() => expect(routed()).toHaveLength(1));
    await act(async () => typeInto(view.container, "Try this message"));
    const send = view.getByRole("button", {
      name: "Send message",
    });
    if (!(send instanceof HTMLButtonElement))
      throw new Error("The Send message control is not a button.");
    expect(send.disabled).toBe(true);
    // Routing records are advisory: rejection continues to creation, still owning startup.
    await act(async () =>
      routing.settle(
        Response.json({ error: "Routing unavailable" }, { status: 503 }),
      ),
    );
    await waitFor(() => expect(created()).toHaveLength(1));
    expect(send.disabled).toBe(true);
    await act(async () =>
      creating.settle(
        Response.json(
          { error: "Couldn't start the conversation." },
          { status: 503 },
        ),
      ),
    );
    expect((await view.findByRole("alert")).textContent).toBe(
      "Couldn't start the conversation.",
    );
    expect(send.disabled).toBe(false);
    expect(routed()).toHaveLength(1);

    answerRoute = async () => routeAnswer();
    answerCreate = async () => Response.json({ channel: CREATED });
    await act(async () => send.click());
    await view.findByTestId("ongoing-chat");
    expect(routed()).toHaveLength(2);
    expect(routed()[1]?.body).toMatchObject({ text: "Try this message" });
    expect(created()).toHaveLength(2);
    // Both carry the person's local date, which the first day takes as its morning brief.
    const date = expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/);
    expect(created().map((request) => request.body)).toEqual([
      { agentId: BOT.id, greeting: "with_mail", date },
      { agentId: BOT.id, date },
    ]);
    expect(takeFirstMessage(CREATED.id)).toBe("Try this message");
    expect(takeFirstMessage(CREATED.id)).toBeNull();
  });

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
    // The server owns greeting delivery; a browser remount cannot send it again.
    expect(created()[0]?.body).toMatchObject({
      greeting: "with_mail",
    });
    expect(takeFirstMessage(CREATED.id)).toBeNull();
    await settleReactWork();
    expect(routed()).toHaveLength(1);
  });

  test("with Gmail and Calendar not connected, it asks for what it can do, not for mail", async () => {
    answerGmail = async () =>
      Response.json({
        app: { key: "google-workspace", state: "not_connected" },
      });
    answerCreate = async () => Response.json({ channel: CREATED });
    const view = openChat([], { user: userNamed("no-mail", "Maya") });

    await view.findByTestId("ongoing-chat");
    expect(routed()).toHaveLength(1);
    expect(routed()[0]?.body).toMatchObject({
      text: frameFirstDay(FIRST_DAY_REQUEST_WITHOUT_MAIL, { mail: false }),
    });
    expect(created()[0]?.body).toMatchObject({
      greeting: "without_mail",
    });
    expect(takeFirstMessage(CREATED.id)).toBeNull();
  });

  test("draws the plan without mail while that conversation is being made", async () => {
    answerGmail = async () =>
      Response.json({ app: { key: "google-workspace", state: "not_granted" } });
    const creating = held();
    answerCreate = () => creating.promise;
    const view = openChat([], { user: userNamed("no-mail-drawing", "Maya") });

    await waitFor(() => expect(created()).toHaveLength(1));
    expect(view.getByText(FIRST_DAY_PLAN_WITHOUT_MAIL)).toBeTruthy();
    expect(view.queryByText(FIRST_DAY_PLAN)).toBeNull();

    await act(async () => creating.settle(Response.json({ channel: CREATED })));
    await view.findByTestId("ongoing-chat");
    takeFirstMessage(CREATED.id);
  });

  test("a Gmail state that could not be read promises no mail either", async () => {
    answerGmail = async () => Response.json({ error: "nope" }, { status: 503 });
    answerCreate = async () => Response.json({ channel: CREATED });
    const view = openChat([], { user: userNamed("gmail-unread", "Maya") });

    await view.findByTestId("ongoing-chat");
    expect(created()[0]?.body).toMatchObject({
      greeting: "without_mail",
    });
    expect(takeFirstMessage(CREATED.id)).toBeNull();
  });

  test("waits for whether it can read mail before it greets", async () => {
    const gmail = held();
    answerGmail = () => gmail.promise;
    answerCreate = async () => Response.json({ channel: CREATED });
    const view = openChat([], { user: userNamed("waits-for-gmail", "Maya") });

    await settleReactWork();
    expect(routed()).toHaveLength(0);
    await act(async () =>
      gmail.settle(
        Response.json({ app: { key: "google-workspace", state: "ready" } }),
      ),
    );
    await view.findByTestId("ongoing-chat");
    expect(created()[0]?.body).toMatchObject({
      greeting: "with_mail",
    });
    expect(takeFirstMessage(CREATED.id)).toBeNull();
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
    answerCreate = async () => Response.json({ channel: quiet });
    const view = openChat([quiet], { user: userNamed("quiet", "Maya") });

    const ongoing = await view.findByTestId("ongoing-chat");
    expect(ongoing.getAttribute("data-channel")).toBe(quiet.id);
    expect(created()).toHaveLength(1);
    expect(routed()).toHaveLength(1);
    expect(created()[0]?.body).toMatchObject({
      greeting: "with_mail",
    });
    expect(takeFirstMessage(quiet.id)).toBeNull();
  });

  test("another device's server claim opens its conversation without seeding a second greeting", async () => {
    answerCreate = async () =>
      Response.json({ start: { channel: CREATED, claimed: false } });
    const view = openChat([], { user: userNamed("second-device", "Maya") });
    const ongoing = await view.findByTestId("ongoing-chat");
    expect(ongoing.getAttribute("data-channel")).toBe(CREATED.id);
    expect(takeFirstMessage(CREATED.id)).toBeNull();
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
