import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
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
import { QuestionSheet } from "@/components/duet/question-sheet";
import { CHECK_HOLD_MS } from "@/components/shell/tasks-active";
import {
  TASKS_VIEW_STORAGE_KEY,
  TasksScreen,
} from "@/components/shell/tasks-screen";
import { agentKeys } from "@/lib/agents/queries";
import { queryClient } from "@/query-client";
import { runMotionFrames } from "./run-motion-frames";
import { settleReactWork } from "./settle-react-work";

/**
 * The Tasks tab: Active and Up next under one switch. Active groups what is under way and what needs
 * the person by what each thing needs, Ready for review, Needs input, Working and Resolved, leaving
 * out a group with nothing in it. Up next lists what nobody has started, and when it is empty asks
 * what it can take off the person's plate. The + adds a task, started now or saved for Up next.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  window.localStorage.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

let inbox: Record<string, unknown> = {};
let suggestions: unknown[] = [];
let settings: unknown[] = [];
let activity: Record<string, unknown> = {};
let channels: unknown[] = [];
let tasks: unknown[] = [];
/** The person's channels, as the drawer and every tag read them. */
let duetChannels: unknown[] = [];
const sent: { method: string; path: string; body: unknown }[] = [];
function serving() {
  sent.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ method: init.method, path: url, body });
      if (url === "/api/channels")
        return Response.json({ channel: newChannel }, { status: 201 });
      if (url === "/api/openduet/tasks")
        return Response.json(
          {
            task: task({
              id: "started",
              title: body.instruction,
              status: "working",
            }),
          },
          { status: 201 },
        );
      if (url === "/api/openduet/tasks/up-next")
        return Response.json(
          { suggestion: { id: "saved", title: body.instruction } },
          { status: 201 },
        );
      const resolved = url.match(/^\/api\/openduet\/tasks\/([^/]+)\/resolve$/);
      if (resolved)
        return Response.json({
          task: task({ id: resolved[1], status: "resolved" }),
        });
      return Response.json({ ok: true });
    }
    if (url === "/api/approvals") return Response.json(inbox);
    if (url === "/api/agents")
      return Response.json({
        agents: queryClient.getQueryData(agentKeys.list(false)) ?? [],
      });
    if (url === "/api/proactive/suggestions")
      return Response.json({ suggestions });
    if (url === "/api/proactive/settings") return Response.json({ settings });
    if (url === "/api/bots/openduet/activity")
      return Response.json({ activity });
    if (url === "/api/channels")
      return Response.json({ channels, nextCursor: null });
    if (url === "/api/openduet/tasks") return Response.json({ tasks });
    if (url === "/api/openduet/channels?bot=openduet")
      return Response.json({ everythingId: "chat-1", channels: duetChannels });
    return Response.json({});
  }) as unknown as typeof fetch;
}

function draw() {
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "openduet", name: "OpenDuet" },
    { id: "scout", name: "Scout" },
  ]);
  const router = createRouter({
    routeTree: createRootRoute({ component: TasksScreen }),
    history: createMemoryHistory({ initialEntries: ["/tasks"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** Nothing waiting, nothing suggested, research on, nothing under way: the quiet screen. */
function quiet() {
  inbox = { requests: [], questions: [] };
  suggestions = [];
  settings = [research()];
  activity = { inProgress: [], scheduled: [], completed: [] };
  channels = [];
  tasks = [];
  duetChannels = [];
}

/** An ISO time this many minutes before now, so "Updated" reads the same whenever the test runs. */
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const research = (overrides: Record<string, unknown> = {}) => ({
  id: "research-1",
  agentId: "openduet",
  channelId: "chat-1",
  focus: "",
  enabled: true,
  intervalMinutes: 60,
  nextRunAt: "2026-10-22T19:00:00Z",
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
  ...overrides,
});

const suggestion = (overrides: Record<string, unknown>) => ({
  id: "s",
  agentId: "openduet",
  runId: "run-1",
  title: "Reply to Rosa about the glaze",
  detail: "Rosa asked whether the satin glaze can replace the gloss one.",
  sourceApp: "Gmail",
  sourceLink: null,
  createdAt: ago(60),
  ...overrides,
});

const conversation = (overrides: Record<string, unknown>) => ({
  id: "chat-1",
  name: "OpenDuet",
  agentIds: ["openduet"],
  threadId: "t",
  active: true,
  lastMessageAt: "2026-10-22T10:00:00Z",
  summary: null,
  lastMessage: null,
  lastMessageAgentId: null,
  createdAt: "2026-10-20T10:00:00Z",
  pinned: false,
  lastReadAt: null,
  ...overrides,
});
const newChannel = conversation({
  id: "chat-new",
  lastMessageAt: null,
  createdAt: "2026-10-22T12:00:00Z",
});

const item = (overrides: Record<string, unknown>) => ({
  id: "x",
  kind: "follow_up",
  title: "Review the launch deck",
  detail: null,
  status: "scheduled",
  at: ago(30),
  channelId: null,
  needsYou: false,
  stoppable: false,
  cancellable: false,
  ...overrides,
});

const email = (overrides: Record<string, unknown> = {}) => ({
  id: "mail-1",
  status: "pending",
  createdAt: ago(20),
  ...overrides,
  action: {
    botId: "openduet",
    toolRef: "gmail/GMAIL_SEND_EMAIL",
    effect: "write",
    scope: "ana@hearth.example",
    threadId: "thread",
    toolCallId: "call-1",
    args: {
      recipient_email: "ana@hearth.example",
      subject: "Ship date for your mugs",
      body: "Hi Ana, could we ship on Tuesday instead?",
    },
    target: {},
    policy: { behaviour: "ask", source: "rule", reason: "Emails ask first." },
    ...(overrides.action as Record<string, unknown> | undefined),
  },
});

const task = (overrides: Record<string, unknown>) => ({
  id: "task",
  botId: "openduet",
  channelId: `${overrides.id ?? "task"}-channel`,
  threadId: `${overrides.id ?? "task"}-thread`,
  title: "Draft a reply to Rosa about Oat Satin",
  why: null,
  origin: "asked",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  status: "working",
  resolvedAt: null,
  createdAt: ago(120),
  updatedAt: ago(120),
  ...overrides,
});

const regionNames = (view: ReturnType<typeof draw>) =>
  within(view.getByRole("tabpanel"))
    .queryAllByRole("region")
    .map((region) => region.getAttribute("aria-label"))
    .filter((name) =>
      ["Ready for review", "Needs input", "Working", "Resolved"].includes(
        name ?? "",
      ),
    );

/** Unfolds Resolved, which starts folded, and returns its region. */
async function unfoldResolved(view: ReturnType<typeof draw>) {
  const resolved = await view.findByRole("region", { name: "Resolved" });
  const toggle = within(resolved).getByRole("button", { name: /^Resolved/ });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  return resolved;
}

/** Each task row's title, in the order a group lists them. */
const taskTitles = (group: HTMLElement) =>
  within(group)
    .queryAllByRole("link")
    .map((link) => link.querySelector("p")?.textContent);

// ---------- the switch ----------

test("Tasks opens on Active, with Up next beside it, sort and search on the right, and the +", async () => {
  quiet();
  serving();
  const view = draw();
  const tabs = await view.findByRole("tablist", { name: "Tasks" });
  const [active, upNext] = within(tabs).getAllByRole("tab");
  expect(active?.textContent).toBe("Active");
  expect(active?.getAttribute("aria-selected")).toBe("true");
  expect(upNext?.textContent).toBe("Up next");
  expect(upNext?.getAttribute("aria-selected")).toBe("false");
  expect(view.getByRole("button", { name: "Sort: newest first" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Search tasks" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Add a task" })).toBeTruthy();
  expect(await view.findByText("Nothing active right now.")).toBeTruthy();
});

test("the list last shown is remembered in this browser", async () => {
  quiet();
  suggestions = [suggestion({ id: "s-1" })];
  serving();
  const first = draw();
  fireEvent.click(await first.findByRole("tab", { name: "Up next" }));
  expect(window.localStorage.getItem(TASKS_VIEW_STORAGE_KEY)).toBe("up_next");
  await first.findByText("Reply to Rosa about the glaze");
  cleanup();

  const again = draw();
  const upNext = await again.findByRole("tab", { name: "Up next" });
  expect(upNext.getAttribute("aria-selected")).toBe("true");
  expect(await again.findByText("Reply to Rosa about the glaze")).toBeTruthy();

  fireEvent.click(again.getByRole("tab", { name: "Active" }));
  expect(window.localStorage.getItem(TASKS_VIEW_STORAGE_KEY)).toBe("active");
});

// ---------- Active ----------

test("a failed accepted answer stays Failed with Try again despite its unfinished inbox question", async () => {
  quiet();
  tasks = [
    task({
      id: "answered",
      threadId: "answered-thread",
      status: "failed",
      failure: "a service didn't answer",
      failedAt: ago(1),
      answeredQuestionIds: ["old-question"],
    }),
  ];
  inbox = {
    requests: [],
    questions: [
      {
        id: "old-question",
        botId: "openduet",
        threadId: "answered-thread",
        question: "Which deck?",
        createdAt: ago(5),
      },
    ],
  };
  serving();
  const view = draw();
  const failed = await view.findByRole("region", { name: "Failed" });
  expect(failed.textContent).toContain(
    "Couldn't finish: a service didn't answer.",
  );
  expect(
    within(failed).getByRole("button", { name: "Try this task again" }),
  ).toBeTruthy();
  expect(view.queryByRole("region", { name: "Needs input" })).toBeNull();
});

test("Active groups everything by what it needs: Ready for review, Needs input, Working, Resolved", async () => {
  quiet();
  tasks = [
    task({ id: "rosa", status: "working" }),
    task({
      id: "hearth",
      title: "Prepare notes for the Hearth & Co visit",
      status: "needs_input",
    }),
    task({
      id: "sam",
      title: "Answer Sam about Friday off",
      status: "ready_for_review",
      origin: "suggestion",
      sourceApp: "Gmail",
      next: "Send the reply to Sam? It tells him Friday is fine.",
    }),
    task({
      id: "invoice",
      title: "Pay the kiln repair invoice",
      status: "resolved",
      resolvedAt: ago(5),
    }),
  ];
  inbox = { requests: [email()], questions: [] };
  activity = {
    inProgress: [
      item({
        id: "handoff-1",
        kind: "handoff",
        title: "Draft the wholesale reply",
        status: "running",
        channelId: "chat-1",
        stoppable: true,
      }),
    ],
    scheduled: [],
    completed: [
      item({ id: "done-1", title: "Sorted the inbox", status: "done" }),
    ],
  };
  serving();
  const view = draw();
  await view.findByRole("region", { name: "Resolved" });
  expect(regionNames(view)).toEqual([
    "Ready for review",
    "Needs input",
    "Working",
    "Resolved",
  ]);

  const ready = view.getByRole("region", { name: "Ready for review" });
  const row = within(ready).getByRole("link", {
    name: /Answer Sam about Friday off/,
  });
  expect(row.getAttribute("href")).toBe("/tasks/sam");
  const status = row.querySelector("[data-status]");
  // The run's own next step, after the state word, on one line.
  expect(status?.textContent).toBe(
    "Ready for review · Send the reply to Sam? It tells him Friday is fine.",
  );
  expect(status?.className).toContain("truncate");
  // The state word carries the group's colour, at regular weight.
  expect(status?.querySelector("span")?.className).toContain("text-duet-green");
  expect(status?.querySelector("span")?.className).not.toContain(
    "font-semibold",
  );
  // A flat row: where it came from is not a line of its own.
  expect(row.textContent).not.toContain("Gmail");

  const needs = view.getByRole("region", { name: "Needs input" });
  expect(taskTitles(needs)).toEqual([
    "Prepare notes for the Hearth & Co visit",
  ]);
  expect(
    within(needs).getByRole("region", { name: "Waiting for your approval" }),
  ).toBeTruthy();
  expect(
    within(needs)
      .getByRole("link", { name: /Prepare notes/ })
      .querySelector("[data-status] span")?.className,
  ).toContain("text-duet-amber");

  const working = view.getByRole("region", { name: "Working" });
  expect(working.textContent).toContain(
    "Draft a reply to Rosa about Oat Satin",
  );
  expect(working.textContent).not.toContain("You asked");
  expect(working.textContent).toContain("Working · Just started");
  expect(working.textContent).toContain("Draft the wholesale reply");
  expect(
    within(working)
      .getByRole("link", { name: /Draft the wholesale reply/ })
      .getAttribute("href"),
  ).toBe("/channel/chat-1");

  const resolved = view.getByRole("region", { name: "Resolved" });
  // Folded: its heading alone, with no count, until it is pressed.
  expect(resolved.textContent).not.toContain("Pay the kiln repair invoice");
  expect(within(resolved).getByRole("heading").textContent?.trim()).toBe(
    "Resolved",
  );
  await unfoldResolved(view);
  expect(resolved.textContent).toContain("Pay the kiln repair invoice");
  expect(resolved.textContent).toContain("Sorted the inbox");
  // A task is opened from its row; approvals have no circle.
  expect(
    within(needs).queryByRole("button", { name: /^Mark Send email/ }),
  ).toBeNull();
});

test("a group with nothing in it is left out", async () => {
  quiet();
  tasks = [task({ id: "rosa", status: "working" })];
  serving();
  const view = draw();
  await view.findByRole("region", { name: "Working" });
  expect(regionNames(view)).toEqual(["Working"]);
  expect(view.queryByText("Nothing active right now.")).toBeNull();
});

test("each group heads itself with how many it holds and when the newest one changed", async () => {
  quiet();
  tasks = [
    task({
      id: "a",
      title: "Older",
      status: "ready_for_review",
      updatedAt: ago(180),
    }),
    task({
      id: "b",
      title: "Newer",
      status: "ready_for_review",
      updatedAt: ago(1),
    }),
    task({ id: "c", title: "Running", status: "working", updatedAt: ago(90) }),
  ];
  serving();
  const view = draw();
  const ready = await view.findByRole("region", { name: "Ready for review" });
  expect(within(ready).getByRole("heading").textContent).toBe(
    "Ready for review 2",
  );
  // The list's freshness, once, beside the first heading.
  expect(ready.textContent).toContain("Updated 1 min ago");
  expect(taskTitles(ready)).toEqual(["Newer", "Older"]);
  const working = view.getByRole("region", { name: "Working" });
  expect(within(working).getByRole("heading").textContent).toBe("Working 1");
  expect(working.textContent).not.toContain("Updated");
});

test("sorted oldest first, each group turns round", async () => {
  quiet();
  tasks = [
    task({
      id: "a",
      title: "Older",
      status: "ready_for_review",
      updatedAt: ago(180),
    }),
    task({
      id: "b",
      title: "Newer",
      status: "ready_for_review",
      updatedAt: ago(1),
    }),
  ];
  serving();
  const view = draw();
  const ready = await view.findByRole("region", { name: "Ready for review" });
  expect(taskTitles(ready)).toEqual(["Newer", "Older"]);
  fireEvent.click(view.getByRole("button", { name: "Sort: newest first" }));
  expect(view.getByRole("button", { name: "Sort: oldest first" })).toBeTruthy();
  expect(
    taskTitles(view.getByRole("region", { name: "Ready for review" })),
  ).toEqual(["Older", "Newer"]);
});

test("an approval in a task's own conversation belongs to that task: listed once, as the task, saying what it needs", async () => {
  quiet();
  tasks = [
    task({
      id: "rosa",
      title: "Reply to Rosa about Oat Satin",
      // The server has not caught up yet; the waiting approval is enough.
      status: "ready_for_review",
    }),
  ];
  inbox = {
    requests: [
      email({ id: "in-task", action: { threadId: "rosa-thread" } }),
      email({ id: "loose", createdAt: ago(40) }),
    ],
    questions: [],
  };
  serving();
  const view = draw();
  const needs = await view.findByRole("region", { name: "Needs input" });
  expect(view.queryByRole("region", { name: "Ready for review" })).toBeNull();
  const row = within(needs).getByRole("link", {
    name: /Reply to Rosa about Oat Satin/,
  });
  expect(row.querySelector("[data-status]")?.textContent).toBe(
    "Needs input · Allow it to send email, or refuse",
  );
  // Only the loose one is drawn as a card to answer here.
  expect(
    within(needs).getAllByRole("region", { name: "Waiting for your approval" }),
  ).toHaveLength(1);
  expect(within(needs).getByRole("heading").textContent).toContain(
    "Needs input 2",
  );
});

test("a waiting email is answered in place under Needs input", async () => {
  quiet();
  inbox = { requests: [email()], questions: [] };
  serving();
  const view = draw();
  const needs = await view.findByRole("region", { name: "Needs input" });
  const card = within(needs).getByRole("region", {
    name: "Waiting for your approval",
  });
  expect(card.textContent).toContain("Send email");
  expect(card.textContent).toContain("Ship date for your mugs");
  fireEvent.click(view.getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/approvals/mail-1/decision",
      body: { decision: "allow_once" },
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Refuse" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/approvals/mail-1/decision",
      body: { decision: "deny" },
    }),
  );
});

test("a decided action is not waiting, and not a task: it is left out of Needs input and Resolved", async () => {
  quiet();
  inbox = {
    requests: [
      email({ status: "completed", decision: "allow_once", decidedAt: ago(5) }),
    ],
    questions: [],
  };
  tasks = [
    task({
      id: "done",
      title: "Done today",
      status: "resolved",
      resolvedAt: ago(10),
    }),
  ];
  serving();
  const view = draw();
  const resolved = await view.findByRole("region", { name: "Resolved" });
  expect(view.queryByRole("region", { name: "Needs input" })).toBeNull();
  // Its conversation shows the action that ran; a receipt is not finished work.
  expect(resolved.textContent).not.toContain("Allowed once by you");
});

test("a question outside any task is a row under Needs input that opens its own page", async () => {
  quiet();
  inbox = {
    requests: [],
    questions: [
      {
        id: "q-1",
        botId: "openduet",
        threadId: "thread",
        question: "Which deck should I review?",
        createdAt: ago(10),
      },
    ],
  };
  serving();
  const view = draw();
  const needs = await view.findByRole("region", { name: "Needs input" });
  const row = within(needs).getByRole("link", { name: /OpenDuet asks/ });
  expect(row.getAttribute("href")).toBe("/tasks/questions/q-1");
  expect(row.querySelector("[data-status]")?.textContent).toBe(
    "Needs input · Which deck should I review?",
  );
  // Answered on its page, not here: no box and no Send on the list.
  expect(view.queryByRole("textbox", { name: "Your answer" })).toBeNull();
  expect(view.queryByRole("button", { name: "Send answer" })).toBeNull();
});

test("a question's page shows the question and sends the answer, then closes", async () => {
  quiet();
  inbox = {
    requests: [],
    questions: [
      {
        id: "q-1",
        botId: "openduet",
        threadId: "thread",
        question: "Which deck should I review?",
        why: "Two decks changed today.",
        createdAt: ago(10),
      },
    ],
  };
  serving();
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "openduet", name: "OpenDuet" },
  ]);
  let closed = 0;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <QuestionSheet onClose={() => (closed += 1)} questionId="q-1" />
    </QueryClientProvider>,
  );
  expect(await view.findByText("Which deck should I review?")).toBeTruthy();
  expect(view.getByText("OpenDuet asks")).toBeTruthy();
  expect(view.getByText("Two decks changed today.")).toBeTruthy();
  const send = view.getByRole("button", { name: "Send answer" });
  expect(send.hasAttribute("disabled")).toBe(true);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "Your answer" }),
    "The launch deck",
  );
  await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
  fireEvent.click(send);
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/approvals/questions/q-1/respond",
      body: { response: "The launch deck" },
    }),
  );
  await waitFor(() => expect(closed).toBe(1));
});

test("a question already answered says so on its page", async () => {
  quiet();
  serving();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <QuestionSheet onClose={() => {}} questionId="gone" />
    </QueryClientProvider>,
  );
  expect(
    await view.findByText("This question has been answered."),
  ).toBeTruthy();
});

test("the check circle marks a task done: the check lands, and the row stays put a moment before it moves", async () => {
  quiet();
  tasks = [
    task({ id: "sam", title: "Answer Sam", status: "ready_for_review" }),
  ];
  serving();
  const view = draw();
  const circle = await view.findByRole("button", {
    name: "Mark Answer Sam done",
  });
  expect(circle.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(circle);
  expect(circle.getAttribute("aria-pressed")).toBe("true");
  expect(circle.querySelector(".duet-check-land")).toBeTruthy();
  // Sent at once, so leaving the screen cannot lose it.
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/openduet/tasks/sam/resolve",
      body: undefined,
    }),
  );
  // The server now says it is resolved, but the list waits for the check to be seen.
  tasks = [
    task({
      id: "sam",
      title: "Answer Sam",
      status: "resolved",
      resolvedAt: new Date().toISOString(),
    }),
  ];
  expect(view.getByRole("region", { name: "Ready for review" })).toBeTruthy();
  await act(
    () => new Promise((resolve) => setTimeout(resolve, CHECK_HOLD_MS + 50)),
  );
  await waitFor(() =>
    expect(view.queryByRole("region", { name: "Ready for review" })).toBeNull(),
  );
  await unfoldResolved(view);
  expect(
    await view.findByRole("button", { name: "Reopen Answer Sam" }),
  ).toBeTruthy();
});

test("a done task's circle is filled, and pressing it reopens the task", async () => {
  quiet();
  tasks = [
    task({
      id: "sam",
      title: "Answer Sam",
      status: "resolved",
      resolvedAt: ago(3),
    }),
  ];
  serving();
  const view = draw();
  await unfoldResolved(view);
  const circle = await view.findByRole("button", { name: "Reopen Answer Sam" });
  expect(circle.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(circle);
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/openduet/tasks/sam/reopen",
      body: undefined,
    }),
  );
});

test("Resolved keeps a week of done tasks, newest first, folded until its heading is pressed", async () => {
  quiet();
  tasks = [
    ...Array.from({ length: 6 }, (_, index) =>
      task({
        id: `done-${index}`,
        title: `Done ${index}`,
        status: "resolved",
        resolvedAt: ago(10 + index),
      }),
    ),
    task({
      id: "old",
      title: "Done last month",
      status: "resolved",
      resolvedAt: ago(60 * 24 * 30),
    }),
  ];
  serving();
  const view = draw();
  const resolved = await view.findByRole("region", { name: "Resolved" });
  const toggle = within(resolved).getByRole("button", { name: /^Resolved/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(taskTitles(resolved)).toEqual([]);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(taskTitles(resolved)).toEqual([
    "Done 0",
    "Done 1",
    "Done 2",
    "Done 3",
    "Done 4",
    "Done 5",
  ]);
  expect(resolved.textContent).not.toContain("Done last month");
  fireEvent.click(toggle);
  expect(taskTitles(resolved)).toEqual([]);
});

test("Resolved lists finished work, read-only, beside done tasks, and not the actions answered", async () => {
  quiet();
  activity = {
    inProgress: [],
    scheduled: [],
    completed: [
      item({
        id: "done",
        title: "Review the launch deck",
        status: "done",
        at: ago(50),
      }),
      item({
        id: "broke",
        kind: "routine",
        title: "Tidy inbox",
        status: "failed",
        at: ago(5),
      }),
    ],
  };
  inbox = {
    requests: [
      email({
        id: "r",
        status: "completed",
        decidedAt: ago(20),
        decision: "allow_once",
      }),
    ],
    questions: [],
  };
  serving();
  const view = draw();
  const resolved = await unfoldResolved(view);
  const text = resolved.textContent ?? "";
  expect(text).toContain("Follow-up · Done");
  expect(text).toContain("Didn't finish");
  expect(text).not.toContain("Allowed once by you");
  const order = ["Tidy inbox", "Review the launch deck"].map((title) =>
    text.indexOf(title),
  );
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // Read-only: the only button is the heading that folds it.
  expect(within(resolved).queryAllByRole("button")).toHaveLength(1);
});

test("Working keeps Stop on other work under way", async () => {
  quiet();
  activity = {
    inProgress: [
      item({
        id: "handoff-1",
        kind: "handoff",
        title: "Draft the wholesale reply",
        status: "running",
        stoppable: true,
      }),
      // Listed from the inbox under Needs input, so not here.
      item({
        id: "approval:mail-1",
        kind: "approval",
        title: "Approve gmail/GMAIL_SEND_EMAIL",
        status: "waiting for you",
        needsYou: true,
      }),
    ],
    scheduled: [],
    completed: [],
  };
  serving();
  const view = draw();
  const working = await view.findByRole("region", { name: "Working" });
  expect(working.textContent).toContain("Delegated task · Working on it");
  expect(working.textContent).not.toContain("Approve gmail");
  fireEvent.click(
    within(working).getByRole("button", {
      name: "Stop Draft the wholesale reply",
    }),
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/bots/openduet/activity/handoffs/stop",
      body: { id: "handoff-1" },
    }),
  );
});

test("a task whose conversation is running a turn reads Working, even before the server says so", async () => {
  quiet();
  tasks = [task({ id: "sam", status: "ready_for_review" })];
  channels = [conversation({ id: "sam-channel", taskId: "sam", busy: true })];
  serving();
  const view = draw();
  const working = await view.findByRole("region", { name: "Working" });
  expect(
    within(working).getByRole("link").querySelector("[data-status]")
      ?.textContent,
  ).toBe("Working · Just started");
});

test("search narrows Active by title", async () => {
  quiet();
  tasks = [
    task({ id: "rosa", title: "Reply to Rosa", status: "working" }),
    task({
      id: "sam",
      title: "Answer Sam about Friday",
      status: "ready_for_review",
    }),
  ];
  serving();
  const view = draw();
  await view.findByRole("region", { name: "Working" });
  fireEvent.click(view.getByRole("button", { name: "Search tasks" }));
  const field = view.getByRole("searchbox", { name: "Search tasks" });
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(field, "sam");
  expect(regionNames(view)).toEqual(["Ready for review"]);
  await user.clear(field);
  await user.type(field, "nobody");
  expect(regionNames(view)).toEqual([]);
  expect(view.getByText("Nothing matches “nobody”.")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Close search" }));
  expect(view.queryByRole("searchbox")).toBeNull();
  expect(regionNames(view)).toEqual(["Ready for review", "Working"]);
});

// ---------- Up next ----------

/** Draws Tasks with Up next showing. */
async function upNext() {
  window.localStorage.setItem(TASKS_VIEW_STORAGE_KEY, "up_next");
  const view = draw();
  await view.findByRole("tab", { name: "Up next", selected: true });
  return view;
}

test("Up next lists suggestions and asked tasks newest first, the asked ones tagged You asked", async () => {
  quiet();
  suggestions = [
    suggestion({
      id: "old",
      title: "Pay the booth balance",
      createdAt: ago(300),
    }),
    suggestion({
      id: "new",
      title: "Reopen the Shopify store",
      sourceApp: "Google Calendar",
      sourceLink: "https://calendar.google.com/event?eid=1",
      createdAt: ago(10),
    }),
    suggestion({
      id: "asked",
      runId: "asked:4f1",
      title: "Book the kiln service",
      detail: "",
      sourceApp: null,
      createdAt: ago(30),
    }),
    suggestion({
      id: "scout",
      agentId: "scout",
      title: "Check the kiln order",
      sourceApp: null,
      createdAt: ago(400),
    }),
  ];
  serving();
  const view = await upNext();
  const list = await view.findByRole("region", { name: "Up next" });
  await within(list).findByText("Reopen the Shopify store");
  const titles = within(list)
    .getAllByRole("listitem")
    .map((row) => row.querySelector("p")?.textContent);
  expect(titles).toEqual([
    "Reopen the Shopify store",
    "Book the kiln service",
    "Pay the booth balance",
    "Check the kiln order",
  ]);
  const rows = within(list).getAllByRole("listitem");
  expect(rows[1]?.textContent).toContain("You asked");
  expect(rows[0]?.textContent).not.toContain("You asked");
  expect(
    within(list)
      .getByRole("link", { name: "From Google Calendar" })
      .getAttribute("href"),
  ).toBe("https://calendar.google.com/event?eid=1");
  expect(rows[2]?.textContent).toContain("From Gmail");
  // Another Bot's says whose it is; the product's own Bot goes without saying.
  expect(rows[3]?.textContent).toContain("Scout");
  expect(rows[0]?.textContent).not.toContain("OpenDuet");
});

/** A channel as the drawer lists it, for the tags. */
const kilnChannel = {
  id: "c-kiln",
  name: "Kiln move",
  purpose: "Moving the studio's kiln by March.",
  icon: "home",
  colour: "green",
  dressed: true,
  archivedAt: null,
  agentIds: ["openduet"],
  lastMessageAt: null,
  createdAt: "2026-10-22T09:00:00Z",
};

test("a task asked for in a channel wears the channel's colour tag on its row; one from Everything wears none", async () => {
  quiet();
  duetChannels = [kilnChannel];
  tasks = [
    task({
      id: "movers",
      title: "Book the movers",
      status: "working",
      fromChannelId: "c-kiln",
    }),
    task({ id: "rosa", status: "working", fromChannelId: null }),
  ];
  serving();
  const view = draw();
  const group = await view.findByRole("region", { name: "Working" });
  const movers = (await within(group).findByText("Book the movers")).closest(
    "a",
  ) as HTMLElement;
  await waitFor(() =>
    expect(movers.querySelector("[data-channel-tag]")).toBeTruthy(),
  );
  const tag = movers.querySelector("[data-channel-tag]");
  expect(tag?.getAttribute("data-channel-tag")).toBe("green");
  expect(tag?.textContent).toBe("Kiln move");
  const rosa = within(group)
    .getByText("Draft a reply to Rosa about Oat Satin")
    .closest("a") as HTMLElement;
  expect(rosa.querySelector("[data-channel-tag]")).toBeNull();
});

test("an Up next card added in a channel wears its tag too", async () => {
  quiet();
  duetChannels = [kilnChannel];
  suggestions = [
    suggestion({
      id: "measure",
      runId: "asked:kiln",
      title: "Measure the new kiln bay",
      fromChannelId: "c-kiln",
    }),
    suggestion({ id: "plain", title: "Pay the booth balance" }),
  ];
  serving();
  const view = await upNext();
  const list = await view.findByRole("region", { name: "Up next" });
  await within(list).findByText("Measure the new kiln bay");
  const rows = within(list).getAllByRole("listitem");
  await waitFor(() =>
    expect(
      rows
        .map((row) => row.querySelector("[data-channel-tag]")?.textContent)
        .filter(Boolean),
    ).toEqual(["Kiln move"]),
  );
});

test("Start starts an Up next card as a task and Hide dismisses one", async () => {
  quiet();
  suggestions = [suggestion({ id: "s-1" })];
  serving();
  const view = await upNext();
  fireEvent.click(
    await view.findByRole("button", {
      name: "Start Reply to Rosa about the glaze",
    }),
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/proactive/suggestions/s-1/start",
      body: undefined,
    }),
  );
  expect(await view.findByText("Started. OpenDuet is on it.")).toBeTruthy();
  fireEvent.click(
    view.getByRole("button", { name: "Hide Reply to Rosa about the glaze" }),
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/proactive/suggestions/s-1/dismiss",
      body: undefined,
    }),
  );
});

/** A finger dragged across a card, from x=160 to x=160+distance. */
function swipe(target: Element, distance: number, pointerType = "touch") {
  const at = { pointerId: 7, pointerType, clientX: 160, clientY: 40 };
  fireEvent.pointerDown(target, at);
  fireEvent.pointerMove(target, { ...at, clientX: at.clientX + distance });
  fireEvent.pointerUp(target, { ...at, clientX: at.clientX + distance });
}
const flown = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));

test("an Up next card slides off: right starts it, left hides it, a short drag does neither", async () => {
  quiet();
  suggestions = [
    suggestion({ id: "s-1" }),
    suggestion({
      id: "s-2",
      title: "Pay the booth balance",
      createdAt: ago(90),
    }),
  ];
  serving();
  const view = await upNext();
  const first = await view.findByText("Reply to Rosa about the glaze");
  swipe(first, 40);
  swipe(first, -40);
  await flown();
  expect(sent).toEqual([]);
  swipe(first, 200);
  await flown();
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/proactive/suggestions/s-1/start",
      body: undefined,
    }),
  );
  // A mouse drags it too.
  swipe(view.getByText("Pay the booth balance"), -200, "mouse");
  await flown();
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/proactive/suggestions/s-2/dismiss",
      body: undefined,
    }),
  );
});

test("a swiped card's place closes as soon as it has flown, and it comes back with the reason if starting fails", async () => {
  quiet();
  suggestions = [
    suggestion({ id: "s-1" }),
    suggestion({
      id: "s-2",
      title: "Pay the booth balance",
      createdAt: ago(90),
    }),
  ];
  serving();
  // The start is held open, so what the list does before the answer is in can be seen.
  let refuse = () => {};
  const served = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/proactive/suggestions/s-1/start")
      return new Promise<Response>((resolve) => {
        refuse = () =>
          resolve(
            Response.json({ error: "Couldn't start that" }, { status: 500 }),
          );
      });
    return served(input, init);
  }) as unknown as typeof fetch;
  const view = await upNext();
  swipe(await view.findByText("Reply to Rosa about the glaze"), 200);
  await flown();
  await runMotionFrames(40);
  // Flown off and gone from the list while the answer is still on its way: the card under it has
  // its place, rather than a gap the size of a card waiting on the server.
  await waitFor(() =>
    expect(view.queryByText("Reply to Rosa about the glaze")).toBeNull(),
  );
  expect(view.getByText("Pay the booth balance")).toBeTruthy();

  refuse();
  // Refused, it is back in its place, with why on it.
  expect(await view.findByText("Reply to Rosa about the glaze")).toBeTruthy();
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't start that",
  );
});

test("empty, Up next asks what it can take off your plate, and Show me checks in now", async () => {
  quiet();
  serving();
  const view = await upNext();
  expect(
    await view.findByRole("heading", {
      name: "What can I take off your plate?",
    }),
  ).toBeTruthy();
  const apps = view.getByRole("list", { name: "What it checks" });
  expect(apps.textContent).toBe("GmailCalendar");
  fireEvent.click(view.getByRole("button", { name: "Show me" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/proactive/settings/research-1/run",
      body: undefined,
    }),
  );
  expect((await view.findByRole("status")).textContent).toBe("Looking…");
  expect(view.queryByRole("button", { name: "Show me" })).toBeNull();

  // The check-in runs and finds nothing new.
  settings = [
    research({ lastRunAt: new Date().toISOString(), lastStatus: "succeeded" }),
  ];
  await queryClient.invalidateQueries({ queryKey: ["proactive", "settings"] });
  expect(
    await view.findByText("Nothing new right now. I'll keep checking."),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Show me" })).toBeTruthy();
});

test("Show me stops looking once suggestions arrive, and lists them", async () => {
  quiet();
  serving();
  const view = await upNext();
  fireEvent.click(await view.findByRole("button", { name: "Show me" }));
  await view.findByText("Looking…");
  suggestions = [suggestion({ id: "s-1" })];
  await queryClient.invalidateQueries({
    queryKey: ["proactive", "suggestions"],
  });
  expect(await view.findByText("Reply to Rosa about the glaze")).toBeTruthy();
  expect(view.queryByText("Looking…")).toBeNull();
});

test("with research off, Show me turns it on in Chat's conversation", async () => {
  quiet();
  settings = [];
  channels = [
    conversation({
      id: "group",
      agentIds: ["openduet", "scout"],
      lastMessageAt: "2026-10-22T11:00:00Z",
    }),
    conversation({ id: "chat-1" }),
  ];
  serving();
  const view = await upNext();
  const show = await view.findByRole("button", { name: "Show me" });
  await waitFor(() => expect(show.hasAttribute("disabled")).toBe(false));
  fireEvent.click(show);
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/proactive/settings",
      body: {
        agentId: "openduet",
        channelId: "chat-1",
        focus: expect.stringContaining("mail and calendar"),
        intervalMinutes: 60,
      },
    }),
  );
  expect(sent.some((call) => call.path === "/api/channels")).toBe(false);
  expect(await view.findByText("Looking…")).toBeTruthy();
});

test("research the person turned off is turned back on as it was by Show me", async () => {
  quiet();
  settings = [research({ enabled: false, focus: "Invoices" })];
  serving();
  const view = await upNext();
  const show = await view.findByRole("button", { name: "Show me" });
  await waitFor(() => expect(show.hasAttribute("disabled")).toBe(false));
  fireEvent.click(show);
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "PATCH",
      path: "/api/proactive/settings/research-1",
      body: { enabled: true },
    }),
  );
  expect(sent.some((call) => call.method === "POST")).toBe(false);
});

test("with no conversation yet, turning research on starts one first", async () => {
  quiet();
  settings = [];
  channels = [];
  serving();
  const view = await upNext();
  const show = await view.findByRole("button", { name: "Show me" });
  await waitFor(() => expect(show.hasAttribute("disabled")).toBe(false));
  fireEvent.click(show);
  await waitFor(() =>
    expect(sent.map((call) => call.path)).toEqual([
      "/api/channels",
      "/api/proactive/settings",
    ]),
  );
  expect(sent[1]?.body).toMatchObject({
    agentId: "openduet",
    channelId: "chat-new",
  });
});

test("with research off and something up next, one card offers to turn it on", async () => {
  quiet();
  settings = [];
  channels = [conversation({ id: "chat-1" })];
  suggestions = [suggestion({ id: "asked", runId: "asked:1" })];
  serving();
  const view = await upNext();
  expect(await view.findByText("Let OpenDuet suggest tasks")).toBeTruthy();
  const turnOn = view.getByRole("button", { name: "Turn on" });
  await waitFor(() => expect(turnOn.hasAttribute("disabled")).toBe(false));
  fireEvent.click(turnOn);
  await waitFor(() =>
    expect(sent).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/api/proactive/settings",
      }),
    ),
  );
});

test("Coming up lists lined-up work under Up next, with Cancel", async () => {
  quiet();
  suggestions = [suggestion({ id: "s-1" })];
  activity = {
    inProgress: [],
    scheduled: [
      item({ id: "follow-1", title: "Check Rosa replied", cancellable: true }),
    ],
    completed: [],
  };
  serving();
  const view = await upNext();
  const upcoming = await view.findByRole("region", { name: "Coming up" });
  fireEvent.click(
    within(upcoming).getByRole("button", { name: "Cancel Check Rosa replied" }),
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/bots/openduet/follow-ups/cancel",
      body: { id: "follow-1" },
    }),
  );
});

test("search narrows Up next by title", async () => {
  quiet();
  suggestions = [
    suggestion({ id: "a", title: "Pay the booth balance" }),
    suggestion({ id: "b", title: "Reply to Rosa about the glaze" }),
  ];
  serving();
  const view = await upNext();
  await view.findByText("Pay the booth balance");
  fireEvent.click(view.getByRole("button", { name: "Search tasks" }));
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("searchbox", { name: "Search tasks" }),
    "ROSA glaze",
  );
  expect(view.queryByText("Pay the booth balance")).toBeNull();
  expect(view.getByText("Reply to Rosa about the glaze")).toBeTruthy();
});

// ---------- the + ----------

test("+ asks what OpenDuet should do, and Start now starts it as a task and shows Active", async () => {
  quiet();
  serving();
  const view = await upNext();
  fireEvent.click(await view.findByRole("button", { name: "Add a task" }));
  const sheet = await view.findByRole("dialog");
  expect(
    within(sheet).getByRole("heading", { name: "What should OpenDuet do?" }),
  ).toBeTruthy();
  const start = within(sheet).getByRole("button", { name: "Start now" });
  expect(start.hasAttribute("disabled")).toBe(true);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    within(sheet).getByRole("textbox", { name: "What should OpenDuet do?" }),
    "  Find a time for coffee with Sam next week  ",
  );
  await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
  fireEvent.click(start);
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/openduet/tasks",
      body: {
        botId: "openduet",
        instruction: "Find a time for coffee with Sam next week",
      },
    }),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(
    view.getByRole("tab", { name: "Active" }).getAttribute("aria-selected"),
  ).toBe("true");
});

test("+ Save for Up next saves it as an asked card and shows Up next", async () => {
  quiet();
  serving();
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "Add a task" }));
  const sheet = await view.findByRole("dialog");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    within(sheet).getByRole("textbox", { name: "What should OpenDuet do?" }),
    "Chase the booth deposit",
  );
  const save = within(sheet).getByRole("button", { name: "Save for Up next" });
  await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
  fireEvent.click(save);
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/openduet/tasks/up-next",
      body: { botId: "openduet", instruction: "Chase the booth deposit" },
    }),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(
    view.getByRole("tab", { name: "Up next" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(sent.some((call) => call.path === "/api/openduet/tasks")).toBe(false);
});
