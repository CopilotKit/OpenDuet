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
import type { ReactNode } from "react";
import { MenuSheet } from "@/components/shell/menu-sheet";
import { TabBar, tabForPath } from "@/components/shell/tab-bar";
import { authKeys } from "@/lib/auth/queries";
import { channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The film's shell: the tab bar at the foot of Chat, Inbox and Activity, and the menu that keeps
 * every page OpenBot's sidebar listed one tap away.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

let inbox: Record<string, unknown> = { requests: [], questions: [] };
function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/approvals") return Response.json(inbox);
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
  expect(tabForPath("/inbox")).toBe("inbox");
  expect(tabForPath("/inbox/")).toBe("inbox");
  expect(tabForPath("/activity")).toBe("activity");
  expect(tabForPath("/bots")).toBeNull();
  expect(tabForPath("/channel/abc")).toBeNull();
});

test("the tab bar draws Chat, Inbox and Activity, the current one marked", async () => {
  inbox = { requests: [], questions: [] };
  serving();
  const view = draw(<TabBar current="inbox" />, undefined, "/inbox");
  const nav = await view.findByRole("navigation", { name: "Main" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual([
    "Chat",
    "Inbox",
    "Activity",
  ]);
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/",
    "/inbox",
    "/activity",
  ]);
  expect(within(nav).getByRole("link", { current: "page" }).textContent).toBe(
    "Inbox",
  );
});

test("the Inbox badge counts what the Inbox lists: pending actions and open questions", async () => {
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
    await view.findByRole("link", { name: "Inbox, 3 waiting" }),
  ).toBeTruthy();
});

test("with nothing waiting the Inbox carries no badge", async () => {
  inbox = { requests: [], questions: [] };
  serving();
  const view = draw(<TabBar current="chat" />);
  await view.findByRole("navigation", { name: "Main" });
  await waitFor(() =>
    expect(view.getByRole("link", { name: "Inbox" })).toBeTruthy(),
  );
});

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
      pages: [{ channels: [], nextCursor: null }],
      pageParams: [""],
    });
  };
}

const PAGES = [
  ["New conversation", "/start"],
  ["Bots", "/bots"],
  ["Connections", "/connections"],
  ["Capabilities", "/capabilities"],
  ["Routines", "/routines"],
  ["Approval rules", "/settings/approvals"],
  ["Settings", "/settings"],
];

test("the menu lists every page the sidebar had, and Admin for an admin", async () => {
  serving();
  const view = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("admin", false),
  );
  const nav = await view.findByRole("navigation", { name: "Pages" });
  for (const [label, href] of PAGES) {
    expect(
      within(nav).getByRole("link", { name: label }).getAttribute("href"),
    ).toBe(href);
  }
  expect(within(nav).getByRole("link", { name: "Admin" })).toBeTruthy();
  expect(within(nav).getByRole("button", { name: "Sign out" })).toBeTruthy();
  expect(
    view.getByRole("textbox", { name: "Search conversations" }),
  ).toBeTruthy();
});

test("a member sees no Admin, and a single-person install has no Sign out", async () => {
  serving();
  const view = draw(
    <MenuSheet onOpenChange={() => {}} open />,
    seedMenu("user", true),
  );
  const nav = await view.findByRole("navigation", { name: "Pages" });
  expect(within(nav).getAllByRole("link")).toHaveLength(PAGES.length);
  expect(within(nav).queryByRole("link", { name: "Admin" })).toBeNull();
  expect(within(nav).queryByRole("button", { name: "Sign out" })).toBeNull();
});
