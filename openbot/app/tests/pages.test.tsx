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
import { type ReactNode, useMemo } from "react";
import {
  type ConversationSend,
  ConversationSendContext,
} from "@/components/channels/conversation-send";
import { PageCard, updatedLabel } from "@/components/duet/page-card";
import { PageBlocks } from "@/components/duet/page-view";
import {
  PageSheet,
  PageSheetHost,
  useCloseSheet,
} from "@/components/duet/page-sheet";
import { PagesScreen } from "@/components/shell/pages-screen";
import { agentKeys } from "@/lib/agents/queries";
import { ConversationPageCard, readPage } from "@/lib/copilot/page-card-tool";
import type { PageSummary } from "@/lib/pages/queries";
import { searchTextEntry } from "@/lib/search-text";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Things the Bot makes: the card Chat draws under its line, the page it opens over the conversation
 * or over the Pages list, and the Pages tab that lists them. Drawn under a real router, so opening
 * and closing a page is real navigation.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const UPDATED = "2026-10-22T05:52:00";
const at = (iso: string) => new Date(iso).toISOString();

const prep: PageSummary = {
  id: "prep",
  kind: "page",
  title: "Partner meeting prep",
  summary: null,
  updatedAt: at(UPDATED),
  slideCount: 0,
  preview: {
    blocks: [
      { type: "heading", text: "What they will ask" },
      {
        type: "text",
        text: "They will ask about the second kiln and the wholesale margin.",
      },
      { type: "bullets", items: ["Bring the samples", "Know the lead times"] },
    ],
  },
};

const deck: PageSummary = {
  id: "deck",
  kind: "slides",
  title: "Series A deck",
  summary: null,
  updatedAt: at("2026-10-22T05:48:00"),
  slideCount: 3,
  preview: {
    title: "Orders this week",
    blocks: [
      {
        type: "bars",
        items: [
          { label: "Mon", value: 12 },
          { label: "Tue", value: 18 },
          { label: "Wed", value: 9 },
          { label: "Thu", value: 24 },
        ],
      },
    ],
  },
};

const metrics = [
  "$528K",
  "$2.1M",
  "+11%",
  "14",
  "3,120",
  "61",
  "42",
  "Valencia",
].map((value, index) => ({
  label: `Metric ${index + 1}`,
  value,
  note: "vs last year",
}));
const pulse: PageSummary = {
  id: "pulse",
  kind: "page",
  title: "Marlo Pulse",
  summary: null,
  updatedAt: at("2026-10-22T09:41:00"),
  slideCount: 0,
  preview: {
    blocks: [
      {
        type: "text",
        text: "Healthy, with one leak: weekend delivery at Valencia.",
      },
      { type: "metrics", items: metrics },
      {
        type: "list",
        title: "Where to look",
        items: [
          { text: "Valencia delivery errors" },
          { text: "Northford teams", note: "Two leads out" },
        ],
      },
    ],
  },
};

/** The whole page, as `/api/openduet/pages/:id` answers. */
const records: Record<string, unknown> = {
  pulse: { ...pulse, content: { blocks: pulse.preview.blocks } },
  deck: {
    ...deck,
    content: {
      slides: [
        { title: "Orders this week", blocks: deck.preview.blocks },
        {
          title: "What changed",
          blocks: [{ type: "text", text: "Weekends grew." }],
        },
        { title: "Next week", blocks: [{ type: "bullets", items: ["Hire"] }] },
      ],
    },
  },
};

let listed: unknown[] = [];
function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/agents")
      return Response.json({ agents: [{ id: "openduet", name: "OpenDuet" }] });
    if (url === "/api/openduet/pages") return Response.json({ pages: listed });
    const one = /^\/api\/openduet\/pages\/(.+)$/.exec(url);
    if (one) {
      const record = records[decodeURIComponent(one[1] ?? "")];
      return record
        ? Response.json({ page: record })
        : Response.json({ error: "Couldn't find that page." }, { status: 404 });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
}

const sent: string[] = [];

/** Chat as the card sees it: a conversation it can send through, with the sheet's host inside. */
function Chat({ page }: { page: PageSummary }) {
  const conversation = useMemo<ConversationSend>(
    () => ({
      send: (text) => {
        sent.push(text);
        return true;
      },
      isLatestTurn: () => true,
    }),
    [],
  );
  return (
    <ConversationSendContext.Provider value={conversation}>
      <p>I drafted answers for both. It's a 2-minute read.</p>
      <ConversationPageCard page={page} />
      <PageSheetHost />
    </ConversationSendContext.Provider>
  );
}

/** The `/pages/$pageId` route's component, against this test's route tree. */
function PageRoute() {
  const { pageId } = useParams({ strict: false }) as { pageId: string };
  const navigate = useNavigate();
  const close = useCloseSheet(() => void navigate({ to: "/pages" }));
  return <PageSheet onClose={close} pageId={pageId} />;
}

function app(chat: ReactNode, path: string) {
  const root = createRootRoute({
    validateSearch: (search: Record<string, unknown>) =>
      searchTextEntry("page", search.page),
    component: Outlet,
  });
  const chatRoute = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => chat,
  });
  const pagesRoute = createRoute({
    getParentRoute: () => root,
    path: "/pages",
    component: () => (
      <>
        <PagesScreen />
        <Outlet />
      </>
    ),
  });
  const pageRoute = createRoute({
    getParentRoute: () => pagesRoute,
    path: "$pageId",
    component: PageRoute,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      chatRoute,
      pagesRoute.addChildren([pageRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
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

/** A card on its own, linking nowhere, to look at its preview. */
function card(page: PageSummary) {
  const view = render(
    <PageCard
      link={({ className, children }) => (
        <a className={className} href={`/pages/${page.id}`}>
          {children}
        </a>
      )}
      now={new Date("2026-10-22T10:00:00")}
      page={page}
    />,
  );
  const preview = view.container.querySelector("[data-preview]");
  if (!preview) throw new Error("no preview");
  return { view, preview };
}

test("a page's card previews its title over its first lines as soft bars, then says when it changed", () => {
  const { view, preview } = card(prep);
  expect(preview.getAttribute("data-preview")).toBe("page");
  expect(preview.getAttribute("aria-hidden")).toBe("true");
  expect(preview.textContent).toContain("Partner meeting prep");
  // The text itself is drawn as bars, not words.
  expect(preview.textContent).not.toContain("second kiln");
  expect(preview.textContent).not.toContain("Bring the samples");
  const link = view.getByRole("link");
  expect(link.getAttribute("href")).toBe("/pages/prep");
  expect(link.textContent).toContain(
    updatedLabel(prep.updatedAt, new Date("2026-10-22T10:00:00")),
  );
  expect(updatedLabel(prep.updatedAt, new Date("2026-10-22T10:00:00"))).toBe(
    `Updated ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(UPDATED))}`,
  );
  // Before today it says the day instead.
  expect(updatedLabel(prep.updatedAt, new Date("2026-10-24T10:00:00"))).toBe(
    `Updated ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(UPDATED))}`,
  );
});

test("a deck's card previews its first slide with its chart as real bars, the last one violet", () => {
  const { view, preview } = card(deck);
  expect(preview.getAttribute("data-preview")).toBe("slides");
  expect(preview.textContent).toContain("Orders this week");
  const violet = preview.querySelectorAll(".bg-duet-violet");
  expect(violet).toHaveLength(1);
  const bars = violet[0]?.parentElement?.children;
  expect(bars).toHaveLength(4);
  expect(bars?.[3]).toBe(violet[0] as Element);
  expect(view.getByRole("link").textContent).toContain("Series A deck");
});

test("a dashboard's card previews its headline over its first three figures", () => {
  const { preview } = card(pulse);
  expect(preview.getAttribute("data-preview")).toBe("dashboard");
  expect(preview.textContent).toContain(
    "Healthy, with one leak: weekend delivery at Valencia.",
  );
  for (const value of ["$528K", "$2.1M", "+11%"])
    expect(preview.textContent).toContain(value);
  expect(preview.textContent).not.toContain("3,120");
});

test("the tool's answer is drawn as a card only when it saved a page", () => {
  expect(readPage(JSON.stringify(prep))?.title).toBe("Partner meeting prep");
  // Encoded once more on the way through the runtime.
  expect(readPage(JSON.stringify(JSON.stringify(prep)))?.id).toBe("prep");
  expect(
    readPage(
      "Refused. make_page could not save this. blocks: Required. Fix it and call make_page again.",
    ),
  ).toBeNull();
  expect(readPage(JSON.stringify("Refused. No."))).toBeNull();
  expect(readPage("{not json")).toBeNull();
  expect(readPage(undefined)).toBeNull();
});

test("in Chat the card opens the page over the conversation at /pages/<id>, and × goes back", async () => {
  serving();
  const { view, router } = app(<Chat page={pulse} />, "/");
  fireEvent.click(await view.findByRole("link", { name: /Marlo Pulse/ }));
  const sheet = await view.findByRole("dialog", { name: "Marlo Pulse" });
  // The address says /pages/pulse; the conversation is still under it.
  expect(router.state.location.maskedLocation?.pathname).toBe("/pages/pulse");
  expect(router.state.location.pathname).toBe("/");
  expect(view.getByText(/It's a 2-minute read/)).toBeTruthy();
  expect(
    await within(sheet).findByText(
      "Healthy, with one leak: weekend delivery at Valencia.",
    ),
  ).toBeTruthy();
  expect(sheet.textContent).toContain("Updated");
  // Eight tiles, each with its label, figure and note.
  expect(within(sheet).getByText("Valencia")).toBeTruthy();
  expect(within(sheet).getAllByText("vs last year")).toHaveLength(8);

  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(router.state.location.pathname).toBe("/");
  expect(router.state.location.search).toEqual({});
});

test("opened from Chat, a row worth a closer look asks about it in the conversation and closes", async () => {
  sent.length = 0;
  serving();
  const { view, router } = app(<Chat page={pulse} />, "/");
  fireEvent.click(await view.findByRole("link", { name: /Marlo Pulse/ }));
  const sheet = await view.findByRole("dialog", { name: "Marlo Pulse" });
  const look = await within(sheet).findByRole("region", {
    name: "Where to look",
  });
  fireEvent.click(
    within(look).getByRole("button", { name: /Valencia delivery errors/ }),
  );
  expect(sent).toEqual(["Tell me more about Valencia delivery errors"]);
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(router.state.location.search).toEqual({});
});

test("Pages lists everything made as the same cards, in the server's order, and opens one over the list", async () => {
  listed = [pulse, deck, prep];
  serving();
  const { view, router } = app(null, "/pages");
  const list = await view.findByRole("list", { name: "Pages" });
  const links = within(list).getAllByRole("link");
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/pages/pulse",
    "/pages/deck",
    "/pages/prep",
  ]);
  expect(view.getByText("What OpenDuet made for you.")).toBeTruthy();

  fireEvent.click(links[0] as HTMLElement);
  const sheet = await view.findByRole("dialog", { name: "Marlo Pulse" });
  expect(router.state.location.pathname).toBe("/pages/pulse");
  // No conversation here: the rows are still.
  const look = await within(sheet).findByRole("region", {
    name: "Where to look",
  });
  expect(within(look).queryAllByRole("button")).toHaveLength(0);
  expect(look.textContent).toContain("Northford teams");

  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(router.state.location.pathname).toBe("/pages");
});

test("a /pages/<id> link opened on its own closes to the Pages list", async () => {
  listed = [pulse];
  serving();
  const { view, router } = app(null, "/pages/pulse");
  const sheet = await view.findByRole("dialog", { name: "Marlo Pulse" });
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/pages"));
});

test("with nothing made yet, Pages says what will appear and how", async () => {
  listed = [];
  serving();
  const { view } = app(null, "/pages");
  expect(await view.findByText("Nothing here yet.")).toBeTruthy();
  expect(
    view.getByText(
      "Ask OpenDuet for prep notes, a plan, a deck or a dashboard. What it makes shows up here.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("list", { name: "Pages" })).toBeNull();
});

test("a deck shows one slide at a time, turned by the arrow keys, the buttons or a swipe", async () => {
  listed = [deck];
  serving();
  const { view } = app(null, "/pages/deck");
  const sheet = await view.findByRole("dialog", { name: "Series A deck" });
  const counter = await within(sheet).findByText("1 / 3");
  const shown = () =>
    within(sheet)
      .getAllByRole("group", { hidden: true })
      .filter((slide) => slide.getAttribute("aria-hidden") !== "true")
      .map((slide) => slide.getAttribute("aria-label"));
  expect(shown()).toEqual(["Slide 1 of 3"]);
  const previous = within(sheet).getByRole("button", {
    name: "Previous slide",
  });
  const next = within(sheet).getByRole("button", { name: "Next slide" });
  expect(previous.hasAttribute("disabled")).toBe(true);

  fireEvent.keyDown(document, { key: "ArrowRight" });
  await waitFor(() => expect(counter.textContent).toBe("2 / 3"));
  expect(shown()).toEqual(["Slide 2 of 3"]);
  fireEvent.keyDown(document, { key: "ArrowRight" });
  fireEvent.keyDown(document, { key: "ArrowRight" });
  await waitFor(() => expect(counter.textContent).toBe("3 / 3"));
  expect(next.hasAttribute("disabled")).toBe(true);
  fireEvent.keyDown(document, { key: "ArrowLeft" });
  await waitFor(() => expect(counter.textContent).toBe("2 / 3"));
  fireEvent.click(previous);
  await waitFor(() => expect(counter.textContent).toBe("1 / 3"));

  // A swipe to the left turns to the next slide; a short drag does nothing.
  const track = within(sheet).getByRole("region", { name: "Slides" })
    .firstElementChild as HTMLElement;
  fireEvent.pointerDown(track, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 260,
    clientY: 100,
  });
  fireEvent.pointerUp(track, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 140,
    clientY: 104,
  });
  await waitFor(() => expect(counter.textContent).toBe("2 / 3"));
  fireEvent.pointerDown(track, {
    pointerId: 2,
    pointerType: "touch",
    clientX: 200,
    clientY: 100,
  });
  fireEvent.pointerUp(track, {
    pointerId: 2,
    pointerType: "touch",
    clientX: 190,
    clientY: 100,
  });
  expect(counter.textContent).toBe("2 / 3");
  // With reduced motion the slides change in place.
  expect(track.firstElementChild?.className).toContain(
    "motion-reduce:transition-none",
  );
});

test("a dashboard's headline is set large, and a long one steps down a size", () => {
  const short = "Healthy, with one leak: weekend delivery at Valencia.";
  const long = `${short} Almost all of the mail I read arrived today, and three replies are due by the end of it.`;
  const headline = (text: string) => {
    const view = render(
      <PageBlocks
        blocks={[
          { type: "text", text },
          { type: "metrics", items: metrics },
        ]}
      />,
    );
    const className = view.getByText(text).className;
    view.unmount();
    return className;
  };
  expect(headline(short)).toContain("type-big");
  expect(headline(long)).toContain("type-title");
  // A page that is not a dashboard reads its first text at body size.
  const plain = render(<PageBlocks blocks={[{ type: "text", text: short }]} />);
  expect(plain.getByText(short).className).toContain("type-body");
});
