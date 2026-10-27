import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { Channel } from "@/components/app-sidebar/channel";
import {
  ARCHIVED_STORAGE_KEY,
  EVERYTHING_LINE,
  MANAGE_STORAGE_KEY,
  MenuSheet,
} from "@/components/shell/menu-sheet";
import { TabBar, tabForPath } from "@/components/shell/tab-bar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { type DuetChannel, duetChannelKeys } from "@/lib/duet-channels/queries";
import { Route as ActivityRoute } from "@/routes/_authed/_app/activity";
import { Route as InboxRoute } from "@/routes/_authed/_app/inbox";
import { Route as PageLinkRoute } from "@/routes/_authed/_app/pages.$pageId";
import { Route as PagesRoute } from "@/routes/_authed/_app/pages.index";
import { settleReactWork } from "./settle-react-work";

/**
 * The film's shell: the tab bar at the foot of Chat, Tasks and Make, and the drawer that opens on
 * Everything, then the person's channels, New channel and Archived, with every page OpenBot's
 * sidebar listed under Manage and Settings.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(cleanup);
afterEach(() => window.localStorage.clear());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

let inbox: Record<string, unknown> = { requests: [], questions: [] };
let tasks: unknown[] = [];
afterEach(() => {
  tasks = [];
});
function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/approvals") return Response.json(inbox);
    if (url === "/api/openduet/tasks") return Response.json({ tasks });
    if (url.startsWith("/api/bots/attention"))
      return Response.json({ bots: [] });
    if (url === "/api/settings/preferences")
      return Response.json({
        preferences: {
          messageListEmphasis: "thread",
          selfHostBannerDismissed: false,
        },
      });
    return Response.json({});
  }) as unknown as typeof fetch;
}

function draw(
  ui: ReactNode,
  seed: (client: QueryClient) => void = () => {},
  path = "/",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seed(client);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const pending = (id: string) => ({
  id,
  status: "pending",
  createdAt: "2026-10-21T10:00:00Z",
  action: {
    botId: "openduet",
    toolRef: "gmail/GMAIL_SEND_EMAIL",
    effect: "write",
    scope: "ana@example.com",
    threadId: "thread",
    args: { to: "ana@example.com", subject: "Ship date", body: "Hi Ana" },
    target: {},
  },
});

test("the paths of the three tabs, and no tab for the pages the menu opens", () => {
  expect(tabForPath("/")).toBe("chat");
  expect(tabForPath("/tasks")).toBe("tasks");
  expect(tabForPath("/tasks/")).toBe("tasks");
  expect(tabForPath("/make")).toBe("make");
  // Something open over the grid is still the Make tab, and a task open over Tasks still Tasks.
  expect(tabForPath("/make/page-1")).toBe("make");
  expect(tabForPath("/make/page-1/more")).toBeNull();
  // Pages became Make; its old paths redirect before a tab is drawn.
  expect(tabForPath("/pages")).toBeNull();
  expect(tabForPath("/tasks/task-1")).toBe("tasks");
  expect(tabForPath("/tasks/task-1/more")).toBeNull();
  expect(tabForPath("/activity")).toBeNull();
  expect(tabForPath("/bots")).toBeNull();
  // A conversation opened from the menu is a page over the app, not Chat.
  expect(tabForPath("/channel/abc")).toBeNull();
  expect(tabForPath("/channel/abc/")).toBeNull();
  expect(tabForPath("/channel/new")).toBeNull();
  expect(tabForPath("/group/abc")).toBeNull();
  // A channel is a conversation like Chat's, under Chat's tab.
  expect(tabForPath("/channels/abc")).toBe("chat");
  expect(tabForPath("/channels/abc/more")).toBeNull();
});

test("the tab bar draws Chat, Tasks and Make, the current one marked", async () => {
  inbox = { requests: [], questions: [] };
  serving();
  const view = draw(<TabBar current="tasks" />, undefined, "/tasks");
  const nav = await view.findByRole("navigation", { name: "Main" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual([
    "Chat",
    "Tasks",
    "Make",
  ]);
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/",
    "/tasks",
    "/make",
  ]);
  // Make's glyph is the spark, not Pages' sheet of paper.
  expect(links[2]?.querySelector("svg path")?.getAttribute("d")).toMatch(
    /^M10\.6 3\.6/,
  );
  expect(within(nav).getByRole("link", { current: "page" }).textContent).toBe(
    "Tasks",
  );
});

test("/inbox, where earlier notifications and links point, goes to Tasks", () => {
  const beforeLoad = InboxRoute.options.beforeLoad as () => void;
  let thrown: unknown;
  try {
    beforeLoad();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ options: { to: "/tasks", replace: true } });
});

/** What a redirecting route's `beforeLoad` throws. */
function redirectOf(beforeLoad: unknown, input: unknown = {}): unknown {
  try {
    (beforeLoad as (input: unknown) => void)(input);
  } catch (error) {
    return error;
  }
  return undefined;
}

test("/activity and /pages, where earlier links point, go to Make", () => {
  expect(redirectOf(ActivityRoute.options.beforeLoad)).toMatchObject({
    options: { to: "/make", replace: true },
  });
  expect(redirectOf(PagesRoute.options.beforeLoad)).toMatchObject({
    options: { to: "/make", replace: true },
  });
});

test("a /pages/<id> link, as Chat's older cards wrote it, opens the same page under Make", () => {
  expect(
    redirectOf(PageLinkRoute.options.beforeLoad, {
      params: { pageId: "deck-1" },
    }),
  ).toMatchObject({
    options: {
      to: "/make/$pageId",
      params: { pageId: "deck-1" },
      replace: true,
    },
  });
});

test("the redirects land where they say when a router follows them", async () => {
  const root = createRootRoute({ component: Outlet });
  const route = (path: string, beforeLoad?: unknown) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p>{path}</p>,
      ...(beforeLoad ? { beforeLoad: beforeLoad as never } : {}),
    });
  const router = createRouter({
    routeTree: root.addChildren([
      route("/make"),
      route("/make/$pageId"),
      route("/pages/", PagesRoute.options.beforeLoad),
      route("/pages/$pageId", PageLinkRoute.options.beforeLoad),
      route("/activity", ActivityRoute.options.beforeLoad),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  for (const [from, to] of [
    ["/pages", "/make"],
    ["/pages/deck-1", "/make/deck-1"],
    ["/activity", "/make"],
  ] as const) {
    await router.navigate({ to: from as never });
    await waitFor(() => expect(router.state.location.pathname).toBe(to));
  }
});

test("on a page open over the grid, the Make tab is the one drawn current", async () => {
  inbox = { requests: [], questions: [] };
  serving();
  const view = draw(<TabBar current="make" />, undefined, "/make");
  const nav = await view.findByRole("navigation", { name: "Main" });
  expect(within(nav).getByRole("link", { current: "page" }).textContent).toBe(
    "Make",
  );
});

test("the Tasks badge counts the approvals and questions waiting outside any task", async () => {
  inbox = {
    requests: [
      pending("a"),
      pending("b"),
      { ...pending("decided"), status: "completed", decision: "allow_once" },
    ],
    questions: [
      {
        id: "q",
        botId: "openduet",
        threadId: "t",
        question: "Which deck?",
        createdAt: "2026-10-21T10:00:00Z",
      },
    ],
  };
  serving();
  const view = draw(<TabBar current="chat" />);
  expect(
    await view.findByRole("link", { name: "Tasks, 3 waiting" }),
  ).toBeTruthy();
  expect(view.getByRole("link", { name: "Make" })).toBeTruthy();
});

test("the Tasks badge counts what Needs input lists: a task waiting on the person once, with its own approval", async () => {
  const task = (id: string, status: string) => ({
    id,
    botId: "openduet",
    channelId: `${id}-channel`,
    threadId: `${id}-thread`,
    title: id,
    why: null,
    origin: "asked",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
    status,
    resolvedAt: null,
    createdAt: "2026-10-21T10:00:00Z",
    updatedAt: "2026-10-21T10:00:00Z",
  });
  tasks = [
    task("rosa", "needs_input"),
    task("sam", "working"),
    task("hearth", "ready_for_review"),
  ];
  const inRosa = pending("in-rosa");
  inbox = {
    // Rosa's own approval is Rosa's task, counted once; the other is on its own.
    requests: [
      { ...inRosa, action: { ...inRosa.action, threadId: "rosa-thread" } },
      pending("loose"),
    ],
    questions: [],
  };
  serving();
  const view = draw(<TabBar current="chat" />);
  expect(
    await view.findByRole("link", { name: "Tasks, 2 waiting" }),
  ).toBeTruthy();
});

test("the current tab sits on the one capsule, which slides between tabs, and the badge pops in with its count", async () => {
  inbox = { requests: [pending("a"), pending("b")], questions: [] };
  serving();
  const view = draw(<TabBar current="tasks" />, undefined, "/tasks");
  const tasksTab = await view.findByRole("link", { name: "Tasks, 2 waiting" });
  const nav = view.getByRole("navigation", { name: "Main" });
  // One capsule, under the current tab only: it is moved, not drawn afresh in each tab.
  const capsules = nav.querySelectorAll("[data-tab-capsule]");
  expect(capsules).toHaveLength(1);
  expect(tasksTab.contains(capsules[0] as Node)).toBe(true);
  const badge = tasksTab.querySelector<HTMLElement>("[data-tab-badge]");
  expect(badge?.textContent).toBe("2");
  // Arriving, it starts small and clear of its place, and springs into it.
  expect(badge?.style.opacity).toBe("0");
  expect(badge?.style.transform).toContain("scale(0.5)");
});

test("with nothing waiting Tasks carries no badge", async () => {
  inbox = { requests: [], questions: [] };
  serving();
  const view = draw(<TabBar current="chat" />);
  await view.findByRole("navigation", { name: "Main" });
  await waitFor(() =>
    expect(view.getByRole("link", { name: "Tasks" })).toBeTruthy(),
  );
});

/** A channel as the drawer lists it. */
const channel = (
  id: string,
  name: string,
  purpose: string | null,
  look: Pick<DuetChannel, "icon" | "colour">,
  archivedAt: string | null = null,
): DuetChannel => ({
  id,
  name,
  purpose,
  ...look,
  dressed: true,
  archivedAt,
  agentIds: ["openduet"],
  lastMessageAt: "2026-10-21T10:00:00Z",
  createdAt: "2026-10-21T09:00:00Z",
});

const kiln = {
  ...channel(
    "c-kiln",
    "Kiln move",
    "Moving the studio's kiln to the new space by March.",
    { icon: "home", colour: "green" },
  ),
  createdAt: "2026-10-20T09:00:00Z",
};
const glazes = channel("c-glaze", "Glazes", "Ordering glaze for spring.", {
  icon: "bag",
  colour: "berry",
});
const oldShow = channel(
  "c-show",
  "Autumn show",
  "The October studio show.",
  { icon: "calendar", colour: "amber" },
  "2026-10-20T10:00:00Z",
);

function seedMenu(
  role: "admin" | "user",
  localEvaluation: boolean,
  // As the server lists them, newest activity first; the drawer shows them in the order made.
  channels: DuetChannel[] = [glazes, kiln, oldShow],
) {
  return (client: QueryClient) => {
    client.setQueryData(authKeys.currentUser(), {
      id: "u",
      email: "maya@example.com",
      name: "Maya",
      role,
      onboarding: null,
    });
    client.setQueryData(deploymentKeys.capabilities(), {
      generativeUi: true,
      selfHostBanner: true,
      localEvaluation,
    });
    client.setQueryData(agentKeys.list(), [
      {
        id: "openduet",
        name: "OpenDuet",
        title: "Your proactive assistant",
        roleDescription: "",
        visibility: "public",
      },
    ]);
    client.setQueryData(duetChannelKeys.list("openduet"), {
      everythingId: "c-everything",
      channels,
    });
  };
}

/** The menu's rows, top to bottom, as a keyboard reaches them. */
function menuRows(dialog: HTMLElement) {
  const rows = ["link", "button", "textbox"].flatMap((role) =>
    within(dialog).queryAllByRole(role),
  );
  rows.sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
  return rows.map(
    (row) => row.getAttribute("aria-label") || row.textContent?.trim() || "",
  );
}

function manageToggle(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: "Manage" });
}

function archivedToggle(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: /^Archived/ });
}

test("the drawer reads Everything, the channels, New channel, Archived folded, then Manage and Settings", async () => {
  serving();
  const view = draw(
    <MenuSheet onNewChannel={() => {}} onOpenChange={() => {}} open />,
    seedMenu("admin", false),
  );
  const dialog = await view.findByRole("dialog");
  await within(dialog).findByRole("link", { name: /Kiln move/ });
  expect(menuRows(dialog)).toEqual([
    `Everything${EVERYTHING_LINE}`,
    `Kiln move${kiln.purpose}`,
    `Glazes${glazes.purpose}`,
    "New channel",
    "Archived",
    "Manage",
    "Settings",
    "Sign out",
  ]);
  // Everything is Chat, the one thread.
  expect(
    within(dialog)
      .getByRole("link", { name: /Everything/ })
      .getAttribute("href"),
  ).toBe("/");
  expect(
    within(dialog)
      .getByRole("link", { name: /Kiln move/ })
      .getAttribute("href"),
  ).toBe("/channels/c-kiln");
  // Each channel is its icon, stroked in its colour.
  const disc = within(dialog)
    .getByRole("link", { name: /Kiln move/ })
    .querySelector("[data-channel-icon]");
  expect(disc?.getAttribute("data-channel-icon")).toBe("home");
  expect(disc?.getAttribute("data-channel-colour")).toBe("green");
  // Archived is folded, and the archived channel is not a row until it opens.
  expect(archivedToggle(dialog).getAttribute("aria-expanded")).toBe("false");
  expect(
    within(dialog).queryByRole("link", { name: /Autumn show/ }),
  ).toBeNull();
  // Earlier conversations and New conversation went away.
  expect(
    within(dialog).queryByRole("button", { name: "Earlier conversations" }),
  ).toBeNull();
  expect(
    within(dialog).queryByRole("link", { name: "New conversation" }),
  ).toBeNull();
  expect(manageToggle(dialog).getAttribute("aria-expanded")).toBe("false");
  expect(within(dialog).queryByRole("link", { name: "Bots" })).toBeNull();
});

test("Everything's own conversation is never a channel row", async () => {
  serving();
  const view = draw(
    <MenuSheet onNewChannel={() => {}} onOpenChange={() => {}} open />,
    seedMenu("admin", true),
  );
  const dialog = await view.findByRole("dialog");
  await within(dialog).findByRole("link", { name: /Kiln move/ });
  expect(
    within(dialog)
      .getAllByRole("link")
      .some((link) => link.getAttribute("href") === "/channels/c-everything"),
  ).toBe(false);
});

test("Archived opens on a click, lists what was put away with Unarchive, and is remembered", async () => {
  serving();
  const posted: string[] = [];
  const base = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posted.push(url);
      return Response.json({ channel: { ...oldShow, archivedAt: null } });
    }
    return base(input, init);
  }) as typeof fetch;
  const user = userEvent.setup({ document });
  const first = draw(
    <MenuSheet onNewChannel={() => {}} onOpenChange={() => {}} open />,
    seedMenu("admin", true),
  );
  const dialog = await first.findByRole("dialog");
  await user.click(archivedToggle(dialog));
  expect(archivedToggle(dialog).getAttribute("aria-expanded")).toBe("true");
  const shelf = within(dialog).getByRole("list", { name: "Archived channels" });
  expect(
    within(shelf)
      .getByRole("link", { name: /Autumn show/ })
      .getAttribute("href"),
  ).toBe("/channels/c-show");
  expect(window.localStorage.getItem(ARCHIVED_STORAGE_KEY)).toBe("open");
  await user.click(
    within(shelf).getByRole("button", { name: "Unarchive Autumn show" }),
  );
  await waitFor(() =>
    expect(posted).toEqual(["/api/openduet/channels/c-show/unarchive"]),
  );

  cleanup();
  const again = draw(
    <MenuSheet onNewChannel={() => {}} onOpenChange={() => {}} open />,
    seedMenu("admin", true),
  );
  const reopened = await again.findByRole("dialog");
  expect(archivedToggle(reopened).getAttribute("aria-expanded")).toBe("true");
  await user.click(archivedToggle(reopened));
  expect(window.localStorage.getItem(ARCHIVED_STORAGE_KEY)).toBe("closed");
});

test("conversations from before channels are not channels: they sit under Archived as Earlier conversations, titled by their summary", async () => {
  serving();
  const user = userEvent.setup({ document });
  const old = (
    id: string,
    summary: string | null,
    lastMessage: string | null,
    lastMessageAt: string,
  ): DuetChannel => ({
    ...channel(id, "OpenDuet", null, { icon: "folder", colour: "sky" }),
    dressed: false,
    summary,
    lastMessage,
    threadId: `${id}-thread`,
    lastMessageAt,
  });
  const view = draw(
    <MenuSheet onNewChannel={() => {}} onOpenChange={() => {}} open />,
    seedMenu("admin", true, [
      kiln,
      old(
        "c-old-1",
        "**Ship date** for Ana's mugs",
        null,
        "2026-10-19T10:00:00Z",
      ),
      old("c-old-2", null, "Which glaze for Rosa?", "2026-10-21T10:00:00Z"),
      // Nothing was ever said in it: nothing to go back to.
      { ...old("c-empty", null, null, ""), lastMessageAt: null },
    ]),
  );
  const dialog = await view.findByRole("dialog");
  const channels = await within(dialog).findByRole("list", {
    name: "Channels",
  });
  // Only what was made as a channel is one; no row is named after the Bot.
  expect(within(channels).getAllByRole("link")).toHaveLength(1);
  expect(within(dialog).queryByRole("link", { name: "OpenDuet" })).toBeNull();
  await user.click(archivedToggle(dialog));
  const earlier = within(dialog).getByRole("list", {
    name: "Earlier conversations",
  });
  const rows = within(earlier).getAllByRole("link");
  // Most recently used first, each titled in plain words and opened as the conversation it is.
  expect(rows.map((row) => row.textContent)).toEqual([
    "Which glaze for Rosa?",
    "Ship date for Ana's mugs",
  ]);
  expect(rows[1]?.getAttribute("href")).toBe("/channel/c-old-1");
});

test.each(["drawer", "sidebar"])(
  "%s title reads follow current row visibility and retain resolved titles",
  async (surface) => {
    serving();
    const originalObserver = globalThis.IntersectionObserver;
    const intersections = new Map<Element, (visible: boolean) => void>();
    globalThis.IntersectionObserver = class extends originalObserver {
      private targets = new Set<Element>();
      constructor(private callback: IntersectionObserverCallback) {
        super(callback);
      }
      observe(target: Element) {
        this.targets.add(target);
        intersections.set(target, (isIntersecting) =>
          this.callback(
            [
              {
                target,
                isIntersecting,
                intersectionRatio: Number(isIntersecting),
                boundingClientRect: target.getBoundingClientRect(),
                intersectionRect: target.getBoundingClientRect(),
                rootBounds: null,
                time: 0,
              },
            ],
            this,
          ),
        );
      }
      disconnect() {
        for (const target of this.targets) intersections.delete(target);
        this.targets.clear();
      }
    };
    const reads: string[] = [];
    let resolved = false;
    const base = global.fetch;
    global.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/copilotkit/threads/")) {
          reads.push(url);
          return Response.json({
            messages: resolved
              ? [{ id: "first", role: "user", content: "Spring glaze order" }]
              : [],
          });
        }
        return base(input, init);
      },
      { preconnect: base.preconnect },
    );
    const conversations = Array.from(
      { length: 3 },
      (_, i): DuetChannel => ({
        ...channel(`old-${i}`, "OpenDuet", null, {
          icon: "folder",
          colour: "sky",
        }),
        dressed: false,
        threadId: `old-${i}-thread`,
        lastMessage: `Latest ${i}`,
      }),
    );
    let client: QueryClient | undefined;
    try {
      const view = draw(
        surface === "drawer" ? (
          <MenuSheet onOpenChange={() => {}} open />
        ) : (
          conversations.map((row) => (
            <Channel
              key={row.id}
              channelId={row.id}
              participantIds={row.agentIds}
              name={row.name}
              threadId={row.threadId ?? undefined}
              lastMessage={row.lastMessage ?? undefined}
              said
              pinned={false}
              unread={false}
              busy={false}
              emphasis="thread"
            />
          ))
        ),
        (queryClient) => {
          client = queryClient;
          seedMenu("user", true, conversations)(queryClient);
        },
      );
      if (surface === "drawer") {
        const user = userEvent.setup({ document });
        await user.click(archivedToggle(await view.findByRole("dialog")));
      }
      const row = await view.findByRole("link", { name: /Latest 0/ });
      const visible = (shown: boolean) =>
        act(async () => {
          for (const [target, intersect] of intersections) {
            if (row.contains(target)) intersect(shown);
          }
        });
      // Invalidation exercises the real active-query gate without replacing its options.
      const refresh = () =>
        act(async () => {
          await client?.invalidateQueries({
            queryKey: ["channels", "first-message"],
          });
        });
      await refresh();
      expect(reads).toEqual([]);
      await visible(true);
      await waitFor(() => expect(reads).toHaveLength(1));
      await refresh();
      expect(reads).toHaveLength(2);
      await visible(false);
      await refresh();
      expect(reads).toHaveLength(2);
      resolved = true;
      await visible(true);
      await waitFor(() =>
        expect(row.textContent).toContain("Spring glaze order"),
      );
      expect(reads).toHaveLength(3);
      expect(new Set(reads)).toEqual(
        new Set([
          "/api/copilotkit/threads/old-0-thread/messages?agentId=openduet",
        ]),
      );
      await visible(false);
      await visible(true);
      await settleReactWork();
      expect(reads).toHaveLength(3);
      expect(row.textContent).toContain("Spring glaze order");
    } finally {
      cleanup();
      client?.clear();
      globalThis.IntersectionObserver = originalObserver;
    }
  },
);

test("New channel stays in reach under a long list of channels: only the channels scroll", async () => {
  serving();
  const many = Array.from({ length: 30 }, (_, index) =>
    channel(`c-${index}`, `Channel ${index}`, null, {
      icon: "folder",
      colour: "sky",
    }),
  );
  const view = draw(
    <MenuSheet onNewChannel={() => {}} onOpenChange={() => {}} open />,
    seedMenu("admin", true, many),
  );
  const dialog = await view.findByRole("dialog");
  const newChannel = await within(dialog).findByRole("button", {
    name: "New channel",
  });
  const scroller = within(dialog).getByTestId("drawer-channels");
  expect(scroller.className).toContain("overflow-y-auto");
  expect(within(scroller).getAllByRole("link")).toHaveLength(30);
  // Outside the part that scrolls, so it never moves below the fold with the channels.
  expect(scroller.contains(newChannel)).toBe(false);
});

test("with no channels yet the drawer is Everything and New channel, and no Archived", async () => {
  serving();
  const view = draw(
    <MenuSheet onNewChannel={() => {}} onOpenChange={() => {}} open />,
    seedMenu("admin", true, []),
  );
  const dialog = await view.findByRole("dialog");
  await within(dialog).findByRole("button", { name: "New channel" });
  expect(menuRows(dialog)).toEqual([
    `Everything${EVERYTHING_LINE}`,
    "New channel",
    "Manage",
    "Settings",
  ]);
});

test("New channel asks the shell to open the sheet", async () => {
  serving();
  let asked = 0;
  const user = userEvent.setup({ document });
  const view = draw(
    <MenuSheet
      onNewChannel={() => {
        asked += 1;
      }}
      onOpenChange={() => {}}
      open
    />,
    seedMenu("admin", true),
  );
  const dialog = await view.findByRole("dialog");
  await user.click(
    await within(dialog).findByRole("button", { name: "New channel" }),
  );
  expect(asked).toBe(1);
});

test("the menu has one heading level", async () => {
  serving();
  const view = draw(
    <MenuSheet onNewChannel={() => {}} onOpenChange={() => {}} open />,
    seedMenu("admin", true),
  );
  const dialog = await view.findByRole("dialog");
  await within(dialog).findByRole("link", { name: /Kiln move/ });
  const headings = within(dialog).getAllByRole("heading");
  expect(headings.map((heading) => heading.tagName)).toEqual([
    "H2",
    "H2",
    "H2",
  ]);
  expect(headings.map((heading) => heading.textContent)).toEqual([
    expect.any(String),
    "Archived",
    "Manage",
  ]);
});

const MANAGE = [
  ["Bots", "/bots"],
  ["Connections", "/connections"],
  ["Capabilities", "/capabilities"],
  ["Routines", "/routines"],
  ["Approval rules", "/settings/approvals"],
  ["Admin", "/admin"],
];

test("Manage opens on a click, lists the pages that set things up, and is remembered", async () => {
  serving();
  const user = userEvent.setup({ document });
  const first = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("admin", true),
  );
  const dialog = await first.findByRole("dialog");
  await user.click(manageToggle(dialog));
  expect(manageToggle(dialog).getAttribute("aria-expanded")).toBe("true");
  const group = document.getElementById(
    manageToggle(dialog).getAttribute("aria-controls") ?? "",
  );
  expect(group).toBeTruthy();
  const links = within(group as HTMLElement).getAllByRole("link");
  expect(
    links.map((link) => [link.textContent, link.getAttribute("href")]),
  ).toEqual(MANAGE);
  // Still above Settings, which stays a row of its own at the foot.
  const rows = menuRows(dialog);
  expect(rows.indexOf("Admin")).toBeLessThan(rows.indexOf("Settings"));
  expect(window.localStorage.getItem(MANAGE_STORAGE_KEY)).toBe("open");

  cleanup();
  const again = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("admin", true),
  );
  const reopened = await again.findByRole("dialog");
  expect(manageToggle(reopened).getAttribute("aria-expanded")).toBe("true");
  await user.click(manageToggle(reopened));
  expect(manageToggle(reopened).getAttribute("aria-expanded")).toBe("false");
  expect(within(reopened).queryByRole("link", { name: "Bots" })).toBeNull();
  expect(window.localStorage.getItem(MANAGE_STORAGE_KEY)).toBe("closed");
});

test("a member sees no Admin under Manage, and a single-person install has no Sign out", async () => {
  serving();
  const user = userEvent.setup({ document });
  const view = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("user", true),
  );
  const dialog = await view.findByRole("dialog");
  await user.click(manageToggle(dialog));
  expect(within(dialog).getByRole("link", { name: "Bots" })).toBeTruthy();
  expect(within(dialog).queryByRole("link", { name: "Admin" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Sign out" })).toBeNull();
});

test("Everything is marked current on Chat and on no other page", async () => {
  serving();
  const onChat = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("admin", true),
  );
  const dialog = await onChat.findByRole("dialog");
  expect(
    within(dialog).getByRole("link", { current: "page" }).textContent,
  ).toBe(`Everything${EVERYTHING_LINE}`);

  cleanup();
  const onInbox = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("admin", true),
    "/inbox",
  );
  const elsewhere = await onInbox.findByRole("dialog");
  expect(
    within(elsewhere)
      .getByRole("link", { name: /Everything/ })
      .getAttribute("aria-current"),
  ).toBeNull();
});
