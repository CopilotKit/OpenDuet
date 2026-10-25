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
  act,
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
import {
  PageSheet,
  PageSheetHost,
  SlideDeck,
  useCloseSheet,
} from "@/components/duet/page-sheet";
import { PageBlocks } from "@/components/duet/page-view";
import { MakeScreen } from "@/components/shell/make-screen";
import { agentKeys } from "@/lib/agents/queries";
import { ConversationPageCard, readPage } from "@/lib/copilot/page-card-tool";
import {
  type PageBlock,
  type PageSlide,
  type PageSummary,
  pageQueryOptions,
} from "@/lib/pages/queries";
import { searchTextEntry } from "@/lib/search-text";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Things the Bot makes: the card Chat draws under its line, the page it opens over the conversation
 * or over the Make grid, and the Make tab that lists them. Drawn under a real router, so opening
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
function serving(pageStatus = 200) {
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === "/api/agents")
        return Response.json({
          agents: [{ id: "openduet", name: "OpenDuet" }],
        });
      if (url === "/api/openduet/pages")
        return Response.json({ pages: listed });
      const one = /^\/api\/openduet\/pages\/(.+)$/.exec(url);
      if (one) {
        if (pageStatus !== 200)
          return Response.json(
            { error: "Temporarily unavailable." },
            { status: pageStatus },
          );
        const record = records[decodeURIComponent(one[1] ?? "")];
        return record
          ? Response.json({ page: record })
          : Response.json(
              { error: "Couldn't find that page." },
              { status: 404 },
            );
      }
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
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

/** The `/make/$pageId` route's component, against this test's route tree. */
function PageRoute() {
  const { pageId } = useParams({ strict: false }) as { pageId: string };
  const navigate = useNavigate();
  const close = useCloseSheet(() => void navigate({ to: "/make" }));
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
    path: "/make",
    component: () => (
      <>
        <MakeScreen />
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
function card(page: PageSummary, size: "row" | "grid" = "row") {
  const view = render(
    <PageCard
      link={({ className, children }) => (
        <a className={className} href={`/make/${page.id}`}>
          {children}
        </a>
      )}
      now={new Date("2026-10-22T10:00:00")}
      page={page}
      size={size}
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
  expect(link.getAttribute("href")).toBe("/make/prep");
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

// Unequal values on a larger shared scale expose local rescaling and constant-height bars.
const chartItems = [
  { label: "First", value: 10 },
  { label: "Second", value: 20 },
];
for (const scenario of [
  {
    name: "explicit first highlight",
    metadata: { scale: 100, highlight: 0 },
    heights: ["10%", "20%"],
    highlights: [true, false],
  },
  {
    name: "no highlight sentinel",
    metadata: { scale: 100, highlight: -1 },
    heights: ["10%", "20%"],
    highlights: [false, false],
  },
  {
    name: "highlight outside this fragment",
    metadata: { scale: 100, highlight: 2 },
    heights: ["10%", "20%"],
    highlights: [false, false],
  },
  {
    name: "legacy defaults",
    metadata: {},
    heights: ["50%", "100%"],
    highlights: [false, true],
  },
]) {
  const chart: PageBlock = {
    type: "bars",
    items: chartItems,
    ...scenario.metadata,
  };
  test(`a full page chart preserves ${scenario.name}`, () => {
    const view = render(<PageBlocks blocks={[chart]} />);
    const rendered = chartItems.map(({ label }) => {
      const column = view.getByText(label).parentElement;
      const bar = column?.querySelector<HTMLElement>("div[style]");
      return {
        label,
        height: bar?.style.height,
        highlighted: bar?.classList.contains("bg-duet-violet"),
      };
    });
    expect(rendered).toEqual(
      chartItems.map(({ label }, index) => ({
        label,
        height: scenario.heights[index],
        highlighted: scenario.highlights[index],
      })),
    );
  });
  for (const kind of ["page", "slides"] as const) {
    test(`a ${kind} row chart preview preserves ${scenario.name}`, () => {
      const { preview } = card({ ...deck, kind, preview: { blocks: [chart] } });
      const bars = [
        ...preview.querySelectorAll<HTMLElement>('span[style*="height:"]'),
      ];
      expect(bars.map((bar) => bar.style.height)).toEqual(scenario.heights);
      expect(
        bars.map((bar) => ({
          label: bar.title,
          highlighted: bar.classList.contains("bg-duet-violet"),
        })),
      ).toEqual(
        chartItems.map(({ label }, index) => ({
          label,
          highlighted: scenario.highlights[index],
        })),
      );
    });
  }
}

for (const size of ["row", "grid"] as const) {
  const figures: PageSummary["preview"]["blocks"][number] = {
    type: "metrics",
    items: [
      { label: "Revenue", value: "$12K" },
      { label: "Orders", value: "42" },
      { label: "Growth", value: "+8%" },
      { label: "Customers", value: "350" },
    ],
  };

  test(`an explicit dashboard ${size} card finds metrics before its headline`, () => {
    const { preview } = card(
      {
        ...pulse,
        kind: "dashboard",
        preview: {
          blocks: [
            figures,
            { type: "text", text: "Revenue is ahead of plan." },
          ],
        },
      },
      size,
    );
    expect(preview.getAttribute("data-preview")).toBe("dashboard");
    expect(preview.textContent).toContain("Revenue is ahead of plan.");
    expect(preview.textContent).toContain("$12KRevenue");
    expect(preview.textContent).toContain("42Orders");
    expect(preview.textContent?.includes("+8%Growth")).toBe(size === "row");
    expect(preview.textContent).not.toContain("350");
  });

  test(`an explicit dashboard ${size} card finds a heading and later metrics`, () => {
    const { preview } = card(
      {
        ...pulse,
        kind: "dashboard",
        preview: {
          blocks: [
            { type: "heading", text: "This month's performance" },
            { type: "bullets", items: ["Wholesale growth"] },
            figures,
          ],
        },
      },
      size,
    );
    expect(preview.textContent).toContain("This month's performance");
    expect(preview.textContent).toContain("$12KRevenue");
  });

  test(`an explicit dashboard ${size} card uses its title when metrics have no headline`, () => {
    const { preview } = card(
      { ...pulse, kind: "dashboard", preview: { blocks: [figures] } },
      size,
    );
    expect(preview.textContent).toContain("Marlo Pulse");
    expect(preview.textContent).toContain("$12KRevenue");
  });

  test(`an explicit dashboard ${size} card without metrics previews its available content`, () => {
    const { preview } = card(
      {
        ...pulse,
        kind: "dashboard",
        preview: {
          blocks: [
            {
              type: "bars",
              items: [
                { label: "Mon", value: 4 },
                { label: "Tue", value: 6 },
                { label: "Wed", value: 9 },
              ],
            },
            {
              type: "decision",
              question: "Which channel?",
              options: [
                { title: "Wholesale", pros: ["Growth"], cons: [] },
                { title: "Retail", pros: ["Margin"], cons: [] },
              ],
              pick: "Wholesale",
            },
          ],
        },
      },
      size,
    );
    expect(preview.getAttribute("data-preview")).toBe("dashboard");
    expect(preview.textContent).toContain("Marlo Pulse");
    expect(preview.textContent).toContain("Pick: Wholesale");
    expect(
      preview.querySelector(".bg-duet-violet")?.parentElement?.children.length,
    ).toBe(3);
  });

  test(`a legacy dashboard ${size} card previews its headline and first figures`, () => {
    const { preview } = card(pulse, size);
    expect(preview.getAttribute("data-preview")).toBe("dashboard");
    expect(preview.textContent).toContain(
      "Healthy, with one leak: weekend delivery at Valencia.",
    );
    for (const value of ["$528K", "$2.1M"])
      expect(preview.textContent).toContain(value);
    expect(preview.textContent?.includes("+11%")).toBe(size === "row");
    expect(preview.textContent).not.toContain("3,120");
  });

  test(`an ordinary page ${size} card with metrics first remains a document preview`, () => {
    const { preview } = card(
      { ...pulse, preview: { blocks: [figures] } },
      size,
    );
    expect(preview.getAttribute("data-preview")).toBe("page");
    expect(preview.textContent).toContain("Marlo Pulse");
    expect(preview.textContent).not.toContain("$12K");
  });

  test(`an explicit doc ${size} card keeps its document preview with legacy dashboard blocks`, () => {
    const { preview } = card({ ...pulse, kind: "doc" }, size);
    expect(preview.getAttribute("data-preview")).toBe("doc");
    expect(preview.textContent).toContain("Marlo Pulse");
    expect(preview.textContent).not.toContain("$528K");
  });
}

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

test("in Chat the card opens the page over the conversation at /make/<id>, and × goes back", async () => {
  serving();
  const { view, router } = app(<Chat page={pulse} />, "/");
  fireEvent.click(await view.findByRole("link", { name: /Marlo Pulse/ }));
  const sheet = await view.findByRole("dialog", { name: "Marlo Pulse" });
  // The address says /make/pulse; the conversation is still under it.
  expect(router.state.location.maskedLocation?.pathname).toBe("/make/pulse");
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

  fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
  await waitFor(() => expect(view.queryByRole("dialog") === null).toBe(true));
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
  await waitFor(() => expect(view.queryByRole("dialog") === null).toBe(true));
  expect(router.state.location.search).toEqual({});
});

test("Make lists everything made as thumbnail cards, in the server's order, and opens one over the grid", async () => {
  listed = [pulse, deck, prep];
  serving();
  const { view, router } = app(null, "/make");
  const list = await view.findByRole("list", { name: "Made for you" });
  const links = within(list).getAllByRole("link");
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/make/pulse",
    "/make/deck",
    "/make/prep",
  ]);
  expect(view.getByText("What OpenDuet made for you.")).toBeTruthy();

  fireEvent.click(links[0] as HTMLElement);
  const sheet = await view.findByRole("dialog", { name: "Marlo Pulse" });
  expect(router.state.location.pathname).toBe("/make/pulse");
  // No conversation here: the rows are still.
  const look = await within(sheet).findByRole("region", {
    name: "Where to look",
  });
  expect(within(look).queryAllByRole("button")).toHaveLength(0);
  expect(look.textContent).toContain("Northford teams");

  fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
  await waitFor(() => expect(view.queryByRole("dialog") === null).toBe(true));
  expect(router.state.location.pathname).toBe("/make");
});

test("a /make/<id> link opened on its own closes to the Make grid", async () => {
  listed = [pulse];
  serving();
  const { view, router } = app(null, "/make/pulse");
  const sheet = await view.findByRole("dialog", { name: "Marlo Pulse" });
  fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/make"));
});

test("a deck shows one slide at a time, turned by the arrow keys, the buttons or a swipe", async () => {
  listed = [deck];
  serving();
  const { view } = app(null, "/make/deck");
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

test.each([1, 2])(
  "a focused table keeps native arrow scrolling in a %s-slide deck",
  (count) => {
    const slides: PageSlide[] = [
      {
        title: "Table",
        blocks: [
          {
            type: "table",
            columns: ["One", "Two", "Three", "Four"],
            rows: [["A", "B", "C", "D"]],
          },
        ],
      },
      { title: "Next", blocks: [] },
    ];
    const view = render(<SlideDeck slides={slides.slice(0, count)} />);
    const scroller = view.getByRole("table").parentElement!;
    // Happy DOM has no layout or bundled CSS. Supply the table's browser geometry.
    Object.defineProperties(scroller, {
      clientWidth: { value: 230 },
      scrollWidth: { value: 400 },
    });
    scroller.style.overflowX = "auto";
    scroller.tabIndex = 0;
    scroller.focus();
    expect(document.activeElement).toBe(scroller);

    for (const key of ["ArrowRight", "ArrowLeft"]) {
      // A true dispatch result means the browser's default scrolling remains available.
      expect(fireEvent.keyDown(scroller, { key })).toBe(true);
      expect(view.getByText(`1 / ${count}`)).toBeTruthy();
    }
  },
);

test("deck arrow shortcuts still respect editing, modifiers and canceled events", () => {
  const view = render(
    <>
      <input aria-label="Title" />
      <textarea aria-label="Notes" />
      <div contentEditable suppressContentEditableWarning>
        <span>Edit me</span>
      </div>
      <SlideDeck
        slides={[
          { title: "First", blocks: [] },
          { title: "Second", blocks: [] },
        ]}
      />
    </>,
  );
  for (const target of [
    view.getByRole("textbox", { name: "Title" }),
    view.getByRole("textbox", { name: "Notes" }),
    view.getByText("Edit me"),
  ]) {
    target.focus();
    expect(fireEvent.keyDown(target, { key: "ArrowRight" })).toBe(true);
  }
  for (const modifier of [{ altKey: true }, { metaKey: true }]) {
    expect(
      fireEvent.keyDown(document, { key: "ArrowRight", ...modifier }),
    ).toBe(true);
  }
  const canceled = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    bubbles: true,
    cancelable: true,
  });
  canceled.preventDefault();
  fireEvent(document, canceled);
  expect(view.getByText("1 / 2")).toBeTruthy();
  expect(fireEvent.keyDown(document, { key: "ArrowRight" })).toBe(false);
  expect(view.getByText("2 / 2")).toBeTruthy();
});

test("a failed page refresh preserves the selected slide through retry", async () => {
  const { queryKey } = pageQueryOptions(deck.id);
  serving();
  const { view } = app(null, "/make/deck");
  const sheet = await view.findByRole("dialog", { name: "Series A deck" });
  fireEvent.click(
    await within(sheet).findByRole("button", { name: "Next slide" }),
  );
  const selected = within(sheet).getByRole("group", { name: "Slide 2 of 3" });
  const saved = queryClient.getQueryData(queryKey);
  expect(within(selected).getByText("Weekends grew.")).toBeTruthy();
  expect(within(sheet).getByText("2 / 3")).toBeTruthy();

  serving(503);
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey });
  });
  const error = await within(sheet).findByRole("alert");
  const retained = queryClient.getQueryData(queryKey);
  expect(retained).toEqual(saved);
  expect(within(sheet).getByRole("group", { name: "Slide 2 of 3" })).toBe(
    selected,
  );
  expect(within(sheet).getByText("2 / 3")).toBeTruthy();
  expect(error.textContent).toContain("Couldn't refresh this page");

  serving();
  fireEvent.click(within(sheet).getByRole("button", { name: "Refresh page" }));
  await waitFor(() =>
    expect(within(sheet).queryByRole("alert") === null).toBe(true),
  );
  expect(within(sheet).getByRole("group", { name: "Slide 2 of 3" })).toBe(
    selected,
  );
  expect(within(sheet).getByText("2 / 3")).toBeTruthy();
  expect(within(selected).getByText("Weekends grew.")).toBeTruthy();
});

test("an initial page failure without saved content remains visible", async () => {
  serving(503);
  const { view } = app(null, "/make/deck");
  const sheet = await view.findByRole("dialog");
  expect(
    (await within(sheet).findByRole("alert", {}, { timeout: 2000 }))
      .textContent,
  ).toContain("Couldn't open this page");
  expect(within(sheet).queryByRole("region", { name: "Slides" })).toBeNull();
  expect(
    within(sheet)
      .getByRole("button", { name: "Refresh page" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

test("a revised deck clamps a removed selection and keeps a valid selection", () => {
  const slides = [
    { title: "First", blocks: [] },
    { title: "Second", blocks: [] },
    { title: "Third", blocks: [] },
  ];
  const view = render(<SlideDeck slides={slides} />);
  const previous = view.getByRole("button", { name: "Previous slide" });
  const next = view.getByRole("button", { name: "Next slide" });
  const expectCurrent = (number: number, count: number) => {
    expect(view.getByText(`${number} / ${count}`)).toBeTruthy();
    expect(view.getByText(`Slide ${number} of ${count}`)).toBeTruthy();
    const current = view.getByRole("group", {
      name: `Slide ${number} of ${count}`,
    });
    expect(current.parentElement?.style.transform).toBe(
      `translateX(-${(number - 1) * 100}%)`,
    );
    const rendered = view.container.querySelectorAll(
      '[aria-roledescription="slide"]',
    );
    expect(rendered).toHaveLength(count);
    for (const slide of rendered) {
      expect(slide.getAttribute("aria-hidden")).toBe(String(slide !== current));
      expect(slide.hasAttribute("inert")).toBe(slide !== current);
    }
    expect(previous.hasAttribute("disabled")).toBe(number === 1);
    expect(next.hasAttribute("disabled")).toBe(number === count);
  };

  fireEvent.click(next);
  fireEvent.click(next);
  expectCurrent(3, 3);
  view.rerender(<SlideDeck slides={slides.slice(0, 2)} />);
  expectCurrent(2, 2);
  // Growing again must not restore the removed third-slide selection.
  view.rerender(<SlideDeck slides={slides} />);
  expectCurrent(2, 3);
  view.rerender(<SlideDeck slides={slides.slice(0, 2)} />);
  expectCurrent(2, 2);
  fireEvent.click(previous);
  expectCurrent(1, 2);
  view.rerender(<SlideDeck slides={slides.slice(0, 1)} />);
  expectCurrent(1, 1);
});

test("a deck that becomes empty starts at its first slide when restored", () => {
  const slides = [
    { title: "First", blocks: [] },
    { title: "Second", blocks: [] },
    { title: "Third", blocks: [] },
  ];
  const view = render(<SlideDeck slides={slides} />);
  fireEvent.click(view.getByRole("button", { name: "Next slide" }));
  fireEvent.click(view.getByRole("button", { name: "Next slide" }));
  view.rerender(<SlideDeck slides={[]} />);
  expect(view.queryByRole("region", { name: "Slides" })).toBeNull();
  // A document key listener is still mounted while there are no slides.
  fireEvent.keyDown(document, { key: "ArrowRight" });
  fireEvent.keyDown(document, { key: "ArrowLeft" });
  view.rerender(<SlideDeck slides={slides} />);
  expect(view.getByText("1 / 3")).toBeTruthy();
  const current = view.getByRole("group", { name: "Slide 1 of 3" });
  expect(current.hasAttribute("inert")).toBe(false);
  expect(current.parentElement?.style.transform).toBe("translateX(-0%)");
  fireEvent.keyDown(document, { key: "ArrowRight" });
  expect(view.getByText("2 / 3")).toBeTruthy();
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
