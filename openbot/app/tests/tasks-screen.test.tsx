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
import { TasksScreen } from "@/components/shell/tasks-screen";
import { agentKeys } from "@/lib/agents/queries";
import { proactiveKeys } from "@/lib/proactive";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The Tasks tab, top to bottom: what the person started that is ready for them to read; what is
 * waiting on the person, answered where it is shown; what the product's own Bot is working on and
 * has lined up, including what the person started; what their Bots suggest, started or hidden from
 * the row; and what it has done. Empty sections are left out, except Suggested.
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
let started: unknown[] = [];
let olderResolved = 0;
/** The last read of what was started, with its query, so a test can see what was asked for. */
let startedRead = "";
let settings: unknown[] = [];
let activity: Record<string, unknown> = {};
let channels: unknown[] = [];
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
      return Response.json({ ok: true });
    }
    if (url === "/api/approvals") return Response.json(inbox);
    if (url === "/api/proactive/suggestions")
      return Response.json({ suggestions });
    if (url.startsWith("/api/proactive/started?")) {
      startedRead = url;
      return Response.json({ started, olderResolved });
    }
    if (url === "/api/proactive/settings") return Response.json({ settings });
    if (url === "/api/bots/openduet/activity")
      return Response.json({ activity });
    if (url === "/api/channels")
      return Response.json({ channels, nextCursor: null });
    return Response.json({});
  }) as unknown as typeof fetch;
}

/** The router the last `draw` made, so a test can read where a link went. */
let router: ReturnType<typeof createRouter>;
function draw() {
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "openduet", name: "OpenDuet" },
    { id: "scout", name: "Scout" },
  ]);
  router = createRouter({
    routeTree: createRootRoute({ component: TasksScreen }),
    history: createMemoryHistory({ initialEntries: ["/tasks"] }),
  }) as unknown as ReturnType<typeof createRouter>;
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
  started = [];
  olderResolved = 0;
  settings = [research()];
  activity = { inProgress: [], scheduled: [], completed: [] };
  channels = [];
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

/** A suggestion the person started, as `/api/proactive/started` reads it back. */
const startedItem = (overrides: Record<string, unknown> = {}) => ({
  id: "s-1",
  agentId: "openduet",
  title: "Reply to Rosa about the glaze",
  detail: "Rosa asked whether the satin glaze can replace the gloss one.",
  sourceApp: "Gmail",
  sourceLink: null,
  startedAt: "2026-10-22T05:00:00Z",
  state: "working",
  next: "Just started",
  waitingOn: null,
  resolvedAt: null,
  at: "2026-10-22T05:00:00Z",
  channelId: "research-chat",
  ...overrides,
});

/** Every `scrollIntoView` asked for, by the element's started-row id or message id. */
const scrolled: string[] = [];
beforeAll(() => {
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(
      this.getAttribute("data-started-row") ??
        this.getAttribute("data-message-id") ??
        "",
    );
  };
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
  expect(view.queryByRole("region", { name: "Needs input" })).toBeNull();
  expect(view.queryByRole("region", { name: "Working" })).toBeNull();
  expect(view.queryByRole("region", { name: "Coming up" })).toBeNull();
  expect(view.queryByRole("region", { name: "Resolved" })).toBeNull();
});

test("a decided action is not waiting, so Needs input is left out", async () => {
  quiet();
  inbox = {
    requests: [{ ...email, status: "completed", decision: "allow_once" }],
    questions: [],
  };
  serving();
  const view = draw();
  await view.findByText("Nothing to suggest right now.");
  expect(view.queryByRole("region", { name: "Needs input" })).toBeNull();
});

test("a waiting email is drawn as the film's card under Needs input and answered from it", async () => {
  quiet();
  inbox = { requests: [email], questions: [] };
  serving();
  const view = draw();
  const needsYou = await view.findByRole("region", { name: "Needs input" });
  expect(within(needsYou).getAllByRole("heading")[0]?.textContent).toBe(
    "Needs input 1",
  );
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

test("Start says Started above the tab bar, out of the list, and brings the new task into view under Working", async () => {
  quiet();
  suggestions = [suggestion({ id: "s-1" })];
  serving();
  scrolled.length = 0;
  const view = draw();
  fireEvent.click(
    await view.findByRole("button", {
      name: "Start Reply to Rosa about the glaze",
    }),
  );
  // What the server holds once it is started: no longer suggested, queued for the Bot.
  const now = new Date().toISOString();
  suggestions = [];
  started = [startedItem({ id: "s-1", startedAt: now, at: now })];
  const status = await view.findByRole("status");
  expect(status.textContent).toBe("Started. OpenDuet is on it.");
  // Not at the foot of Suggested, where the tab bar covers it: docked over the screen, above the bar.
  const list = view.getByRole("heading", { name: "Tasks" }).parentElement
    ?.parentElement as HTMLElement;
  expect(list.contains(status)).toBe(false);
  expect(status.closest("[data-dock]")?.className).toContain(
    "--duet-tab-space",
  );

  const working = await view.findByRole("region", { name: "Working" });
  expect(within(working).getByRole("heading").textContent).toBe("Working 1");
  expect(working.textContent).toContain("Reply to Rosa about the glaze");
  expect(working.textContent).toContain("Working · Just started");
  // The new row is scrolled into view, wherever the list was.
  await waitFor(() => expect(scrolled).toContain("s-1"));
  await waitFor(() =>
    expect(
      within(view.getByRole("region", { name: "Suggested" })).queryByText(
        "Reply to Rosa about the glaze",
      ),
    ).toBeNull(),
  );
});

test("started work moves from Working to Ready for review, with its reply's last sentence as the next step", async () => {
  quiet();
  started = [startedItem({ next: "Just started" })];
  serving();
  const view = draw();
  const working = await view.findByRole("region", { name: "Working" });
  expect(working.textContent).toContain("Working · Just started");
  expect(view.queryByRole("region", { name: "Ready for review" })).toBeNull();

  started = [
    startedItem({
      state: "ready_for_review",
      next: "The draft is in your conversation.",
      at: "2026-10-22T05:02:00Z",
    }),
  ];
  await act(() =>
    queryClient.invalidateQueries({ queryKey: proactiveKeys.started }),
  );
  const ready = await view.findByRole("region", { name: "Ready for review" });
  expect(within(ready).getByRole("heading").textContent).toBe(
    "Ready for review 1",
  );
  expect(ready.textContent).toContain(
    "Ready for review · The draft is in your conversation.",
  );
  expect(view.queryByRole("region", { name: "Working" })).toBeNull();
});

test("a Ready for review row opens its conversation at its own message, not at the end", async () => {
  quiet();
  started = [
    startedItem({
      id: "s-7",
      state: "ready_for_review",
      next: "The draft is in your conversation.",
    }),
  ];
  serving();
  const view = draw();
  const ready = await view.findByRole("region", { name: "Ready for review" });
  const link = within(ready).getByRole("link", {
    name: /Reply to Rosa about the glaze/,
  });
  expect(link.getAttribute("href")).toBe("/channel/research-chat");
  fireEvent.click(link);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/research-chat"),
  );
  expect(
    (router.state.location.state as unknown as Record<string, unknown>)
      .focusMessage,
  ).toBe("suggestion-s-7");
});

test("a run that ended on a question needs input: amber, the question as its next step, counted once with what it waits on", async () => {
  quiet();
  inbox = { requests: [email], questions: [] };
  started = [
    startedItem({
      id: "s-1",
      state: "needs_input",
      next: null,
      waitingOn: { kind: "approval", id: "mail-1" },
    }),
    startedItem({
      id: "s-2",
      title: "Sign the lease",
      state: "needs_input",
      next: "Should I ask Greenway for an extension?",
    }),
  ];
  serving();
  const view = draw();
  const needs = await view.findByRole("region", { name: "Needs input" });
  // Two tasks; the email one of them waits on is not counted again.
  expect(within(needs).getAllByRole("heading")[0]?.textContent).toBe(
    "Needs input 2",
  );
  expect(needs.textContent).toContain("Needs input · Allow it to send email?");
  expect(needs.textContent).toContain(
    "Needs input · Should I ask Greenway for an extension?",
  );
  expect(
    within(needs).getAllByRole("region", { name: "Waiting for your approval" }),
  ).toHaveLength(1);
  expect(view.queryByRole("region", { name: "Ready for review" })).toBeNull();
});

test("a failed run is never Ready for review: Failed, in plain words, under Needs input, and Try again runs it again", async () => {
  quiet();
  started = [
    startedItem({
      state: "failed",
      next: "it ran out of time",
      at: "2026-10-22T05:03:00Z",
    }),
  ];
  serving();
  const view = draw();
  const needs = await view.findByRole("region", { name: "Needs input" });
  expect(needs.textContent).toContain(
    "Failed · Couldn't finish: it ran out of time.",
  );
  expect(needs.textContent).not.toContain("stopped after");
  expect(view.queryByRole("region", { name: "Ready for review" })).toBeNull();
  expect(view.queryByRole("region", { name: "Working" })).toBeNull();
  fireEvent.click(
    within(needs).getByRole("button", {
      name: "Try again: Reply to Rosa about the glaze",
    }),
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/proactive/started/s-1/retry",
      body: undefined,
    }),
  );
});

test("checking a task off fills its box, then moves it to the folded Resolved, where it can be put back", async () => {
  quiet();
  started = [
    startedItem({
      state: "ready_for_review",
      next: "The draft is in your conversation.",
    }),
  ];
  serving();
  const view = draw();
  const ready = await view.findByRole("region", { name: "Ready for review" });
  const box = within(ready).getByRole("checkbox", {
    name: "Reply to Rosa about the glaze",
  }) as HTMLInputElement;
  expect(box.checked).toBe(false);
  // Checked off on the server once the request lands.
  started = [
    startedItem({
      state: "ready_for_review",
      next: "The draft is in your conversation.",
      resolvedAt: "2026-10-22T05:10:00Z",
      at: "2026-10-22T05:10:00Z",
    }),
  ];
  fireEvent.click(box);
  expect(box.checked).toBe(true);
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/proactive/started/s-1/resolve",
      body: undefined,
    }),
  );
  await waitFor(() =>
    expect(view.queryByRole("region", { name: "Ready for review" })).toBeNull(),
  );
  // Folded: the heading alone, no count, until it is opened.
  const resolved = view.getByRole("region", { name: "Resolved" });
  const fold = within(resolved).getByRole("button", { name: "Resolved" });
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(resolved.textContent).not.toContain("Reply to Rosa");
  fireEvent.click(fold);
  const again = within(resolved).getByRole("checkbox", {
    name: "Reply to Rosa about the glaze",
  }) as HTMLInputElement;
  expect(again.checked).toBe(true);
  fireEvent.click(again);
  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/proactive/started/s-1/reopen",
      body: undefined,
    }),
  );
});

test("older resolved tasks are paged in with Show more, never dropped", async () => {
  quiet();
  started = [
    startedItem({
      state: "ready_for_review",
      resolvedAt: "2026-10-22T05:10:00Z",
    }),
  ];
  olderResolved = 3;
  serving();
  const view = draw();
  const resolved = await view.findByRole("region", { name: "Resolved" });
  expect(startedRead).toBe("/api/proactive/started?resolved=20");
  fireEvent.click(within(resolved).getByRole("button", { name: "Resolved" }));
  fireEvent.click(
    within(resolved).getByRole("button", {
      name: "Show 3 more resolved tasks",
    }),
  );
  await waitFor(() =>
    expect(startedRead).toBe("/api/proactive/started?resolved=40"),
  );
});

test("Ready for review leads, then Needs input and Working, with Suggested and the folded Resolved after them", async () => {
  quiet();
  inbox = { requests: [email], questions: [] };
  suggestions = [suggestion({ id: "s-2", title: "Pay the booth balance" })];
  started = [
    startedItem({ id: "s-1", state: "ready_for_review", next: "Done." }),
    startedItem({ id: "s-3", title: "Sign the lease" }),
    startedItem({
      id: "s-4",
      title: "Pay ParcelGo",
      state: "ready_for_review",
      resolvedAt: "2026-10-22T05:10:00Z",
    }),
  ];
  serving();
  const view = draw();
  await view.findByRole("region", { name: "Ready for review" });
  await view.findByText("Pay the booth balance");
  await view.findByRole("region", { name: "Resolved" });
  const sections = [
    "Ready for review",
    "Needs input",
    "Working",
    "Suggested",
    "Resolved",
  ];
  const regions = view
    .getAllByRole("region")
    .map((region) => region.getAttribute("aria-label") ?? "")
    .filter((label) => sections.includes(label));
  expect(regions).toEqual(sections);
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
        intervalMinutes: 240,
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

test("Working and Coming up list OpenDuet's work, with Stop and Cancel, and open its conversation", async () => {
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
      // Already under Needs input, so not listed twice.
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
  const working = await view.findByRole("region", { name: "Working" });
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
  // Finished work is under the folded Resolved, not Working.
  expect(working.textContent).not.toContain("Sorted the inbox");
  const resolved = view.getByRole("region", { name: "Resolved" });
  fireEvent.click(within(resolved).getByRole("button", { name: "Resolved" }));
  expect(resolved.textContent).toContain("Sorted the inbox");

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

test("Resolved holds finished work at the foot, folded, newest first, with nothing to press and no approval receipts", async () => {
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
  const done = await view.findByRole("region", { name: "Resolved" });
  const fold = within(done).getByRole("button", { name: "Resolved" });
  expect(done.textContent).toBe("Resolved");
  fireEvent.click(fold);
  const text = done.textContent ?? "";
  expect(text).toContain("Follow-up · Done");
  expect(text).toContain("Didn't finish");
  // An answered action is a receipt, kept with its conversation, not a piece of finished work.
  expect(text).not.toContain("Allowed once by you");
  expect(text).not.toContain("Send email");
  // Newest first: the failed routine, then the review.
  const order = ["Tidy inbox", "Review the launch deck"].map((title) =>
    text.indexOf(title),
  );
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // Read-only past the fold, and the work under way is not in it.
  expect(within(done).getAllByRole("button")).toEqual([fold]);
  expect(text).not.toContain("Draft the reply");
  // At the foot of the screen, after Working.
  const regions = view
    .getAllByRole("region")
    .map((region) => region.getAttribute("aria-label"));
  expect(regions.at(-1)).toBe("Resolved");
  expect(regions.indexOf("Working")).toBeLessThan(regions.indexOf("Resolved"));
});

test("with nothing resolved, Resolved is left out", async () => {
  quiet();
  activity = {
    inProgress: [item({ id: "now", status: "running" })],
    scheduled: [],
    completed: [],
  };
  serving();
  const view = draw();
  await view.findByRole("region", { name: "Working" });
  expect(view.queryByRole("region", { name: "Resolved" })).toBeNull();
});
