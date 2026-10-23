import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MANAGE_STORAGE_KEY, MenuSheet } from "@/components/shell/menu-sheet";
import { TabBar, tabForPath } from "@/components/shell/tab-bar";
import { authKeys } from "@/lib/auth/queries";
import { Route as ActivityRoute } from "@/routes/_authed/_app/activity";
import { Route as InboxRoute } from "@/routes/_authed/_app/inbox";
import { channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The film's shell: the tab bar at the foot of Chat, Tasks and Pages, and the menu that opens on
 * Chat and the conversations, with every page OpenBot's sidebar listed under Manage and Settings.
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
let started: unknown[] = [];
function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/approvals") return Response.json(inbox);
    if (url.startsWith("/api/proactive/started"))
      return Response.json({ started, olderResolved: 0 });
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
  expect(tabForPath("/pages")).toBe("pages");
  // A page open over the list is still the Pages tab.
  expect(tabForPath("/pages/page-1")).toBe("pages");
  expect(tabForPath("/pages/page-1/more")).toBeNull();
  expect(tabForPath("/activity")).toBeNull();
  expect(tabForPath("/bots")).toBeNull();
  expect(tabForPath("/channel/abc")).toBeNull();
});

test("the tab bar draws Chat, Tasks and Pages, the current one marked", async () => {
  inbox = { requests: [], questions: [] };
  serving();
  const view = draw(<TabBar current="tasks" />, undefined, "/tasks");
  const nav = await view.findByRole("navigation", { name: "Main" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual([
    "Chat",
    "Tasks",
    "Pages",
  ]);
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/",
    "/tasks",
    "/pages",
  ]);
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

test("/activity, where earlier links point, goes to Pages", () => {
  const beforeLoad = ActivityRoute.options.beforeLoad as () => void;
  let thrown: unknown;
  try {
    beforeLoad();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ options: { to: "/pages", replace: true } });
});

test("on a page open over the list, the Pages tab is the one drawn current", async () => {
  inbox = { requests: [], questions: [] };
  serving();
  const view = draw(<TabBar current="pages" />, undefined, "/pages");
  const nav = await view.findByRole("navigation", { name: "Main" });
  expect(within(nav).getByRole("link", { current: "page" }).textContent).toBe(
    "Pages",
  );
});

test("the Tasks badge counts what Needs you lists: pending actions and open questions", async () => {
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
  expect(view.getByRole("link", { name: "Pages" })).toBeTruthy();
});

test("the Tasks badge counts started tasks that need input or failed, and each request only once", async () => {
  inbox = { requests: [pending("a"), pending("b")], questions: [] };
  const task = (id: string, state: string, waitingOn: unknown = null) => ({
    id,
    agentId: "openduet",
    title: id,
    detail: "",
    sourceApp: null,
    sourceLink: null,
    startedAt: "2026-10-22T05:00:00Z",
    state,
    next: null,
    waitingOn,
    resolvedAt: null,
    at: "2026-10-22T05:00:00Z",
    channelId: "chat",
  });
  started = [
    // Waits on request a, so a is not counted again.
    task("asks-to-send", "needs_input", { kind: "approval", id: "a" }),
    task("asks-in-its-reply", "needs_input"),
    task("broke", "failed"),
    task("running", "working"),
    task("read", "ready_for_review"),
    { ...task("checked", "needs_input"), resolvedAt: "2026-10-22T06:00:00Z" },
  ];
  serving();
  const view = draw(<TabBar current="chat" />);
  // Three tasks, and request b.
  expect(
    await view.findByRole("link", { name: "Tasks, 4 waiting" }),
  ).toBeTruthy();
  started = [];
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
const conversation = {
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
      pages: [{ channels: [conversation], nextCursor: null }],
      pageParams: [""],
    });
  };
}

/** The menu's rows, top to bottom, as a keyboard reaches them. */
function menuRows(dialog: HTMLElement) {
  const rows = ["link", "button", "textbox"].flatMap((role) =>
    within(dialog).getAllByRole(role),
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

test("the menu opens on Chat, a new conversation and the conversations, with Manage closed and Settings at the foot", async () => {
  serving();
  const view = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("admin", false),
  );
  const dialog = await view.findByRole("dialog");
  await within(dialog).findByRole("link", { name: /Ship date with Ana/ });
  const rows = menuRows(dialog);
  expect(rows[0]).toBe("Chat");
  expect(rows[1]).toBe("New conversation");
  expect(rows[2]).toBe("Search conversations");
  expect(rows[3]).toContain("Ship date with Ana");
  expect(rows.slice(4, 8)).toEqual(["Manage", "Settings", "Sign out", "Close"]);
  expect(
    within(dialog).getByRole("link", { name: "Chat" }).getAttribute("href"),
  ).toBe("/");
  expect(
    within(dialog)
      .getByRole("link", { name: "New conversation" })
      .getAttribute("href"),
  ).toBe("/start");
  expect(
    within(dialog).getByRole("link", { name: "Settings" }).getAttribute("href"),
  ).toBe("/settings");
  expect(manageToggle(dialog).getAttribute("aria-expanded")).toBe("false");
  expect(within(dialog).queryByRole("link", { name: "Bots" })).toBeNull();
  expect(within(dialog).queryByRole("link", { name: "Admin" })).toBeNull();
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
    "Conversations",
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
