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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  EARLIER_STORAGE_KEY,
  MANAGE_STORAGE_KEY,
  MenuSheet,
} from "@/components/shell/menu-sheet";
import { TabBar, tabForPath } from "@/components/shell/tab-bar";
import { authKeys } from "@/lib/auth/queries";
import { Route as ActivityRoute } from "@/routes/_authed/_app/activity";
import { Route as InboxRoute } from "@/routes/_authed/_app/inbox";
import { Route as PageLinkRoute } from "@/routes/_authed/_app/pages.$pageId";
import { Route as PagesRoute } from "@/routes/_authed/_app/pages.index";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The film's shell: the tab bar at the foot of Chat, Tasks and Pages, and the menu that opens on
 * Chat, with every other conversation under Earlier conversations and every page OpenBot's sidebar
 * listed under Manage and Settings.
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
  expect(tabForPath("/channel/abc")).toBeNull();
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

test("with nothing waiting Tasks carries no badge", async () => {
  inbox = { requests: [], questions: [] };
  serving();
  const view = draw(<TabBar current="chat" />);
  await view.findByRole("navigation", { name: "Main" });
  await waitFor(() =>
    expect(view.getByRole("link", { name: "Tasks" })).toBeTruthy(),
  );
});

/** One conversation besides Chat, so the roster has a row to place. */
const conversation: ChannelSummary = {
  id: "c1",
  name: "OpenDuet",
  agentIds: ["openduet"],
  threadId: "t1",
  active: true,
  lastMessageAt: "2026-10-21T10:00:00Z",
  summary: "Ship date with Ana",
  lastMessage: "Sent.",
  lastMessageAgentId: "openduet",
  createdAt: "2026-10-21T09:00:00Z",
  pinned: false,
  lastReadAt: "2026-10-21T10:00:00Z",
  taskId: null,
};

/** A task's own conversation, newer than the other: it belongs to Tasks, never to the menu. */
const taskConversation: ChannelSummary = {
  ...conversation,
  id: "c-task",
  threadId: "t-task",
  lastMessageAt: "2026-10-21T11:00:00Z",
  summary: "Draft a reply to Rosa",
  lastMessage: "Here's the draft.",
  createdAt: "2026-10-21T10:30:00Z",
  taskId: "task-1",
};

function seedMenu(role: "admin" | "user", localEvaluation: boolean) {
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
    client.setQueryData(channelKeys.list(), {
      pages: [{ channels: [taskConversation, conversation], nextCursor: null }],
      pageParams: [""],
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

function earlierToggle(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: "Earlier conversations" });
}

test("the menu opens on Chat, with Earlier conversations and Manage closed and Settings at the foot", async () => {
  serving();
  const view = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("admin", false),
  );
  const dialog = await view.findByRole("dialog");
  // Chat is the one thread: nothing else is a row until Earlier conversations is opened.
  expect(menuRows(dialog)).toEqual([
    "Chat",
    "Earlier conversations",
    "Manage",
    "Settings",
    "Sign out",
    "Close",
  ]);
  expect(
    within(dialog).getByRole("link", { name: "Chat" }).getAttribute("href"),
  ).toBe("/");
  expect(
    within(dialog).getByRole("link", { name: "Settings" }).getAttribute("href"),
  ).toBe("/settings");
  expect(earlierToggle(dialog).getAttribute("aria-expanded")).toBe("false");
  expect(manageToggle(dialog).getAttribute("aria-expanded")).toBe("false");
  expect(
    within(dialog).queryByRole("link", { name: "New conversation" }),
  ).toBeNull();
  expect(within(dialog).queryByRole("link", { name: "Bots" })).toBeNull();
  expect(within(dialog).queryByRole("link", { name: "Admin" })).toBeNull();
});

test("Earlier conversations opens on a click, starts a new one, lists the rest without tasks' own, and is remembered", async () => {
  serving();
  const user = userEvent.setup({ document });
  const first = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("admin", false),
  );
  const dialog = await first.findByRole("dialog");
  await user.click(earlierToggle(dialog));
  expect(earlierToggle(dialog).getAttribute("aria-expanded")).toBe("true");
  await within(dialog).findByRole("link", { name: /Ship date with Ana/ });
  const rows = menuRows(dialog);
  expect(rows.slice(0, 4)).toEqual([
    "Chat",
    "Earlier conversations",
    "New conversation",
    "Search conversations",
  ]);
  expect(rows[4]).toContain("Ship date with Ana");
  expect(rows.slice(5)).toEqual(["Manage", "Settings", "Sign out", "Close"]);
  // The task's conversation is newer, and still not here: it opens from Tasks.
  expect(
    within(dialog).queryByRole("link", { name: /Draft a reply to Rosa/ }),
  ).toBeNull();
  expect(
    within(dialog)
      .getByRole("link", { name: "New conversation" })
      .getAttribute("href"),
  ).toBe("/start");
  expect(window.localStorage.getItem(EARLIER_STORAGE_KEY)).toBe("open");

  cleanup();
  const again = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("admin", false),
  );
  const reopened = await again.findByRole("dialog");
  expect(earlierToggle(reopened).getAttribute("aria-expanded")).toBe("true");
  await user.click(earlierToggle(reopened));
  expect(
    within(reopened).queryByRole("link", { name: "New conversation" }),
  ).toBeNull();
  expect(window.localStorage.getItem(EARLIER_STORAGE_KEY)).toBe("closed");
});

test("the menu has one heading level", async () => {
  serving();
  const view = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("admin", true),
  );
  const dialog = await view.findByRole("dialog");
  const headings = within(dialog).getAllByRole("heading");
  expect(headings.map((heading) => heading.tagName)).toEqual([
    "H2",
    "H2",
    "H2",
  ]);
  expect(headings.map((heading) => heading.textContent)).toEqual([
    expect.any(String),
    "Earlier conversations",
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

test("Chat is marked current on Chat and on no other page", async () => {
  serving();
  const onChat = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("admin", true),
  );
  const dialog = await onChat.findByRole("dialog");
  expect(
    within(dialog).getByRole("link", { current: "page" }).textContent,
  ).toBe("Chat");

  cleanup();
  const onInbox = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("admin", true),
    "/inbox",
  );
  const elsewhere = await onInbox.findByRole("dialog");
  expect(
    within(elsewhere)
      .getByRole("link", { name: "Chat" })
      .getAttribute("aria-current"),
  ).toBeNull();
});
