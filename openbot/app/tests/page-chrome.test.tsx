import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
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
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { PageShell } from "@/components/layout/page-shell";
import { useEdgeSwipeBack } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/header";
import {
  PageChromeProvider,
  usePageChrome,
} from "@/components/shell/page-chrome";
import { tabForPath } from "@/components/shell/tab-bar";
import { channelKeys } from "@/lib/channels/queries";
import { Route as ConversationRoute } from "@/routes/_authed/_app/channel/$channelId";
import {
  conversationTitle,
  plainText,
} from "@/lib/channels/conversation-title";
import { settleReactWork } from "./settle-react-work";

/**
 * Every screen that is not a tab is a page in one chrome (parity-spec 2.9): a back disc, the page's
 * title in a pill, and no menu disc, avatar disc or tab bar. Bots, Connections, Settings and a
 * conversation opened from the menu all draw it, and none draws a header of its own.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function Swipeable() {
  const swipe = useEdgeSwipeBack();
  return (
    <div data-testid="page" {...swipe}>
      <p>One Bot</p>
    </div>
  );
}

function Conversation() {
  usePageChrome({ title: "Ship date with Ana", column: "phone" });
  return <p>The conversation</p>;
}

function draw(entries: string[]) {
  const root = createRootRoute({
    component: () => (
      <PageChromeProvider>
        <PageHeader />
        <main>
          <Outlet />
        </main>
      </PageChromeProvider>
    ),
  });
  const routes = [
    createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => <p>Chat</p>,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/bots",
      component: () => (
        <PageShell description="The Bots you work with." title="Bots">
          <p>Bot rows</p>
        </PageShell>
      ),
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/bots/one",
      component: () => (
        <PageShell
          backButton={{ label: "Bots", linkProps: { to: "/bots" } }}
          title="OpenDuet"
        >
          <p>One Bot</p>
        </PageShell>
      ),
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/channel/c1",
      component: Conversation,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/swipe",
      component: Swipeable,
    }),
  ];
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: entries }),
  });
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

function header(view: ReturnType<typeof render>) {
  return view.container.querySelector("header") as HTMLElement;
}

test("a page from the menu gets the back disc and its title in the pill, and nothing else", async () => {
  const { view } = draw(["/bots"]);
  await view.findByText("Bot rows");
  const chrome = header(view);
  expect(within(chrome).getByRole("button", { name: "Back" })).toBeTruthy();
  expect(chrome.textContent).toContain("Bots");
  // No menu disc and no avatar disc on a page.
  expect(within(chrome).queryByRole("button", { name: "Menu" })).toBeNull();
  expect(
    within(chrome).queryByRole("link", { name: "Your settings" }),
  ).toBeNull();
  // The page names itself once, in the pill; its heading stays for screen readers.
  const heading = view.getByRole("heading", { level: 1, name: "Bots" });
  expect(heading.className).toContain("sr-only");
  // No bar of its own above the page, and no Back link inside it.
  expect(view.queryByRole("link", { name: "Bots" })).toBeNull();
});

test("a conversation opened from the menu is a page too, named by what it is about", async () => {
  const { view } = draw(["/channel/c1"]);
  await view.findByText("The conversation");
  expect(header(view).textContent).toContain("Ship date with Ana");
  // `/channel/<id>` is not the Chat tab, so the shell draws it with no tab bar.
  expect(tabForPath("/channel/c1")).toBeNull();
});

test("back goes back through history", async () => {
  const { view, router } = draw(["/"]);
  await view.findByText("Chat");
  await act(() => router.navigate({ to: "/bots" }));
  await view.findByText("Bot rows");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Back" }));
  });
  await view.findByText("Chat");
  expect(router.state.location.pathname).toBe("/");
});

test("opened cold, back goes to the list the page came from", async () => {
  const { view, router } = draw(["/bots/one"]);
  await view.findByText("One Bot");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Back" }));
  });
  await view.findByText("Bot rows");
  expect(router.state.location.pathname).toBe("/bots");
});

test("a swipe in from the left edge goes back; one from the middle does not", async () => {
  const { view, router } = draw(["/"]);
  await view.findByText("Chat");
  await act(() => router.navigate({ to: "/swipe" as never }));
  const page = await view.findByTestId("page");
  const swipe = async (fromX: number, toX: number) =>
    act(async () => {
      fireEvent.touchStart(page, {
        touches: [{ clientX: fromX, clientY: 400 }],
      });
      fireEvent.touchEnd(page, {
        changedTouches: [{ clientX: toX, clientY: 410 }],
      });
    });
  await swipe(200, 320);
  expect(router.state.location.pathname).toBe("/swipe");
  await swipe(6, 140);
  await view.findByText("Chat");
  expect(router.state.location.pathname).toBe("/");
});

test("leaving a page takes its title out of the pill", async () => {
  const { view, router } = draw(["/bots"]);
  await view.findByText("Bot rows");
  await act(() => router.navigate({ to: "/" }));
  await view.findByText("Chat");
  expect(header(view).textContent).not.toContain("Bots");
});

describe("what a conversation is called", () => {
  test("its summary, then what was last said, never the Bot's name", () => {
    expect(
      conversationTitle({ summary: "Ship date with Ana", lastMessage: "Sure" }),
    ).toBe("Ship date with Ana");
    expect(
      conversationTitle({ summary: null, lastMessage: "Sure, Friday" }),
    ).toBe("Sure, Friday");
    expect(conversationTitle({ summary: null, lastMessage: null })).toBe(
      "New conversation",
    );
  });

  test("never the markdown the Bot wrote", () => {
    expect(
      conversationTitle({
        summary: null,
        lastMessage: "**What I think you do:** You run _Marlow_ Ceramics",
      }),
    ).toBe("What I think you do: You run Marlow Ceramics");
    expect(
      plainText("# Plan\n\n- for `Friday`, see [the doc](https://x.y)"),
    ).toBe("Plan for Friday, see the doc");
    // An identifier's underscores are not emphasis.
    expect(plainText("Ran gmail_search_messages")).toBe(
      "Ran gmail_search_messages",
    );
  });
});

describe("opening a conversation by its link", () => {
  type Loader = (input: {
    context: { queryClient: QueryClient };
    params: { channelId: string };
  }) => Promise<{ gone: boolean }>;
  const load = ConversationRoute.options.loader as unknown as Loader;
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function seeded(agentIds: string[]) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(channelKeys.detail("c1"), {
      id: "c1",
      name: "OpenDuet",
      agentIds,
      threadId: "t",
      active: true,
      lastMessageAt: null,
    });
    return queryClient;
  }

  test("a group goes to its shared transcript before this page draws", async () => {
    let thrown: unknown;
    try {
      await load({
        context: { queryClient: seeded(["a", "b"]) },
        params: { channelId: "c1" },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      options: { to: "/group/$channelId", params: { channelId: "c1" } },
    });
  });

  test("a conversation with one Bot draws here", async () => {
    expect(
      await load({
        context: { queryClient: seeded(["openduet"]) },
        params: { channelId: "c1" },
      }),
    ).toEqual({ gone: false });
  });

  test("a conversation that no longer exists is told apart from one that failed to load", async () => {
    const answering = (status: number) =>
      (async () =>
        Response.json(
          { error: "Couldn't find that conversation." },
          { status },
        )) as never;
    globalThis.fetch = answering(404);
    expect(
      await load({
        context: {
          queryClient: new QueryClient({
            defaultOptions: { queries: { retry: false } },
          }),
        },
        params: { channelId: "gone" },
      }),
    ).toEqual({ gone: true });
    globalThis.fetch = answering(500);
    expect(
      await load({
        context: {
          queryClient: new QueryClient({
            defaultOptions: { queries: { retry: false } },
          }),
        },
        params: { channelId: "broken" },
      }),
    ).toEqual({ gone: false });
  });
});
