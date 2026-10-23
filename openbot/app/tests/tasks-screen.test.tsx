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
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TasksScreen } from "@/components/shell/tasks-screen";
import { agentKeys } from "@/lib/agents/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The Tasks tab, top to bottom: what is waiting on the person, answered where it is shown; what
 * their Bots suggest, started or hidden from the row; what the product's own Bot is working on and
 * has lined up; and what it has done. Empty sections are left out, except Suggested.
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

let inbox: Record<string, unknown> = {};
let suggestions: unknown[] = [];
let settings: unknown[] = [];
let activity: Record<string, unknown> = {};
let channels: unknown[] = [];
let tasks: unknown[] = [];
const sent: { method: string; path: string; body: unknown }[] = [];
function serving() {
  sent.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ method: init.method, path: url, body });
      const again = /^\/api\/openduet\/tasks\/([^/]+)\/again$/.exec(url);
      if (again) {
        tasks = (tasks as { id: string }[]).map((row) =>
          row.id === again[1]
            ? { ...row, status: "working", failure: null }
            : row,
        );
        return Response.json({
          task: (tasks as { id: string }[]).find((row) => row.id === again[1]),
        });
      }
      if (url === "/api/channels")
        return Response.json({ channel: newChannel }, { status: 201 });
      return Response.json({ ok: true });
    }
    if (url === "/api/approvals") return Response.json(inbox);
    if (url === "/api/proactive/suggestions")
      return Response.json({ suggestions });
    if (url === "/api/proactive/settings") return Response.json({ settings });
    if (url === "/api/bots/openduet/activity")
      return Response.json({ activity });
    if (url === "/api/channels")
      return Response.json({ channels, nextCursor: null });
    if (url === "/api/openduet/tasks") return Response.json({ tasks });
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
}

const research = (overrides: Record<string, unknown> = {}) => ({
  id: "research-1",
  agentId: "openduet",
  channelId: "chat-1",
  focus: "",
  enabled: true,
  intervalMinutes: 240,
  nextRunAt: "2026-10-22T19:00:00Z",
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
  ...overrides,
});

const suggestion = (overrides: Record<string, unknown>) => ({
  id: "s",
  agentId: "openduet",
  title: "Reply to Rosa about the glaze",
  detail: "Rosa asked whether the satin glaze can replace the gloss one.",
  sourceApp: "Gmail",
  sourceLink: null,
  createdAt: "2026-10-22T03:00:00Z",
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
  at: "2026-10-22T14:59:00Z",
  channelId: null,
  needsYou: false,
  stoppable: false,
  cancellable: false,
  ...overrides,
});

const email = {
  id: "mail-1",
  status: "pending",
  createdAt: "2026-10-21T14:59:00Z",
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
  },
};

test("with nothing waiting or under way, only Suggested is shown, and it says so", async () => {
  quiet();
  serving();
  const view = draw();
  expect(await view.findByText("Nothing to suggest right now.")).toBeTruthy();
  expect(view.getByRole("region", { name: "Suggested" })).toBeTruthy();
  expect(view.queryByRole("region", { name: "Your tasks" })).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByRole("region", { name: "Needs you" })).toBeNull();
  expect(view.queryByRole("region", { name: "Working on" })).toBeNull();
  expect(view.queryByRole("region", { name: "Coming up" })).toBeNull();
});

test("a decided action is not waiting, so Needs you is left out", async () => {
  quiet();
  inbox = {
    requests: [{ ...email, status: "completed", decision: "allow_once" }],
    questions: [],
  };
  serving();
  const view = draw();
  await view.findByText("Nothing to suggest right now.");
  expect(view.queryByRole("region", { name: "Needs you" })).toBeNull();
});

test("a waiting email is drawn as the film's card under Needs you and answered from it", async () => {
  quiet();
  inbox = { requests: [email], questions: [] };
  serving();
  const view = draw();
  const needsYou = await view.findByRole("region", { name: "Needs you" });
  const card = within(needsYou).getByRole("region", {
    name: "Waiting for your approval",
  });
  expect(card.textContent).toContain("Send email");
  expect(card.textContent).toContain("ana@hearth.example");
  expect(card.textContent).toContain("Ship date for your mugs");
  expect(card.textContent).toContain("could we ship on Tuesday");
  expect(view.getByRole("button", { name: "Refuse" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Always allow" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/approvals/mail-1/decision",
      body: { decision: "allow_once" },
    }),
  );
});

test("Refuse sends a refusal", async () => {
  quiet();
  inbox = { requests: [email], questions: [] };
  serving();
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "Refuse" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/approvals/mail-1/decision",
      body: { decision: "deny" },
    }),
  );
});

test("a question is answered in place", async () => {
  quiet();
  inbox = {
    requests: [],
    questions: [
      {
        id: "q-1",
        botId: "openduet",
        threadId: "thread",
        question: "Which deck should I review?",
        createdAt: "2026-10-21T10:00:00Z",
      },
    ],
  };
  serving();
  const view = draw();
  expect(await view.findByText("OpenDuet asks")).toBeTruthy();
  expect(view.getByText("Which deck should I review?")).toBeTruthy();
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
});

test("suggestions are listed newest first, with where each was read and whose it is", async () => {
  quiet();
  suggestions = [
    suggestion({ id: "old", title: "Pay the booth balance" }),
    suggestion({
      id: "new",
      title: "Reopen the Shopify store",
      sourceApp: "Google Calendar",
      sourceLink: "https://calendar.google.com/event?eid=1",
      createdAt: "2026-10-22T04:00:00Z",
    }),
    suggestion({
      id: "scout",
      agentId: "scout",
      title: "Check the kiln order",
      sourceApp: null,
      createdAt: "2026-10-22T02:00:00Z",
    }),
  ];
  serving();
  const view = draw();
  const card = await view.findByRole("region", { name: "Suggested" });
  await within(card).findByText("Reopen the Shopify store");
  const titles = within(card)
    .getAllByRole("listitem")
    .map((row) => row.querySelector("p")?.textContent);
  expect(titles).toEqual([
    "Reopen the Shopify store",
    "Pay the booth balance",
    "Check the kiln order",
  ]);
  expect(
    within(card)
      .getByRole("link", { name: "From Google Calendar" })
      .getAttribute("href"),
  ).toBe("https://calendar.google.com/event?eid=1");
  expect(within(card).getByText("From Gmail")).toBeTruthy();
  // Another Bot's suggestion says whose it is; the product's own Bot goes without saying.
  expect(within(card).getByText("Scout")).toBeTruthy();
  expect(within(card).queryByText("OpenDuet")).toBeNull();
});

test("Start starts a suggestion and Hide dismisses one", async () => {
  quiet();
  suggestions = [suggestion({ id: "s-1" })];
  serving();
  const view = draw();
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

/** A finger dragged across a suggestion's text, from x=20 to x=20+distance. */
function swipe(target: Element, distance: number, pointerType = "touch") {
  fireEvent.pointerDown(target, { pointerId: 7, pointerType, clientX: 20 });
  fireEvent.pointerMove(target, {
    pointerId: 7,
    pointerType,
    clientX: 20 + distance,
  });
  fireEvent.pointerUp(target, {
    pointerId: 7,
    pointerType,
    clientX: 20 + distance,
  });
}

test("a touch swipe to the right starts a suggestion; a short one, or a mouse drag, does not", async () => {
  quiet();
  suggestions = [suggestion({ id: "s-1" })];
  serving();
  const view = draw();
  const text = await view.findByText("Reply to Rosa about the glaze");
  swipe(text, 40);
  swipe(text, 200, "mouse");
  await settleReactWork();
  expect(sent).toEqual([]);
  swipe(text, 200);
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/proactive/suggestions/s-1/start",
      body: undefined,
    }),
  );
});

test("with research off for OpenDuet, one card offers to turn it on in Chat's conversation", async () => {
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
  const view = draw();
  expect(await view.findByText("Let OpenDuet suggest tasks")).toBeTruthy();
  expect(view.getByText(/checks your connected apps every hour/)).toBeTruthy();
  expect(view.queryByText("Nothing to suggest right now.")).toBeNull();
  const turnOn = view.getByRole("button", { name: "Turn on" });
  await waitFor(() => expect(turnOn.hasAttribute("disabled")).toBe(false));
  fireEvent.click(turnOn);
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/proactive/settings",
      body: {
        agentId: "openduet",
        channelId: "chat-1",
        focus: expect.stringContaining("mail and calendar"),
        // A check-in every hour: each reads only what is new, and most say nothing.
        intervalMinutes: 60,
      },
    }),
  );
  expect(sent.some((call) => call.path === "/api/channels")).toBe(false);
});

test("research the person turned off is turned back on as it was", async () => {
  quiet();
  settings = [research({ enabled: false, focus: "Invoices" })];
  serving();
  const view = draw();
  const turnOn = await view.findByRole("button", { name: "Turn on" });
  await waitFor(() => expect(turnOn.hasAttribute("disabled")).toBe(false));
  fireEvent.click(turnOn);
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
  const view = draw();
  const turnOn = await view.findByRole("button", { name: "Turn on" });
  await waitFor(() => expect(turnOn.hasAttribute("disabled")).toBe(false));
  fireEvent.click(turnOn);
  await waitFor(() =>
    expect(sent.map((call) => call.path)).toEqual([
      "/api/channels",
      "/api/proactive/settings",
    ]),
  );
  expect(sent[0]?.body).toEqual({ agentIds: ["openduet"] });
  expect(sent[1]?.body).toMatchObject({
    agentId: "openduet",
    channelId: "chat-new",
  });
});

test("Working on and Coming up list OpenDuet's work, with Stop and Cancel, and open its conversation", async () => {
  quiet();
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
      // Already under Needs you, so not listed twice.
      item({
        id: "approval:mail-1",
        kind: "approval",
        title: "Approve gmail/GMAIL_SEND_EMAIL",
        status: "waiting for you",
        needsYou: true,
      }),
    ],
    scheduled: [
      item({
        id: "follow-1",
        title: "Check Rosa replied",
        cancellable: true,
      }),
    ],
    completed: [item({ id: "done-1", title: "Sorted the inbox" })],
  };
  serving();
  const view = draw();
  const working = await view.findByRole("region", { name: "Working on" });
  expect(working.textContent).toContain("Draft the wholesale reply");
  expect(working.textContent).toContain("Delegated task · Working on it");
  expect(working.textContent).not.toContain("Approve gmail");
  expect(
    within(working)
      .getByRole("link", { name: /Draft the wholesale reply/ })
      .getAttribute("href"),
  ).toBe("/channel/chat-1");
  const upcoming = view.getByRole("region", { name: "Coming up" });
  expect(upcoming.textContent).toContain("Check Rosa replied");
  // Finished work is under Done, not Working on.
  expect(working.textContent).not.toContain("Sorted the inbox");
  expect(view.getByRole("region", { name: "Done" }).textContent).toContain(
    "Sorted the inbox",
  );

  fireEvent.click(
    within(working).getByRole("button", {
      name: "Stop Draft the wholesale reply",
    }),
  );
  fireEvent.click(
    within(upcoming).getByRole("button", { name: "Cancel Check Rosa replied" }),
  );
  await waitFor(() => {
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/bots/openduet/activity/handoffs/stop",
      body: { id: "handoff-1" },
    });
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/bots/openduet/follow-ups/cancel",
      body: { id: "follow-1" },
    });
  });
});

test("Done lists finished work and answered actions at the foot, newest first, with nothing to press", async () => {
  quiet();
  activity = {
    inProgress: [
      item({
        id: "now",
        kind: "handoff",
        title: "Draft the reply",
        status: "running",
        stoppable: true,
      }),
    ],
    scheduled: [],
    completed: [
      item({
        id: "done",
        title: "Review the launch deck",
        status: "done",
        at: "2026-10-21T14:59:00Z",
      }),
      item({
        id: "broke",
        kind: "routine",
        title: "Tidy inbox",
        status: "failed",
        at: "2026-10-21T16:00:00Z",
      }),
    ],
  };
  inbox = {
    requests: [
      {
        id: "r",
        status: "completed",
        createdAt: "2026-10-21T14:58:00Z",
        decidedAt: "2026-10-21T15:30:00Z",
        decision: "allow_once",
        action: {
          botId: "openduet",
          toolRef: "gmail/GMAIL_SEND_EMAIL",
          effect: "write",
          scope: "ana@example.com",
          threadId: "t",
          args: {},
          target: {},
          policy: { behaviour: "ask", source: "rule", reason: "Asked." },
        },
      },
    ],
    questions: [],
  };
  serving();
  const view = draw();
  const done = await view.findByRole("region", { name: "Done" });
  const text = done.textContent ?? "";
  expect(text).toContain("Follow-up · Done");
  expect(text).toContain("Didn't finish");
  expect(text).toContain("Allowed once by you");
  // Newest first: the failed routine, then the allowed send, then the review.
  const order = ["Tidy inbox", "Send email", "Review the launch deck"].map(
    (title) => text.indexOf(title),
  );
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // Read-only, and the work under way is not in it.
  expect(within(done).queryAllByRole("button")).toHaveLength(0);
  expect(text).not.toContain("Draft the reply");
  // At the foot of the screen, after Working on.
  const regions = view
    .getAllByRole("region")
    .map((region) => region.getAttribute("aria-label"));
  expect(regions.at(-1)).toBe("Done");
  expect(regions.indexOf("Working on")).toBeLessThan(regions.indexOf("Done"));
});

test("with nothing finished, Done is left out", async () => {
  quiet();
  activity = {
    inProgress: [item({ id: "now", status: "running" })],
    scheduled: [],
    completed: [],
  };
  serving();
  const view = draw();
  await view.findByRole("region", { name: "Working on" });
  expect(view.queryByRole("region", { name: "Done" })).toBeNull();
});

const task = (overrides: Record<string, unknown>) => ({
  id: "task",
  botId: "openduet",
  channelId: "task-channel",
  title: "Draft a reply to Rosa about Oat Satin",
  why: null,
  origin: "asked",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  status: "working",
  failure: null,
  failedAt: null,
  resolvedAt: null,
  createdAt: "2026-10-22T10:00:00Z",
  updatedAt: "2026-10-22T10:00:00Z",
  ...overrides,
});

test("Your tasks lists the open ones with where each stands and opens each; a done one moves to Done", async () => {
  quiet();
  tasks = [
    task({ id: "rosa", status: "working" }),
    task({
      id: "hearth",
      channelId: "hearth-channel",
      title: "Prepare notes for the Hearth & Co visit",
      status: "needs_input",
    }),
    task({
      id: "sam",
      channelId: "sam-channel",
      title: "Answer Sam about Friday off",
      status: "ready_for_review",
    }),
    task({
      id: "invoice",
      channelId: "invoice-channel",
      title: "Pay the kiln repair invoice",
      status: "resolved",
      resolvedAt: "2026-10-22T11:00:00Z",
    }),
  ];
  serving();
  const view = draw();
  const yours = await view.findByRole("region", { name: "Your tasks" });
  const rows = within(yours).getAllByRole("link");
  expect(rows.map((row) => row.getAttribute("href"))).toEqual([
    "/tasks/rosa",
    "/tasks/hearth",
    "/tasks/sam",
  ]);
  expect(
    rows.map((row) => row.querySelector("[data-status]")?.textContent),
  ).toEqual(["Working", "Needs input", "Ready for review"]);
  expect(yours.textContent).not.toContain("Pay the kiln repair invoice");
  // Right under what waits on the person, above the suggestions.
  const regions = view
    .getAllByRole("region")
    .map((region) => region.getAttribute("aria-label"));
  expect(regions.indexOf("Your tasks")).toBeLessThan(
    regions.indexOf("Suggested"),
  );

  const done = await view.findByRole("region", { name: "Done" });
  const doneTask = within(done).getByRole("link", {
    name: /Pay the kiln repair invoice/,
  });
  expect(doneTask.getAttribute("href")).toBe("/tasks/invoice");
  expect(doneTask.textContent).toContain("Task · Done");
});

test("a task whose conversation is running a turn reads Working, even before the server says so", async () => {
  quiet();
  tasks = [task({ id: "sam", status: "ready_for_review" })];
  channels = [conversation({ id: "task-channel", taskId: "sam", busy: true })];
  serving();
  const view = draw();
  const yours = await view.findByRole("region", { name: "Your tasks" });
  await waitFor(() =>
    expect(yours.querySelector("[data-status]")?.textContent).toBe("Working"),
  );
});

test("a task that couldn't finish says why on its row, and Try again runs it once more without opening it", async () => {
  quiet();
  tasks = [
    task({
      id: "rosa",
      status: "failed",
      failure: "the run took longer than 5 minutes",
    }),
  ];
  serving();
  const view = draw();
  const yours = await view.findByRole("region", { name: "Your tasks" });
  const row = within(yours).getByRole("link", {
    name: /Draft a reply to Rosa/,
  });
  expect(row.querySelector("[data-status]")?.textContent).toBe("Failed");
  expect(row.textContent).toContain(
    "Couldn't finish: the run took longer than 5 minutes.",
  );
  expect(row.textContent).not.toContain("Ready for review");
  // Outside the link, so pressing it never opens the task.
  const again = within(yours).getByRole("button", {
    name: "Try this task again",
  });
  expect(again.textContent).toBe("Try again");
  expect(row.contains(again)).toBe(false);

  fireEvent.click(again);
  await waitFor(() =>
    expect(sent.map((request) => request.path)).toContain(
      "/api/openduet/tasks/rosa/again",
    ),
  );
  await waitFor(() =>
    expect(yours.querySelector("[data-status]")?.textContent).toBe("Working"),
  );
  expect(
    within(yours).queryByRole("button", { name: "Try this task again" }),
  ).toBeNull();
});
