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
import { type TaskRecord, taskKeys } from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";
import { runMotionFrames } from "./run-motion-frames";
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
afterEach(async () => {
  cleanup();
  queryClient.clear();
  try {
    await settleReactWork();
  } finally {
    forgetCards();
    global.fetch = originalFetch;
    window.matchMedia = originalMatchMedia;
  }
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
  failure: null,
  failedAt: null,
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
      const next = task({ id: `task-${8 + started.length}` });
      tasks = [next, ...tasks];
      return Response.json({ task: next }, { status: 201 });
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

/** The final cache keeps every server field and adds each block's persisted address. */
function expectFinalPageCache() {
  const cached = queryClient.getQueryData<PageSummary[]>(pageKeys.list);
  expect(
    cached?.map((page) =>
      page.preview.blocks.map((block) => block.persistedIndex),
    ),
  ).toEqual([[0], [0, 1, 2]]);
  expect(
    cached?.map((page) => ({
      ...page,
      preview: {
        ...page.preview,
        blocks: page.preview.blocks.map(
          ({ persistedIndex: _index, ...block }) => block,
        ),
      },
    })),
  ).toEqual([deck, notes]);
}

async function startMaking(view: ReturnType<typeof app>["view"]) {
  fireEvent.click(await view.findByRole("button", { name: "Make something" }));
  fireEvent.click(view.getByRole("button", { name: "Make a slides" }));
  const sheet = await view.findByRole("dialog");
  const field = within(sheet).getByRole("textbox");
  fireEvent.focus(field);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(field, "the Hearth order", { skipClick: true });
  fireEvent.click(within(sheet).getByRole("button", { name: "Start now" }));
  // A failed DOM-object assertion makes Bun serialize the whole live dialog, blocking the
  // mutation that closes it. Retry the boolean, as the sheet interaction test below does.
  await waitFor(() => expect(view.queryByRole("dialog") === null).toBe(true));
  await waitFor(() => {
    expect(queryClient.getQueryData<TaskRecord[]>(taskKeys.list)).toEqual(
      tasks,
    );
    expect(queryClient.getQueryState(taskKeys.list)?.fetchStatus).toBe("idle");
  });
}

test.each(["ready_for_review", "resolved", "failed"] as const)(
  "Make fetches the final page list when %s arrives before the page poll",
  async (status) => {
    reducedMotion(true);
    listed = [notes];
    tasks = [];
    serving();
    const serve = global.fetch;
    let pageReads = 0;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/openduet/pages") pageReads++;
      return serve(input, init);
    }) as typeof fetch;
    const { view } = app();
    await view.findByRole("list", { name: "Made for you" });
    await startMaking(view);
    expect(pageReads).toBe(1);

    // The server saves a page and finishes. Only the task response has reached the browser.
    listed = [deck, notes];
    tasks = [task({ status })];
    await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
    await waitFor(
      () =>
        expect(
          opened(view.getByRole("list", { name: "Made for you" })),
        ).toEqual(["/make/deck", "/make/notes"]),
      { onTimeout: (error) => error },
    );
    expect(pageReads).toBe(2);

    // A later task response must not keep fetching the page list after that final read.
    tasks = [task({ status, updatedAt: at("2026-10-22T10:01:00") })];
    await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
    await settleReactWork();
    expect(pageReads).toBe(2);
  },
  20_000,
);

test("Make replaces a page request started before completion and keeps the other task's card", async () => {
  reducedMotion(true);
  listed = [notes];
  tasks = [];
  serving();
  const { view } = app();
  await view.findByRole("list", { name: "Made for you" });
  await startMaking(view);
  await startMaking(view);
  expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
    "/tasks/task-10",
    "/tasks/task-9",
    "/make/notes",
  ]);

  const serve = global.fetch;
  const oldRead = Promise.withResolvers<Response>();
  let pageReads = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/openduet/pages" && ++pageReads === 1)
      return oldRead.promise;
    return serve(input, init);
  }) as typeof fetch;
  // A page poll is already waiting with a snapshot from before the task finished.
  const stalePoll = queryClient.refetchQueries({ queryKey: pageKeys.list });
  try {
    await waitFor(() => expect(pageReads).toBe(1));
    listed = [deck, notes];
    tasks = [task({ id: "task-10" }), task({ status: "ready_for_review" })];
    await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
    await waitFor(
      () =>
        expect(
          opened(view.getByRole("list", { name: "Made for you" })),
        ).toEqual(["/tasks/task-10", "/make/deck", "/make/notes"]),
      { onTimeout: (error) => error },
    );
  } finally {
    oldRead.resolve(Response.json({ pages: [notes] }));
    await act(() => stalePoll);
  }
  expect(pageReads).toBe(2);
  expectFinalPageCache();
}, 20_000);

test("Make replaces a later task with its output regardless of page list order", async () => {
  reducedMotion(true);
  listed = [notes];
  tasks = [];
  serving();
  const { view } = app();
  await view.findByRole("list", { name: "Made for you" });
  await startMaking(view);

  // The first task's output arrives and remains claimed after the task finishes.
  listed = [deck, notes];
  tasks = [task({ status: "ready_for_review" })];
  await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
  await waitFor(() =>
    expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
      "/make/deck",
      "/make/notes",
    ]),
  );
  await startMaking(view);
  expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
    "/tasks/task-10",
    "/make/deck",
    "/make/notes",
  ]);
  const pageQuery = queryClient
    .getQueryCache()
    .find({ queryKey: pageKeys.list });
  const poll = () => {
    const interval = pageQuery?.observers[0]?.options.refetchInterval;
    return typeof interval === "function" && pageQuery
      ? interval(pageQuery)
      : interval;
  };
  expect(poll()).toBe(3_000);

  // A request for input still counts as active, but its new page replaces its card.
  tasks = [task({ id: "task-10", status: "needs_input" }), tasks[1]];
  await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
  await waitFor(() =>
    expect(view.getByText("Needs input").textContent).toBe("Needs input"),
  );
  listed = [pulse, deck, notes];
  await act(() => queryClient.refetchQueries({ queryKey: pageKeys.list }));
  await waitFor(
    () =>
      expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
        "/make/pulse",
        "/make/deck",
        "/make/notes",
      ]),
    { onTimeout: (error) => error },
  );
  expect(poll()).toBe(false);

  // Reordering the same pages can move cards, but cannot change which tasks have output.
  listed = [notes, deck, pulse];
  await act(() => queryClient.refetchQueries({ queryKey: pageKeys.list }));
  await waitFor(() =>
    expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
      "/make/notes",
      "/make/deck",
      "/make/pulse",
    ]),
  );
  expect(poll()).toBe(false);
});

test("Make reconciles completion even while its first page load is pending", async () => {
  reducedMotion(true);
  listed = [notes];
  tasks = [];
  serving();
  const serve = global.fetch;
  const initialRead = Promise.withResolvers<Response>();
  let pageReads = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/openduet/pages" && ++pageReads === 1)
      return initialRead.promise;
    return serve(input, init);
  }) as typeof fetch;
  const { view } = app();
  try {
    await startMaking(view);
    listed = [deck, notes];
    tasks = [task({ status: "ready_for_review" })];
    await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
    expect(
      await view.findByRole("link", { name: /Hearth & Co orders/ }),
    ).toBeTruthy();
  } finally {
    initialRead.resolve(Response.json({ pages: [notes] }));
    await settleReactWork();
  }
  expect(pageReads).toBe(2);
  expectFinalPageCache();
}, 20_000);

test("Make keeps a working task through its first page list until a later poll finds new output", async () => {
  reducedMotion(true);
  listed = [notes];
  tasks = [];
  serving();
  const serve = global.fetch;
  const initialRead = Promise.withResolvers<Response>();
  let pageReads = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/openduet/pages" && ++pageReads === 1)
      return initialRead.promise;
    return serve(input, init);
  }) as typeof fetch;
  const { view } = app();
  try {
    await startMaking(view);
    await act(async () =>
      initialRead.resolve(Response.json({ pages: [notes] })),
    );
    await waitFor(() =>
      expect(view.queryByRole("list", { name: "Made for you" }) === null).toBe(
        false,
      ),
    );
    const active = () =>
      view.container.querySelector('a[href="/tasks/task-9"]');
    expect(active() === null).toBe(false);
    expect(active()?.querySelector("[data-status]")?.textContent).toBe(
      "Working",
    );
    expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
      "/tasks/task-9",
      "/make/notes",
    ]);
    const pageQuery = queryClient
      .getQueryCache()
      .find({ queryKey: pageKeys.list });
    const observer = pageQuery?.observers[0];
    const interval = observer?.options.refetchInterval;
    expect(
      typeof interval === "function" && pageQuery
        ? interval(pageQuery)
        : interval,
    ).toBe(3_000);
    expect(pageReads).toBe(1);

    listed = [deck, notes];
    // Drive one observer fetch: this DOM harness imports query-core in server mode, without timers.
    await act(() => observer?.refetch());
    await waitFor(() => expect(active() === null).toBe(true), {
      onTimeout: (error) => error,
    });
    expect(pageReads).toBe(2);
    expect(tasks[0]?.status).toBe("working");
    expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
      "/make/deck",
      "/make/notes",
    ]);
  } finally {
    initialRead.resolve(Response.json({ pages: [notes] }));
  }
});

test("a stopped task without an output stops page polling and can reconcile a later retry", async () => {
  reducedMotion(true);
  listed = [notes];
  tasks = [];
  serving();
  const serve = global.fetch;
  let pageReads = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/openduet/pages") pageReads++;
    return serve(input, init);
  }) as typeof fetch;
  const { view } = app();
  await view.findByRole("list", { name: "Made for you" });
  await startMaking(view);
  tasks = [task({ status: "failed" })];
  await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
  await waitFor(() => expect(pageReads).toBe(2));
  await settleReactWork();

  const pageQuery = queryClient
    .getQueryCache()
    .find({ queryKey: pageKeys.list });
  const poll = () => {
    const interval = pageQuery?.observers[0]?.options.refetchInterval;
    return typeof interval === "function" && pageQuery
      ? interval(pageQuery)
      : interval;
  };
  expect(poll()).toBe(false);
  expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
    "/make/notes",
  ]);

  tasks = [task({ status: "needs_input" })];
  await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
  await waitFor(() => expect(poll()).toBe(3_000));
  expect(pageReads).toBe(2);
  listed = [deck, notes];
  tasks = [task({ status: "ready_for_review" })];
  await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
  expect(
    await view.findByRole("link", { name: /Hearth & Co orders/ }),
  ).toBeTruthy();
  expect(pageReads).toBe(3);
  expect(poll()).toBe(false);
}, 20_000);

test("Make replaces a later task's card after an earlier task finished without output", async () => {
  reducedMotion(true);
  listed = [];
  tasks = [];
  serving();
  const serve = global.fetch;
  let pageReads = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/openduet/pages") pageReads++;
    return serve(input, init);
  }) as typeof fetch;
  const { view } = app();
  await view.findByText("Nothing made yet.");
  await startMaking(view);

  // A failed before making anything, including in the final read after it stopped.
  tasks = [task({ status: "failed" })];
  await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
  await waitFor(() => expect(pageReads).toBe(2));
  await waitFor(() =>
    expect(queryClient.getQueryState(pageKeys.list)?.fetchStatus).toBe("idle"),
  );
  await settleReactWork();
  expect(view.queryByText("Nothing made yet.") === null).toBe(false);

  // B starts with that same empty baseline and must stay visible until its own output arrives.
  await startMaking(view);
  expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
    "/tasks/task-10",
  ]);
  const pageQuery = queryClient
    .getQueryCache()
    .find({ queryKey: pageKeys.list });
  const observer = pageQuery?.observers[0];
  const poll = () => {
    const interval = observer?.options.refetchInterval;
    return typeof interval === "function" && pageQuery
      ? interval(pageQuery)
      : interval;
  };
  expect(poll()).toBe(3_000);
  tasks = [task({ id: "task-10", status: "needs_input" }), tasks[1]];
  await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
  await waitFor(() =>
    expect(view.getByText("Needs input").textContent).toBe("Needs input"),
  );
  listed = [deck];
  await act(() => observer?.refetch());
  await waitFor(
    () =>
      expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
        "/make/deck",
      ]),
    { onTimeout: (error) => error },
  );
  expect(pageReads).toBe(3);
  expect(poll()).toBe(false);
});

test("Make closes a failed terminal read after an ordinary empty recovery before the next task", async () => {
  reducedMotion(true);
  listed = [];
  tasks = [];
  serving();
  const serve = global.fetch;
  let failPages = false;
  let failures = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/openduet/pages" && failPages) {
      failures++;
      return Response.json({ error: "Unavailable" }, { status: 503 });
    }
    return serve(input, init);
  }) as typeof fetch;
  const { view } = app();
  await view.findByText("Nothing made yet.");
  const pageQuery = queryClient
    .getQueryCache()
    .find({ queryKey: pageKeys.list });
  const observer = pageQuery?.observers[0];
  const poll = () => {
    const interval = observer?.options.refetchInterval;
    return typeof interval === "function" && pageQuery
      ? interval(pageQuery)
      : interval;
  };
  expect([
    pageQuery?.state.status,
    pageQuery?.state.fetchStatus,
    pageQuery?.state.data,
  ]).toEqual(["success", "idle", []]);
  await startMaking(view);
  const before = pageQuery?.state.dataUpdateCount;
  failPages = true;
  tasks = [task({ status: "failed" })];
  await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
  await view.findByRole("alert", {}, { timeout: 3_000 });
  await settleReactWork();
  expect([
    pageQuery?.state.status,
    pageQuery?.state.fetchStatus,
    pageQuery?.state.dataUpdateCount,
    failures,
  ]).toEqual(["error", "idle", before, 2]);

  // This successful empty read separates A's possible output from B, which has not started.
  failPages = false;
  await act(() => observer?.refetch());
  await view.findByText("Nothing made yet.");
  await settleReactWork();
  expect([
    pageQuery?.state.status,
    pageQuery?.state.fetchStatus,
    pageQuery?.state.data,
    (pageQuery?.state.dataUpdateCount ?? 0) > (before ?? 0),
  ]).toEqual(["success", "idle", [], true]);
  expect(view.container.querySelector('a[href="/tasks/task-9"]') === null).toBe(
    true,
  );

  await startMaking(view);
  tasks = [task({ id: "task-10", status: "needs_input" }), tasks[1]];
  await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.list }));
  await view.findByText("Needs input");
  expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
    "/tasks/task-10",
  ]);
  expect(poll()).toBe(3_000);
  listed = [deck];
  await act(() => observer?.refetch());
  await view.findByRole("link", { name: /Hearth & Co orders/ });
  await settleReactWork();
  expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
    "/make/deck",
  ]);
  expect(poll()).toBe(false);
});

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
  expect(labels[1]).toContain("Slides ·");
  expect(labels[2]).toContain("Web page ·");
});

test("Make grid chart previews preserve each original bar's scale and highlight", async () => {
  const items = [
    { label: "First", value: 10 },
    { label: "Second", value: 20 },
  ];
  listed = (["page", "slides", "dashboard"] as const).map((kind) => ({
    ...deck,
    id: kind,
    kind,
    preview: {
      blocks: [
        { type: "heading", text: "Shared scale" },
        { type: "bars", items, scale: 100, highlight: 0 },
        { type: "text", text: "After the chart" },
        { type: "text", text: "Outside the document grid's block slice" },
      ],
    },
  }));
  tasks = [];
  serving();
  const { view } = app();
  const grid = await view.findByRole("list", { name: "Made for you" });
  const previews = [...grid.querySelectorAll("[data-preview]")];
  expect(
    previews.map((preview) => preview.getAttribute("data-preview")),
  ).toEqual(["page", "slides", "dashboard"]);
  for (const preview of previews) {
    const bars = [
      ...preview.querySelectorAll<HTMLElement>('span[style*="height:"]'),
    ];
    expect(bars.map((bar) => bar.style.height)).toEqual(["10%", "20%"]);
    expect(
      bars.map((bar) => ({
        label: bar.title,
        highlighted: bar.classList.contains("bg-duet-violet"),
      })),
    ).toEqual([
      { label: "First", highlighted: true },
      { label: "Second", highlighted: false },
    ]);
  }
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
  ).toEqual([
    "All",
    "Design System",
    "Design",
    "Dashboard",
    "Slides",
    "Docs",
    "Web page",
  ]);
  const chip = (name: string) => within(chips).getByRole("button", { name });
  expect(chip("All").getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(chip("Slides"));
  expect(chip("Slides").getAttribute("aria-pressed")).toBe("true");
  expect(chip("All").getAttribute("aria-pressed")).toBe("false");
  expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
    "/make/deck",
  ]);
  // A dashboard is a page too, but Pages holds the ones that are not dashboards.
  fireEvent.click(chip("Web page"));
  expect(opened(view.getByRole("list", { name: "Made for you" }))).toEqual([
    "/make/notes",
  ]);
  fireEvent.click(chip("Dashboard"));
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
      { name: "Slides" },
    ),
  );
  expect(
    second.view.getByText("No slides yet. Tap + to make one."),
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
      "Tap + to choose what to make. What OpenDuet makes shows up here.",
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
  expect(view.queryByRole("button", { name: "Make a slides" })).toBeNull();

  fireEvent.click(plus);
  const fan = view.getByRole("list", { name: "What to make" });
  const options = within(fan).getAllByRole("button");
  expect(options.map((option) => option.textContent)).toEqual([
    "Design System",
    "Design",
    "Dashboard",
    "Slides",
    "Docs",
    "Web page",
  ]);
  expect(view.getByRole("button", { name: "Close", expanded: true })).toBe(
    plus,
  );
  // They rise into place from below, a beat apart, so they start lower and smaller.
  const items = [...fan.querySelectorAll("li")];
  for (const item of items)
    expect(item.style.transform).toContain("translateY");

  // Escape folds them away. The list stays drawn while they fold back into the +, rather than
  // being hidden on the press, which hid the fold before it could play.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(plus.getAttribute("aria-expanded")).toBe("false");
  expect(fan.hidden).toBe(false);
  expect(within(fan).getAllByRole("button")).toHaveLength(6);
  // Motion draws only on a frame, and this DOM gets none of its own: run them by hand until the
  // last pill has folded, and the list is hidden again.
  await runMotionFrames(40);
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Make a slides" }) === null).toBe(
      true,
    ),
  );
  expect(fan.hidden).toBe(true);
});

test("with reduced motion the options fade in place, without rising", async () => {
  reducedMotion(true);
  listed = [];
  serving();
  const { view } = app();
  fireEvent.click(await view.findByRole("button", { name: "Make something" }));
  const fan = view.getByRole("list", { name: "What to make" });
  expect(within(fan).getAllByRole("button")).toHaveLength(6);
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
  fireEvent.click(view.getByRole("button", { name: "Make a slides" }));

  const sheet = await view.findByRole("dialog", {
    name: "What should OpenDuet make?",
  });
  const field = within(sheet).getByRole("textbox") as HTMLTextAreaElement;
  const starter = MAKE_KINDS.find((kind) => kind.id === "slides")?.starter;
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
  fireEvent.click(view.getByRole("button", { name: "Make a docs" }));
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
