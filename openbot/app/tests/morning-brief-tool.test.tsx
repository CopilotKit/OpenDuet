import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { connectAppRefusal } from "@openbot/shared/connect-prompt";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ConversationSendContext } from "@/components/channels/conversation-send";
import { MorningBriefCard } from "@/components/duet/morning-brief-card";
import { ActiveBotProvider, useActiveBot } from "@/lib/copilot/active-bot";
import {
  briefCard,
  emailHandOff,
  gapsOf,
  quietLine,
  readBrief,
  StartableBrief,
} from "@/lib/copilot/morning-brief-tool";
import type { TaskRecord } from "@/lib/tasks/queries";
import { appAccess } from "./app-access-fixture";
import { settleReactWork } from "./settle-react-work";

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

/** One of her tasks, as `GET /api/openduet/tasks` lists it. */
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: `task-${Math.random()}`,
    botId: "openduet",
    channelId: "c1",
    threadId: "t1",
    title: "A task",
    why: null,
    origin: "asked",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
    sourceRef: null,
    status: "working",
    failure: null,
    failedAt: null,
    resolvedAt: null,
    createdAt: "2026-10-22T08:00:00.000Z",
    updatedAt: "2026-10-22T08:00:00.000Z",
    ...overrides,
  };
}

/**
 * The server as the brief's Start meets it: her tasks, the email hand-off, and the live state of an
 * app to connect. Records what Start sent, and anything sent into the conversation instead.
 */
function serving(
  options: {
    tasks?: TaskRecord[];
    refuse?: boolean;
    app?: ReturnType<typeof appAccess>;
  } = {},
) {
  const tasks = [...(options.tasks ?? [])];
  const started: unknown[] = [];
  const sent: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/openduet/tasks/email" && init?.method === "POST") {
      if (options.refuse)
        return Response.json({ error: "No." }, { status: 503 });
      const body = JSON.parse(String(init.body));
      started.push(body);
      const opened = task({ sourceApp: "Gmail", sourceRef: body.messageId });
      tasks.push(opened);
      return Response.json({ task: opened }, { status: 201 });
    }
    if (url === "/api/openduet/tasks") return Response.json({ tasks });
    if (url.includes("/apps/"))
      return Response.json({ app: options.app ?? appAccess() });
    if (url.includes("/api/plugins/connections"))
      return Response.json({ connections: [], redirectUri: null });
    return Response.json({});
  }) as unknown as typeof fetch;
  return { started, sent };
}

function DeclaredBot({ botId }: { botId: string }) {
  useActiveBot(botId);
  return null;
}

/**
 * The brief as Chat draws it: inside a conversation, on a surface that declared its Bot, with a
 * router for the connect card's links. `conversation: false` draws it outside one; `botId: null`
 * before the surface has named its Bot.
 */
function mountBrief(
  children: ReactNode,
  options: { conversation?: boolean; botId?: string | null } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const botId = options.botId === undefined ? "openduet" : options.botId;
  const body = (
    <ActiveBotProvider>
      {botId ? <DeclaredBot botId={botId} /> : null}
      {options.conversation === false ? (
        children
      ) : (
        <ConversationSendContext.Provider
          value={{ send: () => true, isLatestTurn: () => true }}
        >
          {children}
        </ConversationSendContext.Provider>
      )}
    </ActiveBotProvider>
  );
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => body,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const BRIEF = {
  at: "2026-10-22T08:05:00",
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
  canWait: [
    {
      id: "m2",
      threadId: "t2",
      from: "Ceramics Monthly",
      subject: "Glazes",
      reason: "Bulk mail.",
      decidedBy: "rule:bulk",
    },
    {
      id: "m3",
      threadId: "t3",
      from: "Adobe",
      subject: "Receipt",
      reason: "Paid.",
      decidedBy: "model:test",
    },
    {
      id: "m4",
      threadId: "t4",
      from: "Stripe",
      subject: "Paid",
      reason: "FYI.",
      decidedBy: "model:test",
    },
    {
      id: "m5",
      threadId: "t5",
      from: "LinkedIn",
      subject: "Searches",
      reason: "Social.",
      decidedBy: "rule:category",
    },
  ],
  calendar: [
    {
      id: "e1",
      summary: "Studio visit with Hearth & Co",
      start: "2026-10-22T15:00:00",
      end: "2026-10-22T16:00:00",
    },
  ],
  couldNotCheck: [],
  read: { gmail: true, calendar: true },
  checked: { mail: 5, byRules: 2, byModel: 3 },
};

describe("reading the tool's result", () => {
  test("a brief parses; a refusal or anything else does not", () => {
    expect(readBrief(JSON.stringify(BRIEF))?.name).toBe("Maya");
    // As the runtime delivers a server tool's text: encoded once more.
    expect(readBrief(JSON.stringify(JSON.stringify(BRIEF)))?.name).toBe("Maya");
    expect(readBrief("Refused. Gmail is not connected.")).toBe(null);
    expect(readBrief({ not: "a string" })).toBe(null);
  });
});

describe("the card", () => {
  test("shows what needs her with its reason, folds what can wait into one row, and lists today", () => {
    const brief = readBrief(JSON.stringify(BRIEF));
    if (!brief) throw new Error("no brief");
    const card = briefCard(brief);
    expect(card.greeting).toBe("Morning, Maya.");
    expect(card.needsYou).toEqual([
      expect.objectContaining({
        title: "Ana Pereira · Friday ship date?",
        why: "Ana needs the Friday date confirmed today.",
      }),
    ]);
    expect(card.canWait).toEqual([
      expect.objectContaining({
        title: "4 emails can wait",
        why: "Ceramics Monthly, Adobe, Stripe and 1 more",
      }),
    ]);
    const view = render(<MorningBriefCard {...card} />);
    expect(view.getByText("Needs you")).toBeTruthy();
    expect(
      view.getByText("Ana needs the Friday date confirmed today."),
    ).toBeTruthy();
    expect(view.getByText("Today")).toBeTruthy();
    expect(view.getByText("Studio visit with Hearth & Co")).toBeTruthy();
    expect(view.queryByText("Couldn't check")).toBe(null);
  });

  test("says what it could not check, in the card", () => {
    const brief = readBrief(
      JSON.stringify({
        ...BRIEF,
        needsYou: [],
        canWait: [],
        calendar: [],
        read: { gmail: false, calendar: false },
        couldNotCheck: [
          {
            source: "Gmail",
            why: "Gmail and Google Calendar is not connected.",
          },
        ],
      }),
    );
    if (!brief) throw new Error("no brief");
    const view = render(<MorningBriefCard {...briefCard(brief)} />);
    expect(view.getByText("Couldn't check")).toBeTruthy();
    expect(
      view.getByText("Gmail and Google Calendar is not connected."),
    ).toBeTruthy();
    // An empty brief because Gmail is missing must not read as a quiet morning.
    expect(view.queryByText(/Nothing new needs you/)).toBe(null);
    expect(view.queryByText(/Nothing new came in/)).toBe(null);
  });

  const marker = connectAppRefusal({
    serverId: "google-workspace",
    title: "Gmail and Google Calendar",
    message:
      "You have not connected your Gmail and Google Calendar account. Connect it and ask again.",
  });
  const unconnected = {
    ...BRIEF,
    needsYou: [],
    canWait: [],
    calendar: [],
    read: { gmail: false, calendar: false },
  };

  test("an app to connect is one plain line, once, from a brief made today", () => {
    const brief = readBrief(
      JSON.stringify({
        ...unconnected,
        couldNotCheck: [
          {
            source: "Gmail and Google Calendar",
            why: "Not connected yet.",
            connect: {
              serverId: "google-workspace",
              title: "Gmail and Google Calendar",
              agentId: "openduet",
            },
          },
        ],
      }),
    );
    if (!brief) throw new Error("no brief");
    expect(briefCard(brief).notes).toEqual([
      {
        id: "gap-0",
        title: "Gmail and Google Calendar",
        why: "Not connected yet.",
      },
    ]);
  });

  test("a brief stored with the refusal's raw marker, twice, reads the same way: no marker, once", () => {
    // Exactly as the server wrote it before it read the marker itself, still in her thread.
    const brief = readBrief(
      JSON.stringify({
        ...unconnected,
        couldNotCheck: [
          { source: "Gmail", why: marker },
          { source: "Google Calendar", why: marker },
        ],
      }),
    );
    if (!brief) throw new Error("no brief");
    const gaps = gapsOf(brief);
    expect(gaps).toEqual([
      {
        source: "Gmail and Google Calendar",
        why: "Not connected yet.",
        connect: {
          serverId: "google-workspace",
          title: "Gmail and Google Calendar",
        },
      },
    ]);
    const view = render(<MorningBriefCard {...briefCard(brief)} />);
    expect(view.container.textContent).not.toContain("[connect-app]");
    expect(view.getAllByText("Not connected yet.")).toHaveLength(1);
  });

  test("under the brief, the app to connect gets the same connect card a refused call gets", async () => {
    serving({ app: appAccess({ state: "not_connected" }) });
    const brief = readBrief(
      JSON.stringify({
        ...unconnected,
        couldNotCheck: [
          { source: "Gmail", why: marker },
          { source: "Google Calendar", why: marker },
        ],
      }),
    );
    if (!brief) throw new Error("no brief");
    const view = mountBrief(<StartableBrief brief={brief} />);
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Connect Gmail" })).toBeTruthy(),
    );
    expect(view.container.querySelectorAll("[data-app-access]")).toHaveLength(
      1,
    );
  });
});

describe("a quiet morning", () => {
  const quiet = (overrides: Record<string, unknown>) => {
    const brief = readBrief(JSON.stringify({ ...BRIEF, ...overrides }));
    if (!brief) throw new Error("no brief");
    return brief;
  };

  test("an inbox read with nothing new in it says so plainly, beside today's calendar", () => {
    const brief = quiet({ needsYou: [], canWait: [] });
    expect(quietLine(brief)).toBe("Nothing new came in to your inbox.");
    const view = render(<MorningBriefCard {...briefCard(brief)} />);
    expect(view.getByText("Nothing new came in to your inbox.")).toBeTruthy();
    expect(view.getByText("Today")).toBeTruthy();
    expect(view.queryByText("Couldn't check")).toBe(null);
  });

  test("nothing read was in either, said once", () => {
    expect(quietLine(quiet({ needsYou: [], canWait: [], calendar: [] }))).toBe(
      "Nothing new came in, and nothing is on your calendar today.",
    );
  });

  test("a calendar read and empty is said too, under mail that needs her", () => {
    expect(quietLine(quiet({ calendar: [] }))).toBe(
      "Nothing is on your calendar today.",
    );
    expect(quietLine(quiet({}))).toBe(null);
  });

  test("an inbox it could not read is never called quiet", () => {
    const brief = quiet({
      needsYou: [],
      canWait: [],
      read: { gmail: false, calendar: true },
      couldNotCheck: [{ source: "Gmail", why: "The search failed." }],
    });
    expect(quietLine(brief)).toBe(null);
    const view = render(<MorningBriefCard {...briefCard(brief)} />);
    expect(view.queryByText(/Nothing new came in/)).toBe(null);
    expect(view.getByText("The search failed.")).toBeTruthy();
  });

  test("a brief from before it said what it read keeps the old line, and only when all is empty", () => {
    const { read: _read, ...old } = BRIEF;
    const brief = readBrief(
      JSON.stringify({ ...old, needsYou: [], canWait: [], calendar: [] }),
    );
    if (!brief) throw new Error("no brief");
    expect(briefCard(brief).quiet).toBeUndefined();
    const view = render(<MorningBriefCard {...briefCard(brief)} />);
    expect(
      view.getByText(
        "Nothing new needs you, and nothing is on your calendar today.",
      ),
    ).toBeTruthy();
  });
});

describe("Start on what needs her", () => {
  const brief = () => {
    const parsed = readBrief(JSON.stringify(BRIEF));
    if (!parsed) throw new Error("no brief");
    return parsed;
  };
  const START = { name: "Start: Ana Pereira · Friday ship date?" };

  test("hands the server the email by its id, never a sentence made of what the sender wrote", () => {
    const first = brief().needsYou[0];
    if (!first) throw new Error("no row");
    expect(emailHandOff(first, "openduet")).toEqual({
      botId: "openduet",
      messageId: "m1",
      from: "Ana Pereira",
      subject: "Friday ship date?",
      why: "Ana needs the Friday date confirmed today.",
    });
  });

  test("Start opens a task for the email, and the row reads Started", async () => {
    const server = serving();
    const view = mountBrief(<StartableBrief brief={brief()} />);
    fireEvent.click(await view.findByRole("button", START));
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Started" })).toBeTruthy(),
    );
    expect(server.started).toEqual([
      {
        botId: "openduet",
        messageId: "m1",
        from: "Ana Pereira",
        subject: "Friday ship date?",
        why: "Ana needs the Friday date confirmed today.",
      },
    ]);
    // Nothing went into the conversation as the person's words.
    expect(server.sent).toEqual([]);
    expect(
      (view.getByRole("button", { name: "Started" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("Started survives a reload: it is read from her tasks, not remembered by the card", async () => {
    // A fresh mount with nothing pressed, as after a reload or on her phone.
    serving({
      tasks: [task({ sourceApp: "Gmail", sourceRef: "m1" })],
    });
    const view = mountBrief(<StartableBrief brief={brief()} />);
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Started" })).toBeTruthy(),
    );
    expect(view.queryByRole("button", START)).toBe(null);
  });

  test("a task for another email, or from another app with the same id, leaves the row to start", async () => {
    serving({
      tasks: [
        task({ sourceApp: "Gmail", sourceRef: "m9" }),
        task({ sourceApp: "Slack", sourceRef: "m1" }),
        task({ sourceApp: "Gmail", sourceRef: null }),
      ],
    });
    const view = mountBrief(<StartableBrief brief={brief()} />);
    expect(await view.findByRole("button", START)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Started" })).toBe(null);
  });

  test("a start the server refused says so and can be pressed again", async () => {
    serving({ refuse: true });
    const view = mountBrief(<StartableBrief brief={brief()} />);
    fireEvent.click(await view.findByRole("button", START));
    await waitFor(() =>
      expect(view.getByText("Couldn't start · Try again")).toBeTruthy(),
    );
    expect(view.queryByRole("button", { name: "Started" })).toBe(null);
  });

  test("outside a conversation, or before the surface names its Bot, the brief has nothing to press", async () => {
    serving();
    const outside = mountBrief(<StartableBrief brief={brief()} />, {
      conversation: false,
    });
    expect(
      await outside.findByText("Ana needs the Friday date confirmed today."),
    ).toBeTruthy();
    expect(outside.queryByRole("button")).toBe(null);
    cleanup();
    const noBot = mountBrief(<StartableBrief brief={brief()} />, {
      botId: null,
    });
    expect(
      await noBot.findByText("Ana needs the Friday date confirmed today."),
    ).toBeTruthy();
    expect(noBot.queryByRole("button")).toBe(null);
  });
});

describe("a long brief", () => {
  const mailOf = (count: number, decidedBy = "model:triage") =>
    Array.from({ length: count }, (_, index) => ({
      id: `m${index}`,
      threadId: `t${index}`,
      from: `Sender ${index}`,
      subject: `Subject ${index}`,
      reason: `Reason ${index}`,
      decidedBy,
    }));
  const briefWith = (needsYou: ReturnType<typeof mailOf>) => {
    const parsed = readBrief(JSON.stringify({ ...BRIEF, needsYou }));
    if (!parsed) throw new Error("no brief");
    return parsed;
  };

  test("shows five rows that need her, and the rest one tap away", () => {
    const view = render(
      <MorningBriefCard {...briefCard(briefWith(mailOf(27)))} />,
    );
    expect(view.getByText("Sender 4 · Subject 4")).toBeTruthy();
    expect(view.queryByText("Sender 5 · Subject 5")).toBe(null);

    fireEvent.click(
      view.getByRole("button", { name: "Show 22 more in Needs you" }),
    );
    expect(view.getByText("Sender 26 · Subject 26")).toBeTruthy();
    expect(view.queryByRole("button", { name: /^Show \d+ more/ })).toBe(null);
  });

  test("a section one row over is shown whole, since Show 1 more saves nothing", () => {
    const view = render(
      <MorningBriefCard {...briefCard(briefWith(mailOf(6)))} />,
    );
    expect(view.getByText("Sender 5 · Subject 5")).toBeTruthy();
    expect(view.queryByRole("button", { name: /^Show \d+ more/ })).toBe(null);
  });

  test("mail that could not be sorted goes last, and Start still takes on the row it is on", async () => {
    const unsorted = mailOf(1, "unsorted").map((item) => ({
      ...item,
      id: "u0",
      from: "Unsorted",
    }));
    const brief = briefWith([...unsorted, ...mailOf(1)]);
    expect(briefCard(brief).needsYou.map((row) => row.id)).toEqual([
      "m0",
      "u0",
    ]);

    const server = serving();
    const view = mountBrief(<StartableBrief brief={brief} />);
    fireEvent.click(
      await view.findByRole("button", { name: "Start: Sender 0 · Subject 0" }),
    );
    await waitFor(() =>
      expect(server.started).toEqual([
        expect.objectContaining({ messageId: "m0", from: "Sender 0" }),
      ]),
    );
  });
});
