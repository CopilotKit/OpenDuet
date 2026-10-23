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
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forgetCards } from "@/components/duet/page-morph";
import {
  MAKE_KINDS,
  MakeScreen,
  stillBeingMade,
} from "@/components/shell/make-screen";
import { agentKeys } from "@/lib/agents/queries";
import { type PageSummary, pageKeys } from "@/lib/pages/queries";
import type { TaskRecord } from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The Make tab: what the Bot made, as thumbnails two to a row with chips for each kind, and the +
 * that fans out what it can make and opens the + sheet with a starter line. Drawn under a real
 * router, against the server's answers.
 */

const originalFetch = global.fetch;
let originalMatchMedia: typeof window.matchMedia;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalMatchMedia = window.matchMedia;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  forgetCards();
  global.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const at = (iso: string) => new Date(iso).toISOString();

const notes: PageSummary = {
  id: "notes",
  kind: "page",
  title: "Partner meeting prep",
  summary: null,
  updatedAt: at("2026-10-22T05:52:00"),
  slideCount: 0,
  preview: {
    blocks: [
      { type: "heading", text: "What they will ask" },
      { type: "text", text: "The second kiln and the wholesale margin." },
      { type: "bullets", items: ["Bring the samples"] },
    ],
  },
};

const deck: PageSummary = {
  id: "deck",
  kind: "slides",
  title: "Hearth & Co orders",
  summary: null,
  updatedAt: at("2026-10-22T05:48:00"),
  slideCount: 3,
  preview: {
    title: "Mugs per day",
    blocks: [
      {
        type: "bars",
        items: [
          { label: "Mon", value: 12 },
          { label: "Tue", value: 18 },
          { label: "Wed", value: 24 },
        ],
      },
    ],
  },
};

const pulse: PageSummary = {
  id: "pulse",
  kind: "page",
  title: "Studio pulse",
  summary: null,
  updatedAt: at("2026-10-22T09:41:00"),
  slideCount: 0,
  preview: {
    blocks: [
      { type: "text", text: "Healthy, with one leak: weekend delivery." },
      {
        type: "metrics",
        items: [
          { label: "Orders", value: "$528K" },
          { label: "Pipeline", value: "$2.1M" },
          { label: "Growth", value: "+11%" },
        ],
      },
    ],
  },
};

let listed: PageSummary[] = [];
let tasks: TaskRecord[] = [];
const started: unknown[] = [];

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "task-9",
  botId: "openduet",
  channelId: "task-9-channel",
  threadId: "task-9-thread",
  title: "Make a deck about the Hearth order",
  why: null,
  origin: "asked",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  status: "working",
  resolvedAt: null,
  createdAt: at("2026-10-22T10:00:00"),
  updatedAt: at("2026-10-22T10:00:00"),
  ...overrides,
});

function serving() {
  started.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/agents")
      return Response.json({ agents: [{ id: "openduet", name: "OpenDuet" }] });
    if (url === "/api/openduet/pages") return Response.json({ pages: listed });
    if (url === "/api/openduet/tasks" && init?.method === "POST") {
      started.push(JSON.parse(String(init.body)));
      tasks = [task(), ...tasks];
      return Response.json({ task: task() }, { status: 201 });
    }
    if (url === "/api/openduet/tasks") return Response.json({ tasks });
    return Response.json({});
  }) as unknown as typeof fetch;
}

/** Ask for less motion, or not, as the person's system would. */
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

function app(path = "/make") {
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
    component: () => <p>Opened</p>,
  });
  const taskRoute = createRoute({
    getParentRoute: () => root,
    path: "/tasks/$taskId",
    component: () => <p>Task page</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([make.addChildren([one]), taskRoute]),
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

/** The grid's cards, by where they open. */
const opened = (grid: HTMLElement) =>
  within(grid)
    .getAllByRole("link")
    .map((link) => link.getAttribute("href"));

test("Make draws what was made as thumbnails two to a row, each drawn from the thing itself", async () => {
  listed = [pulse, deck, notes];
  serving();
  const { view } = app();
  const grid = await view.findByRole("list", { name: "Made for you" });
  expect(grid.className).toContain("grid-cols-2");
  // The server's order: the most recently changed first.
  expect(opened(grid)).toEqual(["/make/pulse", "/make/deck", "/make/notes"]);
  const previews = [...grid.querySelectorAll("[data-preview]")];
  expect(
    previews.map((preview) => preview.getAttribute("data-preview")),
  ).toEqual(["dashboard", "slides", "page"]);
  const [dashboard, slides, page] = previews;
  // A dashboard's headline and its first figures, two to a thumbnail.
  expect(dashboard?.textContent).toContain(
    "Healthy, with one leak: weekend delivery.",
  );
  expect(dashboard?.textContent).toContain("$528K");
  expect(dashboard?.textContent).toContain("$2.1M");
  expect(dashboard?.textContent).not.toContain("+11%");
  // A deck's chart slide, its last bar violet.
  expect(slides?.textContent).toContain("Mugs per day");
  expect(slides?.querySelectorAll(".bg-duet-violet")).toHaveLength(1);
  // A page's heading, its text as soft bars.
  expect(page?.textContent).toContain("What they will ask");
  expect(page?.textContent).not.toContain("second kiln");
  // Each card says what it is.
  const labels = within(grid)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
  expect(labels[0]).toContain("Dashboard ·");
  expect(labels[1]).toContain("Deck ·");
  expect(labels[2]).toContain("Page ·");
});

test("the chips show one kind at a time, and a kind with nothing yet says how to make one", async () => {
  listed = [pulse, deck, notes];
  serving();
  const { view } = app();
  const grid = await view.findByRole("list", { name: "Made for you" });
  const chips = view.getByRole("group", { name: "Show" });
  expect(
    within(chips)
      .getAllByRole("button")
      .map((chip) => chip.textContent),
  ).toEqual(["All", "Pages", "Decks", "Dashboards"]);
  const chip = (name: string) => within(chips).getByRole("button", { name });
  expect(chip("All").getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(chip("Decks"));
  expect(chip("Decks").getAttribute("aria-pressed")).toBe("true");
  expect(chip("All").getAttribute("aria-pressed")).toBe("false");
  expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
    "/make/deck",
  ]);
  // A dashboard is a page too, but Pages holds the ones that are not dashboards.
  fireEvent.click(chip("Pages"));
  expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
    "/make/notes",
  ]);
  fireEvent.click(chip("Dashboards"));
  expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
    "/make/pulse",
  ]);
  fireEvent.click(chip("All"));
  expect(opened(grid.isConnected ? grid : view.getByRole("list"))).toHaveLength(
    3,
  );

  cleanup();
  queryClient.clear();
  listed = [notes];
  serving();
  const second = app();
  await second.view.findByRole("list", { name: "Made for you" });
  fireEvent.click(
    within(second.view.getByRole("group", { name: "Show" })).getByRole(
      "button",
      { name: "Decks" },
    ),
  );
  expect(
    second.view.getByText("No decks yet. Tap + to make one."),
  ).toBeTruthy();
  expect(second.view.queryByRole("list", { name: "Made for you" })).toBeNull();
});

test("with nothing made yet, Make says what will appear and how", async () => {
  listed = [];
  serving();
  const { view } = app();
  expect(await view.findByText("Nothing made yet.")).toBeTruthy();
  expect(
    view.getByText(
      "Tap + and pick a page, deck, dashboard or doc. What OpenDuet makes shows up here.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("list", { name: "Made for you" })).toBeNull();
  expect(view.queryByRole("group", { name: "Show" })).toBeNull();
});

test("the + fans out Page, Deck, Dashboard and Doc, nearest first, and folds them away", async () => {
  reducedMotion(false);
  listed = [];
  serving();
  const { view } = app();
  const plus = await view.findByRole("button", { name: "Make something" });
  expect(plus.getAttribute("aria-expanded")).toBe("false");
  expect(view.queryByRole("button", { name: "Make a deck" })).toBeNull();

  fireEvent.click(plus);
  const fan = view.getByRole("list", { name: "What to make" });
  const options = within(fan).getAllByRole("button");
  expect(options.map((option) => option.textContent)).toEqual([
    "Page",
    "Deck",
    "Dashboard",
    "Doc",
  ]);
  expect(view.getByRole("button", { name: "Close", expanded: true })).toBe(
    plus,
  );
  // They rise into place from below, a beat apart, so they start lower and smaller.
  const items = [...fan.querySelectorAll("li")];
  for (const item of items)
    expect(item.style.transform).toContain("translateY");

  // Escape folds them away.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(plus.getAttribute("aria-expanded")).toBe("false");
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Make a deck" }) === null).toBe(
      true,
    ),
  );
});

test("with reduced motion the options fade in place, without rising", async () => {
  reducedMotion(true);
  listed = [];
  serving();
  const { view } = app();
  fireEvent.click(await view.findByRole("button", { name: "Make something" }));
  const fan = view.getByRole("list", { name: "What to make" });
  expect(within(fan).getAllByRole("button")).toHaveLength(4);
  for (const item of fan.querySelectorAll("li")) {
    expect((item as HTMLElement).style.transform ?? "").not.toContain(
      "translateY",
    );
    expect((item as HTMLElement).style.opacity).toBe("0");
  }
});

test("Deck opens the + sheet with its starter and the blank selected; Start now starts a task whose card leads the grid until the deck arrives", async () => {
  reducedMotion(true);
  listed = [notes];
  tasks = [];
  serving();
  const { view, router } = app();
  await view.findByRole("list", { name: "Made for you" });
  fireEvent.click(view.getByRole("button", { name: "Make something" }));
  fireEvent.click(view.getByRole("button", { name: "Make a deck" }));

  const sheet = await view.findByRole("dialog", {
    name: "What should OpenDuet make?",
  });
  const field = within(sheet).getByRole("textbox") as HTMLTextAreaElement;
  const starter = MAKE_KINDS.find((kind) => kind.id === "deck")?.starter;
  expect(starter).toBe("Make a deck about …");
  expect(field.value).toBe("Make a deck about …");
  fireEvent.focus(field);
  // The "…" is selected, so what is typed replaces it.
  expect([field.selectionStart, field.selectionEnd]).toEqual([18, 19]);
  const startNow = within(sheet).getByRole("button", { name: "Start now" });
  // The starter on its own is not an ask yet.
  expect(startNow.hasAttribute("disabled")).toBe(true);

  // Typing replaces the selected blank.
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(field, "the Hearth order", { skipClick: true });
  expect(field.value).toBe("Make a deck about the Hearth order");
  expect(startNow.hasAttribute("disabled")).toBe(false);
  fireEvent.click(startNow);
  await waitFor(() =>
    expect(started).toEqual([
      { botId: "openduet", instruction: "Make a deck about the Hearth order" },
    ]),
  );
  await waitFor(() =>
    expect(
      view.queryByRole("dialog", { name: "What should OpenDuet make?" }) ===
        null,
    ).toBe(true),
  );

  // The task's card leads the grid and opens the task.
  const grid = view.getByRole("list", { name: "Made for you" });
  const making = await within(grid).findByRole("link", {
    name: /Make a deck about the Hearth order/,
  });
  expect(making.getAttribute("href")).toBe("/tasks/task-9");
  expect(opened(grid)).toEqual(["/tasks/task-9", "/make/notes"]);
  expect(making.querySelector("[data-status]")?.textContent).toBe("Working");

  // The deck arrives: it takes the task's place.
  listed = [deck, notes];
  await act(() => queryClient.invalidateQueries({ queryKey: pageKeys.list }));
  await waitFor(() =>
    expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
      "/make/deck",
      "/make/notes",
    ]),
  );

  // And opens over the grid.
  fireEvent.click(
    within(view.getByRole("list", { name: "Made for you" })).getByRole("link", {
      name: /Hearth & Co orders/,
    }),
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/make/deck"),
  );
});

test("Save for Up next from Make says where it went", async () => {
  reducedMotion(true);
  listed = [];
  serving();
  const saved: unknown[] = [];
  const serve = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/openduet/tasks/up-next") {
      saved.push(JSON.parse(String(init?.body)));
      return Response.json(
        { suggestion: { id: "s1", title: "Doc" } },
        { status: 201 },
      );
    }
    return serve(input, init);
  }) as unknown as typeof fetch;
  const { view } = app();
  fireEvent.click(await view.findByRole("button", { name: "Make something" }));
  fireEvent.click(view.getByRole("button", { name: "Make a doc" }));
  const sheet = await view.findByRole("dialog");
  const field = within(sheet).getByRole("textbox") as HTMLTextAreaElement;
  expect(field.value).toBe("Write a doc about …");
  fireEvent.focus(field);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(field, "our glaze suppliers", { skipClick: true });
  fireEvent.click(
    within(sheet).getByRole("button", { name: "Save for Up next" }),
  );
  expect(await view.findByText("Saved for Up next on Tasks.")).toBeTruthy();
  expect(saved).toEqual([
    { botId: "openduet", instruction: "Write a doc about our glaze suppliers" },
  ]);
});

test("a task started here stops being drawn once a page arrives for it or it stops", () => {
  const known = new Set(["notes"]);
  const first = { id: "a", label: "deck", known };
  const second = { id: "b", label: "page", known };
  // Both still working, nothing new: both drawn.
  expect(
    stillBeingMade(
      [second, first],
      [notes],
      [task({ id: "a" }), task({ id: "b" })],
    ),
  ).toEqual([second, first]);
  // One new page: it counts for the older task.
  expect(
    stillBeingMade(
      [second, first],
      [deck, notes],
      [task({ id: "a" }), task({ id: "b" })],
    ),
  ).toEqual([second]);
  // A task that finished without making anything, or was marked done, is not drawn either.
  expect(
    stillBeingMade(
      [first],
      [notes],
      [task({ id: "a", status: "ready_for_review" })],
    ),
  ).toEqual([]);
  // Stopped to ask the person something is still under way; not read yet is just started.
  expect(
    stillBeingMade(
      [first],
      [notes],
      [task({ id: "a", status: "needs_input" })],
    ),
  ).toEqual([first]);
  expect(stillBeingMade([first], undefined, undefined)).toEqual([first]);
});
