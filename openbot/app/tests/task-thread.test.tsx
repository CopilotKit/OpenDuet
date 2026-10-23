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
import { TaskSheet } from "@/components/duet/task-sheet";
import { clockTime } from "@/lib/approval-view";
import { channelKeys } from "@/lib/channels/queries";
import {
  ChatTaskCard,
  readStartedTask,
  TaskCardTool,
} from "@/lib/copilot/task-card-tool";
import { type TaskRecord, taskKeys } from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * One thread, many tasks: the card Chat draws under the Bot's "On it", kept live as the task moves,
 * and the task's own page, with its conversation under a header that marks it done.
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

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Every request the card, the page and the conversation make, answered from the fixtures above. */
function serving() {
  posted.length = 0;
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
      const again = /^\/api\/openduet\/tasks\/([^/]+)\/again$/.exec(path);
      if (again && method === "POST") {
        posted.push(path);
        tasks = tasks.map((task) =>
          task.id === again[1]
            ? { ...task, status: "working", failure: null, failedAt: null }
            : task,
        );
        return NativeResponse.json({
          task: tasks.find((task) => task.id === again[1]),
        });
      }
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

test("a card whose task couldn't finish says why, and Try again runs it once more from Chat", async () => {
  tasks = [
    rosa({ status: "failed", failure: "a service it needed didn't answer" }),
  ];
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
  const card = await view.findByRole("link", { name: /Draft a reply to Rosa/ });
  await waitFor(() =>
    expect(card.querySelector("[data-status]")?.textContent).toBe("Failed"),
  );
  expect(card.textContent).toContain(
    "Couldn't finish: a service it needed didn't answer.",
  );
  const again = view.getByRole("button", { name: "Try this task again" });
  expect(card.contains(again)).toBe(false);
  fireEvent.click(again);
  await waitFor(() =>
    expect(posted).toEqual(["/api/openduet/tasks/rosa/again"]),
  );
  await waitFor(() =>
    expect(card.querySelector("[data-status]")?.textContent).toBe("Working"),
  );
  expect(
    view.queryByRole("button", { name: "Try this task again" }),
  ).toBeNull();
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

test("the task page: × and the title across the top, where it stands, Mark done, then its conversation", async () => {
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
  await waitFor(() =>
    expect(sheet.querySelector("[data-status]")?.textContent).toBe(
      "Ready for review",
    ),
  );
  expect(sheet.textContent).toContain(`Started ${clockTime(rosa().createdAt)}`);

  // The conversation is the task's own, and its first message is the person's ask without the frame.
  expect(
    await within(sheet).findByText(ASK, undefined, { timeout: 5_000 }),
  ).toBeTruthy();
  expect(
    await within(sheet).findByText(/Here's the draft to Rosa/, undefined, {
      timeout: 5_000,
    }),
  ).toBeTruthy();
  expect(sheet.textContent).not.toContain("This conversation is a task");

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
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
});

test("the task page of one that couldn't finish says why in the Bot's words, and Try again runs it in the same conversation", async () => {
  tasks = [
    rosa({
      status: "failed",
      failure: "the run took longer than 5 minutes",
      failedAt: new Date("2026-10-22T09:47:00").toISOString(),
    }),
  ];
  serving();
  const { view } = app("/tasks/rosa");
  const sheet = await view.findByRole(
    "dialog",
    { name: rosa().title },
    { timeout: 5_000 },
  );
  await waitFor(() =>
    expect(sheet.querySelector("[data-status]")?.textContent).toBe("Failed"),
  );
  // The Bot's own line, as it recorded it in the conversation, and when: the page's last update.
  const update = sheet.querySelector("[data-failure]");
  expect(update?.textContent).toContain(
    "I couldn't finish this: the run took longer than 5 minutes.",
  );
  expect(update?.textContent).toContain(
    clockTime(new Date("2026-10-22T09:47:00").toISOString()),
  );
  // Mark done stays, beside Try again.
  expect(
    within(sheet).getByRole("button", { name: "Mark this task done" }),
  ).toBeTruthy();
  fireEvent.click(
    within(sheet).getByRole("button", { name: "Try this task again" }),
  );
  await waitFor(() =>
    expect(posted).toEqual(["/api/openduet/tasks/rosa/again"]),
  );
  await waitFor(() =>
    expect(sheet.querySelector("[data-status]")?.textContent).toBe("Working"),
  );
  expect(sheet.querySelector("[data-failure]")).toBeNull();
  expect(
    within(sheet).queryByRole("button", { name: "Try this task again" }),
  ).toBeNull();
  // Still the task's own conversation.
  expect(
    await within(sheet).findByText(ASK, undefined, { timeout: 5_000 }),
  ).toBeTruthy();
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
