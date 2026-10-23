import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { useMemo } from "react";
import {
  type ConversationSend,
  ConversationSendContext,
} from "@/components/channels/conversation-send";
import { cardFor, forgetCards } from "@/components/duet/page-morph";
import {
  PageSheet,
  PageSheetHost,
  useCloseSheet,
} from "@/components/duet/page-sheet";
import { ConversationPageCard } from "@/lib/copilot/page-card-tool";
import { searchTextEntry } from "@/lib/search-text";
import { MakeScreen } from "@/components/shell/make-screen";
import { agentKeys } from "@/lib/agents/queries";
import type { PageSummary } from "@/lib/pages/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Opening something the Bot made from its card: the card grows into the sheet, the sheet takes
 * over, and closing shrinks it back into the card. With reduced motion the sheet fades instead.
 * The DOM here lays nothing out, so the card and the sheet are given rectangles.
 */

const originalFetch = global.fetch;
let originalMatchMedia: typeof window.matchMedia;
let originalRect: typeof Element.prototype.getBoundingClientRect;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalMatchMedia = window.matchMedia;
  originalRect = Element.prototype.getBoundingClientRect;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  forgetCards();
  global.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  Element.prototype.getBoundingClientRect = originalRect;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const deck: PageSummary = {
  id: "deck",
  kind: "slides",
  title: "Hearth & Co orders",
  summary: null,
  updatedAt: new Date("2026-10-22T09:41:00").toISOString(),
  slideCount: 1,
  preview: {
    title: "Mugs per day",
    blocks: [
      {
        type: "bars",
        items: [
          { label: "Mon", value: 12 },
          { label: "Tue", value: 24 },
        ],
      },
    ],
  },
};

function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/agents")
      return Response.json({ agents: [{ id: "openduet", name: "OpenDuet" }] });
    if (url === "/api/openduet/pages") return Response.json({ pages: [deck] });
    if (url === "/api/openduet/pages/deck")
      return Response.json({
        page: {
          ...deck,
          content: {
            slides: [{ title: "Mugs per day", blocks: deck.preview.blocks }],
          },
        },
      });
    return Response.json({});
  }) as unknown as typeof fetch;
}

function reducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const CARD = { top: 220, left: 16, width: 165, height: 180 };
const SHEET = { top: 12, left: 10, width: 355, height: 790 };

/** The card in the grid sits where a grid cell would; the sheet's card fills the screen. */
function layingOut() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const box = this.className.toString().includes("rounded-[28px]")
      ? SHEET
      : CARD;
    return {
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON: () => box,
    } as DOMRect;
  };
}

function PageRoute() {
  const { pageId } = useParams({ strict: false }) as { pageId: string };
  const navigate = useNavigate();
  const close = useCloseSheet(() => void navigate({ to: "/make" }));
  return <PageSheet onClose={close} pageId={pageId} />;
}

function app() {
  const root = createRootRoute({ component: Outlet });
  const make = createRoute({
    getParentRoute: () => root,
    path: "/make",
    component: () => (
      <>
        <MakeScreen />
        <Outlet />
      </>
    ),
  });
  const one = createRoute({
    getParentRoute: () => make,
    path: "$pageId",
    component: PageRoute,
  });
  const router = createRouter({
    routeTree: root.addChildren([make.addChildren([one])]),
    history: createMemoryHistory({ initialEntries: ["/make"] }),
  });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "openduet", name: "OpenDuet" },
  ]);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

const ghost = (direction: "open" | "close") =>
  document.querySelector<HTMLElement>(`[data-morph="${direction}"]`);

test("the card grows into its sheet, the sheet takes over, and closing shrinks it back into the card", async () => {
  reducedMotion(false);
  layingOut();
  serving();
  const { view, router } = app();
  const card = await view.findByRole("link", { name: /Hearth & Co orders/ });
  // The card is known by where it is, so the sheet can find it.
  expect(cardFor("deck")?.box).toEqual(CARD);

  fireEvent.click(card);
  const sheet = await view.findByRole("dialog", { name: "Hearth & Co orders" });
  // The stand-in sets off from the card's rectangle, carrying its face; the sheet waits under it.
  const opening = await waitFor(() => {
    const found = ghost("open");
    if (!found) throw new Error("no stand-in yet");
    return found;
  });
  expect(opening.getAttribute("aria-hidden")).toBe("true");
  expect(opening.textContent).toContain("Mugs per day");
  expect(opening.textContent).toContain("Hearth & Co orders");
  expect(sheet.querySelector("[data-morph-hidden]") === null).toBe(false);

  // It lands: the sheet shows and the stand-in goes.
  await waitFor(
    () => expect(document.querySelector("[data-morph]") === null).toBe(true),
    { timeout: 2_000 },
  );
  expect(sheet.querySelector("[data-morph-hidden]") === null).toBe(true);
  expect(router.state.location.pathname).toBe("/make/deck");

  // Closing runs it back to the card, then the sheet is gone and nothing is left behind.
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(ghost("close") === null).toBe(false));
  expect(sheet.querySelector("[data-morph-hidden]") === null).toBe(false);
  await waitFor(() => expect(router.state.location.pathname).toBe("/make"), {
    timeout: 2_000,
  });
  await waitFor(() =>
    expect(document.querySelector('[role="dialog"]') === null).toBe(true),
  );
  expect(document.querySelector("[data-morph]") === null).toBe(true);
  // The card is still there to open again.
  expect(view.getByRole("link", { name: /Hearth & Co orders/ })).toBeTruthy();
});

test("with reduced motion the sheet fades in and out, with no stand-in", async () => {
  reducedMotion(true);
  layingOut();
  serving();
  const { view, router } = app();
  fireEvent.click(
    await view.findByRole("link", { name: /Hearth & Co orders/ }),
  );
  const sheet = await view.findByRole("dialog", { name: "Hearth & Co orders" });
  expect(document.querySelector("[data-morph]") === null).toBe(true);
  expect(sheet.querySelector("[data-morph-hidden]") === null).toBe(true);

  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  // It fades: the veil goes clear, then the sheet is gone.
  await waitFor(() => expect(sheet.getAttribute("data-closing")).toBe("true"));
  expect(sheet.className).toContain("opacity-0");
  expect(document.querySelector("[data-morph]") === null).toBe(true);
  await waitFor(() => expect(router.state.location.pathname).toBe("/make"));
  await waitFor(() =>
    expect(document.querySelector('[role="dialog"]') === null).toBe(true),
  );
});

test("with no card on screen to come from, the sheet fades", async () => {
  reducedMotion(false);
  serving();
  // Nothing is laid out: the card has no size, as one scrolled away or never drawn would.
  const { view } = app();
  fireEvent.click(
    await view.findByRole("link", { name: /Hearth & Co orders/ }),
  );
  const sheet = await view.findByRole("dialog", { name: "Hearth & Co orders" });
  expect(document.querySelector("[data-morph]") === null).toBe(true);
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(sheet.getAttribute("data-closing")).toBe("true"));
});

/** Chat as its card sees it: a conversation, the card under the Bot's line, the sheet's host. */
function Chat() {
  const conversation = useMemo<ConversationSend>(
    () => ({ send: () => true, isLatestTurn: () => true }),
    [],
  );
  return (
    <ConversationSendContext.Provider value={conversation}>
      <ConversationPageCard page={deck} />
      <PageSheetHost />
    </ConversationSendContext.Provider>
  );
}

test("in Chat the card grows into the sheet over the conversation, and closing returns it to the card", async () => {
  reducedMotion(false);
  layingOut();
  serving();
  const root = createRootRoute({
    validateSearch: (search: Record<string, unknown>) =>
      searchTextEntry("page", search.page),
    component: Outlet,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: Chat }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await view.findByRole("link", { name: /Hearth & Co orders/ }),
  );
  const sheet = await view.findByRole("dialog", { name: "Hearth & Co orders" });
  await waitFor(() => expect(ghost("open") === null).toBe(false));
  // The stand-in carries the card's face.
  expect(ghost("open")?.textContent).toContain("Mugs per day");
  await waitFor(
    () => expect(document.querySelector("[data-morph]") === null).toBe(true),
    { timeout: 2_000 },
  );
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(ghost("close") === null).toBe(false));
  await waitFor(
    () => expect(document.querySelector('[role="dialog"]') === null).toBe(true),
    { timeout: 2_000 },
  );
  expect(router.state.location.search).toEqual({});
});
