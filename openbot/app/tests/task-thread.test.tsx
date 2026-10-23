import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
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
import type { ReactNode } from "react";
import { frameTaskBrief } from "@openbot/shared/task-brief";
import { ConversationView } from "@/components/channels/conversation-view";
import { useCloseSheet } from "@/components/duet/page-sheet";
import {
  decisionLine,
  eventTime,
  noticedLine,
  senderName,
  stampOf,
  TaskReportView,
  whenLine,
} from "@/components/duet/task-report";
import { TaskSheet } from "@/components/duet/task-sheet";
import { channelKeys } from "@/lib/channels/queries";
import {
  ChatTaskCard,
  readStartedTask,
  TaskCardTool,
} from "@/lib/copilot/task-card-tool";
import {
  type ReportDecision,
  type TaskRecord,
  type TaskReport,
  taskKeys,
} from "@/lib/tasks/queries";
import userEvent from "@testing-library/user-event";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * One thread, many tasks: the card Chat draws under the Bot's "On it", kept live as the task moves,
 * and the task's own page, read as a report: how it was noticed, its decisions and updates, what it
 * read, and its conversation folded under Show conversation, with the reply box at the foot.
 */

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const ASK = "Draft a reply to Rosa saying we'll take Oat Satin.";

let tasks: TaskRecord[] = [];
const posted: string[] = [];

const rosa = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "rosa",
  botId: "openduet",
  channelId: "rosa-channel",
  threadId: "rosa-thread",
  title: "Draft a reply to Rosa about Oat Satin",
  why: null,
  origin: "asked",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  status: "working",
  resolvedAt: null,
  createdAt: new Date("2026-10-22T09:41:00").toISOString(),
  updatedAt: new Date("2026-10-22T09:41:00").toISOString(),
  ...overrides,
});

const conversation = {
  id: "rosa-channel",
  name: "OpenDuet",
  agentIds: ["openduet"],
  threadId: "rosa-thread",
  active: true,
  lastMessageAt: "2026-10-22T09:42:00.000Z",
};

/** The task's conversation as the platform holds it: the ask under its frame, then the draft. */
const stored: Message[] = [
  { id: "u1", role: "user", content: frameTaskBrief(ASK) },
  {
    id: "a1",
    role: "assistant",
    content:
      "Here's the draft to Rosa. It's waiting for you to allow the send.",
  },
];

const sendToRosa: ReportDecision = {
  kind: "decision",
  id: "approval-1",
  decision: "allow_once",
  by: "you",
  at: new Date("2026-10-22T09:43:00").toISOString(),
  action: {
    toolRef: "openbot/share_private_information",
    effect: "share_private",
    scope: "external:rosa@clayworks-supply.com",
    args: {
      audience: "google-workspace: rosa@clayworks-supply.com",
      preview: "Hi Rosa, we'll take Oat Satin.",
    },
  },
};

/** What `GET /api/openduet/tasks/rosa/report` answers, as the server works it out. */
const report: TaskReport = {
  taskId: "rosa",
  entries: [
    {
      kind: "update",
      id: "a1",
      text: "Here's the draft to Rosa.",
      at: new Date("2026-10-22T09:42:00").toISOString(),
    },
    sendToRosa,
    { kind: "reply", id: "u2", text: "Also cc Sam next time.", at: null },
    {
      kind: "update",
      id: "a3",
      text: "Sent, and noted for next time.",
      at: new Date("2026-10-22T09:44:00").toISOString(),
    },
  ],
  resources: [
    {
      kind: "email",
      id: "b1f90c34a059d845",
      from: "Rosa Lind <rosa@clayworks-supply.com>",
      subject: "Glaze delay: substitute?",
      at: new Date("2026-10-22T08:05:00").toISOString(),
      link: "https://mail.google.com/mail/u/0/#all/b1f90c34a059d845",
    },
    {
      kind: "event",
      id: "ev-1",
      title: "Glaze test review",
      start: "2026-10-23T10:00:00-07:00",
      end: "2026-10-23T10:30:00-07:00",
      location: "Studio",
      link: null,
    },
  ],
};

let runs: {
  path: string;
  body: { threadId?: string; messages?: Message[] };
}[] = [];

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Every request the card, the page and the conversation make, answered from the fixtures above. */
function serving() {
  posted.length = 0;
  runs = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      const path = url.pathname;
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (path === "/api/openduet/tasks") return NativeResponse.json({ tasks });
      const done = /^\/api\/openduet\/tasks\/([^/]+)\/(resolve|reopen)$/.exec(
        path,
      );
      if (done && method === "POST") {
        posted.push(path);
        tasks = tasks.map((task) =>
          task.id === done[1]
            ? done[2] === "resolve"
              ? {
                  ...task,
                  status: "resolved",
                  resolvedAt: "2026-10-22T10:00:00.000Z",
                }
              : { ...task, status: "ready_for_review", resolvedAt: null }
            : task,
        );
        return NativeResponse.json({
          task: tasks.find((task) => task.id === done[1]),
        });
      }
      if (path === "/api/openduet/tasks/rosa/report")
        return NativeResponse.json({ report });
      const one = /^\/api\/openduet\/tasks\/([^/]+)$/.exec(path);
      if (one) {
        const task = tasks.find((row) => row.id === one[1]);
        return task
          ? NativeResponse.json({ task })
          : NativeResponse.json(
              { error: "Couldn't find that task." },
              { status: 404 },
            );
      }
      if (path === `/api/channels/${conversation.id}`)
        return NativeResponse.json({ channel: conversation });
      if (path === "/api/channels")
        return NativeResponse.json({ channels: [], nextCursor: null });
      if (/\/api\/channels\/[^/]+\/(activity|busy|read)$/.test(path))
        return new NativeResponse(null, { status: 204 });
      if (path === "/api/agents")
        return NativeResponse.json({
          agents: [{ id: "openduet", name: "OpenDuet" }],
        });
      if (path === "/api/plugins/for/openduet")
        return NativeResponse.json({ skills: [], tools: [] });
      if (path === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (path.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { openduet: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (path.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: conversation.threadId, runId: "j" },
          { type: "MESSAGES_SNAPSHOT", messages: stored },
          { type: "RUN_FINISHED", threadId: conversation.threadId, runId: "j" },
        ]);
      if (/\/threads\/[^/]+\/messages$/.test(path))
        return NativeResponse.json({ messages: stored });
      if (path.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = (await request.json()) as {
          threadId?: string;
          runId?: string;
          messages?: Message[];
        };
        runs.push({ path, body });
        return sse([
          { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
          { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
        ]);
      }
      return NativeResponse.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

/** The start_task call as the transcript holds it: the call, its result, then "On it." */
function startedIn(result: string): Message[] {
  return [
    { id: "u1", role: "user", content: ASK },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "start_task",
            arguments: JSON.stringify({
              title: rosa().title,
              instruction: ASK,
            }),
          },
        },
      ],
    },
    { id: "t1", role: "tool", toolCallId: "call-1", content: result },
    { id: "a2", role: "assistant", content: "On it." },
  ];
}

const started = JSON.stringify({
  taskId: "rosa",
  channelId: "rosa-channel",
  title: rosa().title,
  note: "Reply only On it.",
});

test("the tool's answer is a started task only when it started one", () => {
  expect(readStartedTask(started)).toEqual({
    taskId: "rosa",
    channelId: "rosa-channel",
    title: rosa().title,
  });
  // Encoded once more on the way through the runtime, it is still read.
  expect(readStartedTask(JSON.stringify(started))?.taskId).toBe("rosa");
  expect(readStartedTask("Refused. start_task takes a title.")).toBeNull();
  expect(readStartedTask(JSON.stringify({ title: "No id" }))).toBeNull();
  expect(readStartedTask(undefined)).toBeNull();
});

test("Chat draws the task's card under the Bot's On it, opening the task", async () => {
  tasks = [rosa()];
  serving();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <TaskCardTool />
        <ConversationView messages={startedIn(started)} onSubmit={() => {}} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  const card = await view.findByRole("link", { name: /Draft a reply to Rosa/ });
  expect(card.getAttribute("href")).toBe("/tasks/rosa");
  const line = view.getByText("On it.");
  expect(
    line.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("the card's pill follows the task: Working, Needs input, then Ready for review", async () => {
  tasks = [rosa({ status: "working" })];
  serving();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatTaskCard
        started={{
          taskId: "rosa",
          channelId: "rosa-channel",
          title: rosa().title,
        }}
      />
    </QueryClientProvider>,
  );
  const pill = () => view.container.querySelector("[data-status]");
  await waitFor(() => expect(pill()?.textContent).toBe("Working"));

  tasks = [rosa({ status: "needs_input" })];
  await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.all }));
  await waitFor(() => expect(pill()?.textContent).toBe("Needs input"));

  tasks = [rosa({ status: "ready_for_review" })];
  await act(() => queryClient.invalidateQueries({ queryKey: taskKeys.all }));
  await waitFor(() => expect(pill()?.textContent).toBe("Ready for review"));

  // The person replied in the task, and its conversation is running a turn: Working again.
  await act(async () => {
    queryClient.setQueryData(channelKeys.list(), {
      pages: [
        {
          channels: [
            {
              ...conversation,
              summary: null,
              lastMessage: null,
              lastMessageAgentId: null,
              createdAt: "2026-10-22T09:41:00.000Z",
              pinned: false,
              lastReadAt: null,
              taskId: "rosa",
              busy: true,
            },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [""],
    });
  });
  await waitFor(() => expect(pill()?.textContent).toBe("Working"));
});

/** The `/tasks/$taskId` route's component, against this test's route tree. */
function TaskRoute() {
  const { taskId } = useParams({ strict: false }) as { taskId: string };
  const navigate = useNavigate();
  const close = useCloseSheet(() => void navigate({ to: "/tasks" }));
  return <TaskSheet onClose={close} taskId={taskId} />;
}

function app(path: string, list: ReactNode = <p>Tasks list</p>) {
  const root = createRootRoute({ component: Outlet });
  const tasksRoute = createRoute({
    getParentRoute: () => root,
    path: "/tasks",
    component: () => (
      <>
        {list}
        <Outlet />
      </>
    ),
  });
  const taskRoute = createRoute({
    getParentRoute: () => tasksRoute,
    path: "$taskId",
    component: TaskRoute,
  });
  const router = createRouter({
    routeTree: root.addChildren([tasksRoute.addChildren([taskRoute])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <RouterProvider router={router as never} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  return { view, router };
}

test("the task page reads as a report: how it was noticed, where it stands, decisions and updates, what it read, then its conversation", async () => {
  tasks = [rosa({ status: "ready_for_review" })];
  serving();
  const { view, router } = app("/tasks/rosa");
  // The first render of the conversation is slow on a cold run, so the sheet gets a few seconds.
  const sheet = await view.findByRole(
    "dialog",
    { name: rosa().title },
    { timeout: 5_000 },
  );
  expect(within(sheet).getByRole("button", { name: "Close" })).toBeTruthy();
  // The header: how and when it began, where it stands, and Mark done.
  expect(sheet.textContent).toContain(noticedLine(rosa()));
  await waitFor(() =>
    expect(sheet.querySelector("[data-status]")?.textContent).toBe(
      "Ready for review",
    ),
  );

  // Decisions and updates, in the order they happened.
  const timeline = await within(sheet).findByRole(
    "list",
    { name: "Decisions and updates" },
    { timeout: 4_000 },
  );
  const entries = within(timeline).getAllByRole("listitem");
  expect(entries.map((entry) => entry.getAttribute("data-entry"))).toEqual([
    "update",
    "decision",
    "reply",
    "update",
  ]);
  expect(entries[0]?.textContent).toContain("Here's the draft to Rosa.");
  expect(entries[0]?.textContent).toContain(
    stampOf(report.entries[0]?.at ?? null),
  );
  expect(entries[1]?.textContent).toContain(
    "Allowed once: Send email to rosa@clayworks-supply.com",
  );
  expect(entries[1]?.textContent).toContain(
    `By you · ${stampOf(sendToRosa.at)}`,
  );
  expect(entries[2]?.textContent).toBe("You: Also cc Sam next time.");
  expect(entries[3]?.textContent).toContain("Sent, and noted for next time.");

  // Resources: each email with its sender, subject and a link out; each event with its time.
  const resources = within(sheet).getByRole("region", { name: "Resources" });
  const email = within(resources).getByRole("link", {
    name: "Open the email from Rosa Lind: Glaze delay: substitute?",
  });
  expect(email.getAttribute("href")).toBe(
    "https://mail.google.com/mail/u/0/#all/b1f90c34a059d845",
  );
  expect(email.getAttribute("target")).toBe("_blank");
  expect(resources.textContent).toContain("Glaze test review");
  expect(resources.textContent).toContain(
    `${eventTime("2026-10-23T10:00:00-07:00")} · Studio`,
  );

  // The conversation is folded under the report until it is asked for.
  const disclosure = within(sheet).getByRole("button", {
    name: "Show conversation",
  });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(sheet.textContent).not.toContain(ASK);
  fireEvent.click(disclosure);
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(disclosure.textContent).toContain("Hide conversation");
  // The conversation is the task's own, and its first message is the person's ask without the frame.
  expect(
    await within(sheet).findByText(ASK, undefined, { timeout: 5_000 }),
  ).toBeTruthy();
  expect(
    await within(sheet).findByText(
      /Here's the draft to Rosa\. It's waiting/,
      undefined,
      {
        timeout: 5_000,
      },
    ),
  ).toBeTruthy();
  expect(sheet.textContent).not.toContain("This conversation is a task");
  fireEvent.click(disclosure);
  await waitFor(() => expect(sheet.textContent?.includes(ASK)).toBe(false));

  fireEvent.click(
    within(sheet).getByRole("button", { name: "Mark this task done" }),
  );
  await waitFor(() =>
    expect(posted).toEqual(["/api/openduet/tasks/rosa/resolve"]),
  );
  await waitFor(() =>
    expect(sheet.querySelector("[data-status]")?.textContent).toBe("Resolved"),
  );
  const reopen = within(sheet).getByRole("button", {
    name: "Reopen this task",
  });
  expect(reopen.textContent).toBe("Reopen");
  fireEvent.click(reopen);
  await waitFor(() =>
    expect(posted).toEqual([
      "/api/openduet/tasks/rosa/resolve",
      "/api/openduet/tasks/rosa/reopen",
    ]),
  );
  await waitFor(() =>
    expect(
      within(sheet).getByRole("button", { name: "Mark this task done" }),
    ).toBeTruthy(),
  );

  // Opened on its own, × closes to the Tasks list.
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/tasks"));
  await waitFor(() => expect(view.queryByRole("dialog") === null).toBe(true));
});

test("a reply from the box at the foot goes into the task's conversation, and unfolds it", async () => {
  tasks = [rosa({ status: "ready_for_review" })];
  serving();
  const { view } = app("/tasks/rosa");
  const sheet = await view.findByRole(
    "dialog",
    { name: rosa().title },
    { timeout: 5_000 },
  );
  await within(sheet).findByRole(
    "list",
    { name: "Decisions and updates" },
    { timeout: 4_000 },
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    within(sheet).getByRole("textbox", { name: "Message" }),
    "Also cc Sam",
  );
  await user.click(within(sheet).getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(runs).toHaveLength(1), { timeout: 5_000 });
  expect(runs[0]?.path).toBe("/api/copilotkit/agent/openduet/run");
  expect(runs[0]?.body.threadId).toBe("rosa-thread");
  expect(runs[0]?.body.messages?.at(-1)).toMatchObject({
    role: "user",
    content: "Also cc Sam",
  });
  // Sending unfolded the conversation, so the reply is seen landing.
  expect(
    within(sheet)
      .getByRole("button", { name: "Hide conversation" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    await within(sheet).findByText(ASK, undefined, { timeout: 5_000 }),
  ).toBeTruthy();
});

test("a task's header says how it began and why, and a decision is named as its approval card names it", () => {
  const now = new Date("2026-10-22T12:00:00");
  expect(
    noticedLine(
      {
        origin: "suggestion",
        createdAt: new Date("2026-10-22T09:41:00").toISOString(),
        why: "Rosa needs a yes or no by end of day.",
      },
      now,
    ),
  ).toBe(
    `Noticed ${whenLine(new Date("2026-10-22T09:41:00").toISOString(), now)} · Rosa needs a yes or no by end of day.`,
  );
  expect(
    noticedLine(
      {
        origin: "asked",
        createdAt: new Date("2026-10-21T09:41:00").toISOString(),
        why: null,
      },
      now,
    ),
  ).toMatch(/^You asked yesterday at /);
  expect(whenLine(new Date("2026-10-18T09:41:00").toISOString(), now)).toMatch(
    /^on /,
  );
  expect(stampOf(null)).toBe("");
  expect(decisionLine({ ...sendToRosa, decision: "deny" })).toBe(
    "Refused: Send email to rosa@clayworks-supply.com",
  );
  expect(senderName("Rosa Lind <rosa@clayworks-supply.com>")).toBe("Rosa Lind");
  expect(senderName("<rosa@clayworks-supply.com>")).toBe(
    "rosa@clayworks-supply.com",
  );
  expect(senderName("rosa@clayworks-supply.com")).toBe(
    "rosa@clayworks-supply.com",
  );
  expect(eventTime("2026-10-23")).toBe(
    new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(new Date(2026, 9, 23)),
  );
});

test("a task that is not the person's says so in the sheet", async () => {
  tasks = [];
  serving();
  const { view } = app("/tasks/someone-elses");
  const sheet = await view.findByRole("dialog", undefined, { timeout: 5_000 });
  // The app tries a failed read once more before saying so.
  const alert = await within(sheet).findByRole("alert", undefined, {
    timeout: 4_000,
  });
  expect(alert.textContent).toBe(
    "Couldn't open this task. Close it and try again.",
  );
});

test("a report with nothing in it yet says what will appear there", () => {
  const view = render(
    <TaskReportView
      botName="OpenDuet"
      conversationShown={false}
      error={null}
      onToggleConversation={() => {}}
      pending={false}
      report={{ taskId: "rosa", entries: [], resources: [] }}
    />,
  );
  expect(
    view.getByText(
      "Nothing yet. What OpenDuet decides and finds shows up here.",
    ),
  ).toBeTruthy();
  expect(view.getByText("No emails or events read yet.")).toBeTruthy();
  expect(view.getByRole("button", { name: "Show conversation" })).toBeTruthy();
  view.unmount();
  const failed = render(
    <TaskReportView
      botName="OpenDuet"
      conversationShown={false}
      error={new Error("down")}
      onToggleConversation={() => {}}
      pending={false}
      report={undefined}
    />,
  );
  expect(failed.getByRole("alert").textContent).toBe(
    "Couldn't load this task's report. Close it and try again.",
  );
});
