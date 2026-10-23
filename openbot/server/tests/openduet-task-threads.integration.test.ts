import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  frameTaskBrief,
  frameTaskReply,
  readTaskBrief,
} from "@openbot/shared/task-brief";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AuthenticatedActor } from "../src/auth/guards";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  approvalRequests,
  channels,
  intelligenceChannelMappings,
  openduetTasks,
  users,
  workItems,
} from "../src/db/schema";
import {
  createTaskRoutes,
  createTaskStore,
  type TaskRecord,
} from "../src/openduet/task-store";
import { createTaskReportReader } from "../src/openduet/task-report";
import { createTaskThreads } from "../src/openduet/task-threads";
import { START_TASK_TOOL } from "../src/openduet/tasks";
import {
  ASKED_RUN_PREFIX,
  createOpenDuetTools,
  createTaskIntake,
} from "../src/openduet/wiring";
import {
  createProactiveEngine,
  PROACTIVE_RUN_KIND,
  PROACTIVE_TASK_KIND,
  type ProactiveScope,
} from "../src/proactive/engine";
import { createProactiveStore } from "../src/proactive/store";
import {
  ProactiveNotFoundError,
  ProactiveRefusedError,
} from "../src/proactive/types";
import type { WorkItem, WorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A task is work OpenDuet does in a conversation of its own, so Chat stays one thread. These run
 * against PostgreSQL: the conversation is a real channel, and what a task is doing is read from the
 * real work queue, approval inbox and question queue.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const taskStore = createTaskStore(database);
const proactiveStore = createProactiveStore(database);
const prefix = `task-threads-${randomUUID()}`;
const owner: AgentActor = { id: `${prefix}-owner`, role: "user" };
const other: AgentActor = { id: `${prefix}-other`, role: "user" };
let bot = "";

const actorFor = async (id: string): Promise<AgentActor> => ({
  id,
  role: "user",
});
const scopeFor = async (
  ownerUserId: string,
  channelId: string,
  agentId: string,
): Promise<ProactiveScope | null> => {
  const channel = await channelStore.get(
    await actorFor(ownerUserId),
    channelId,
  );
  return channel?.agentIds.includes(agentId)
    ? { ownerUserId, channelId, agentId, threadId: channel.threadId }
    : null;
};
const threads = createTaskThreads({
  store: taskStore,
  channels: channelStore,
  actorFor,
  scopeFor,
});

/**
 * The queue in memory, so a task started here is only ever claimed by this file's engine: the shared
 * test database can hold other files' queued work, which a real claim would pick up instead.
 */
function memoryQueue() {
  const items = new Map<
    string,
    WorkItem & { finished: boolean; claimed: boolean; lastError?: string }
  >();
  const queue = {
    offer: async (item: {
      kind: string;
      key: string;
      payload?: Record<string, unknown>;
    }) => {
      const id = `${item.kind}:${item.key}`;
      if (items.has(id)) return "already";
      items.set(id, {
        kind: item.kind,
        key: item.key,
        payload: item.payload ?? {},
        attempts: 0,
        finished: false,
        claimed: false,
      });
      return "queued";
    },
    claim: async ({
      kind,
      maxAttempts = 5,
    }: {
      kind: string;
      maxAttempts?: number;
    }) => {
      const due = [...items.values()].find(
        (item) =>
          item.kind === kind &&
          !item.finished &&
          !item.claimed &&
          item.attempts < maxAttempts,
      );
      if (!due) return [];
      due.claimed = true;
      due.attempts += 1;
      return [{ ...due }];
    },
    renew: async () => true,
    finish: async ({ kind, key }: { kind: string; key: string }) => {
      const item = items.get(`${kind}:${key}`);
      if (item) item.finished = true;
      return true;
    },
    release: async ({
      kind,
      key,
      reason,
    }: {
      kind: string;
      key: string;
      reason?: string;
    }) => {
      const item = items.get(`${kind}:${key}`);
      if (item) {
        item.claimed = false;
        if (reason !== undefined) item.lastError = reason;
      }
      return true;
    },
    purge: async () => 0,
  };
  return { queue: queue as unknown as WorkQueue, items };
}

type Started = {
  scope: ProactiveScope;
  runId: string;
  text: string;
  final: boolean;
};

/** An engine on the memory queue. `turn` is each task turn's outcome; by default it succeeds. */
function engineFor(turn: (started: Started) => Promise<void> = async () => {}) {
  const { queue, items } = memoryQueue();
  const started: Started[] = [];
  const engine = createProactiveEngine({
    store: proactiveStore,
    memory: {
      formMemory: async () => ({ id: "m", duplicate: false, forgotten: false }),
    },
    queue,
    owner: "worker",
    runTurn: async () => {
      throw new Error("No research runs here.");
    },
    resolveScope: scopeFor,
    notify: async () => undefined,
    tasks: threads,
    startTask: async (scope, input) => {
      const run = {
        scope,
        runId: input.runId,
        text: input.text,
        final: input.final,
      };
      started.push(run);
      await turn(run);
    },
    catalogue: { listServers: async () => [] },
    mintThreadId: () => `${prefix}-research-thread`,
    taskRetryMs: 0,
  });
  return { engine, items, started };
}

const chatOf = () => channelStore.direct(owner, bot);

/** A turn for this task on the real queue, in whatever state the test needs. */
async function turnFor(
  taskId: string,
  state: Partial<typeof workItems.$inferInsert> = {},
  key = `task:${taskId}`,
) {
  await database.insert(workItems).values({
    kind: PROACTIVE_TASK_KIND,
    key,
    payload: { ownerUserId: owner.id, taskId, text: "Prepare the notes." },
    ...state,
  });
  return and(eq(workItems.kind, PROACTIVE_TASK_KIND), eq(workItems.key, key));
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner.id, email: `${owner.id}@example.test` },
    { id: other.id, email: `${other.id}@example.test` },
  ]);
  bot = (
    await profileStore.create(owner, {
      name: "OpenDuet",
      title: "Your proactive assistant",
      roleDescription: "Works for one person.",
      visibility: "private",
    })
  ).id;
});

afterAll(async () => {
  const mine = await database
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(
      intelligenceChannelMappings,
      eq(intelligenceChannelMappings.channelId, channels.id),
    )
    .where(inArray(intelligenceChannelMappings.userId, [owner.id, other.id]));
  if (mine.length > 0)
    await database.delete(channels).where(
      inArray(
        channels.id,
        mine.map((row) => row.id),
      ),
    );
  await database
    .delete(workItems)
    .where(sql`${workItems.payload}->>'ownerUserId' = ${owner.id}`);
  await database.delete(users).where(inArray(users.id, [owner.id, other.id]));
  await database.delete(agentProfiles).where(eq(agentProfiles.agentId, bot));
  await database.delete(agents).where(eq(agents.id, bot));
  await database.$client.close();
});

describe("start_task", () => {
  test("opens the task with a conversation of its own and starts exactly one turn there", async () => {
    const chat = await chatOf();
    const { engine, items, started } = engineFor();
    const tool = createOpenDuetTools({
      database,
      callTool: async () => ({ text: "{}", isError: false }),
      complete: async () => "{}",
      model: "test-model",
      directChannel: async () => ({ id: chat.id, threadId: chat.threadId }),
      startTask: ({ ownerUserId, agentId, task }) =>
        engine.startAsked(ownerUserId, agentId, task),
    })(owner.id, bot, { kind: "person" }).find(
      (granted) => granted.name === START_TASK_TOOL,
    );
    if (!tool) throw new Error(`${START_TASK_TOOL} is not held`);

    const instruction =
      "Draft a reply to Rosa saying we'll take Oat Satin instead of the discontinued glaze.";
    const result = JSON.parse(
      await tool.execute({
        title: "Draft a reply to Rosa about Oat Satin",
        instruction,
        why: "She needs an answer before Friday's firing.",
        source: "Gmail",
      }),
    ) as { taskId: string; channelId: string; title: string };
    await engine.idle();

    expect(result.title).toBe("Draft a reply to Rosa about Oat Satin");
    const task = await taskStore.get(owner.id, result.taskId);
    expect(task).toMatchObject({
      botId: bot,
      channelId: result.channelId,
      origin: "asked",
      why: "She needs an answer before Friday's firing.",
      sourceApp: "Gmail",
      suggestionId: null,
      resolvedAt: null,
    });
    // Its own conversation, with the Bot alone, and not Chat's.
    expect(task.channelId).not.toBe(chat.id);
    const conversation = await channelStore.get(owner, task.channelId);
    expect(conversation?.agentIds).toEqual([bot]);

    // One turn, in that conversation, with the ask as the person's message under the task frame.
    expect(started).toHaveLength(1);
    expect(started[0]?.scope).toEqual({
      ownerUserId: owner.id,
      channelId: task.channelId,
      agentId: bot,
      threadId: conversation?.threadId ?? "",
    });
    expect(started[0]?.runId).toBe(`task-${task.id}`);
    expect(started[0]?.text).toBe(frameTaskBrief(instruction));
    expect(readTaskBrief(started[0]?.text ?? "")).toBe(instruction);
    expect(items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)?.finished).toBe(
      true,
    );
  });

  test("has no cap: every call opens another task in another conversation", async () => {
    const { engine, started } = engineFor();
    const opened = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        engine.startAsked(owner.id, bot, {
          title: `Task ${index}`,
          instruction: `Do thing ${index}`,
        }),
      ),
    );
    await engine.idle();
    expect(new Set(opened.map((task) => task.channelId)).size).toBe(12);
    expect(started).toHaveLength(12);
  });

  test("Chat's conversation with the Bot stays Chat's, however recently a task ran", async () => {
    const chat = await chatOf();
    const { engine } = engineFor();
    const task = await engine.startAsked(owner.id, bot, {
      title: "Prepare notes for the Hearth & Co visit",
      instruction: "Prepare notes for the Hearth & Co visit.",
    });
    await engine.idle();
    await channelStore.recordActivity(owner, task.channelId, {
      text: "Here are the notes.",
      agentId: bot,
      at: new Date(Date.now() + 60_000),
    });
    expect((await chatOf()).id).toBe(chat.id);

    // The roster still lists it, marked, so the app can keep it out of Chat and the menu.
    const page = await channelStore.list(owner, { limit: 200 });
    expect(page.channels.find((row) => row.id === task.channelId)?.taskId).toBe(
      task.id,
    );
    expect(page.channels.find((row) => row.id === chat.id)?.taskId).toBeNull();
    // Research's defaults never adopt a task's conversation as the person's own.
    expect(await taskStore.isTaskConversation(owner.id, task.channelId)).toBe(
      true,
    );
    expect(await taskStore.isTaskConversation(owner.id, chat.id)).toBe(false);
    expect(await taskStore.isTaskConversation(other.id, task.channelId)).toBe(
      false,
    );
  });
});

describe("Start on a suggestion", () => {
  test("opens a task in a conversation of its own instead of running in Chat", async () => {
    const chat = await chatOf();
    const setting =
      (await proactiveStore.list(owner.id)).find(
        (row) => row.agentId === bot,
      ) ??
      (await proactiveStore.create(
        owner.id,
        { agentId: bot, channelId: chat.id, enabled: false },
        chat.threadId,
      ));
    const add = (title: string) =>
      proactiveStore.addSuggestion({
        ownerUserId: owner.id,
        agentId: bot,
        settingId: setting.id,
        runId: `asked:${randomUUID()}`,
        title,
        detail: "Ravi publishes in 7 days.\n\nNext: Reply to Ravi.",
        sourceApp: "Gmail",
        sourceRef: null,
        sourceLink: "https://mail.google.com/mail/u/0/#inbox/n26",
      });
    const fromTasks = await add("Triage the order-form report");
    const fromCheckIn = await add("Answer Sam about Friday off");
    const { engine, started } = engineFor();

    const { suggestion, task } = await engine.start(owner.id, fromTasks.id);
    await engine.idle();
    expect(suggestion.status).toBe("started");
    const record = await taskStore.get(owner.id, task.id);
    expect(record).toMatchObject({
      origin: "suggestion",
      suggestionId: fromTasks.id,
      title: "Triage the order-form report",
      why: "Ravi publishes in 7 days.",
      sourceApp: "Gmail",
      sourceLink: "https://mail.google.com/mail/u/0/#inbox/n26",
    });
    expect(record.channelId).not.toBe(chat.id);
    expect(started).toHaveLength(1);
    expect(started[0]?.scope.channelId).toBe(record.channelId);
    expect(readTaskBrief(started[0]?.text ?? "")).toContain(
      "Triage the order-form report",
    );

    // Started once: a second Start is refused and opens nothing.
    await expect(engine.start(owner.id, fromTasks.id)).rejects.toThrow(
      "already started",
    );
    // Somebody else's suggestion is no suggestion at all.
    await expect(engine.start(other.id, fromCheckIn.id)).rejects.toBeInstanceOf(
      ProactiveNotFoundError,
    );
    expect(
      (await proactiveStore.suggestion(owner.id, fromCheckIn.id)).status,
    ).toBe("open");

    // Pressed on a check-in's card, it says so.
    const fromCard = await engine.start(owner.id, fromCheckIn.id, "check_in");
    await engine.idle();
    expect((await taskStore.get(owner.id, fromCard.task.id)).origin).toBe(
      "check_in",
    );
    expect(started).toHaveLength(2);
  });
});

describe("status", () => {
  async function freshTask() {
    const opened = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: `Status ${randomUUID()}`,
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    const conversation = await channelStore.get(owner, opened.channelId);
    return { id: opened.id, threadId: conversation?.threadId ?? "" };
  }
  const statusOf = async (id: string) =>
    (await taskStore.get(owner.id, id)).status;

  test("is worked out from the queue, the approval inbox and the question queue, never stored", async () => {
    const task = await freshTask();
    // Opened, and its turn not queued yet: just started.
    expect(await statusOf(task.id)).toBe("working");

    // Its turn, queued and then running: working.
    const where = await turnFor(task.id);
    expect(await statusOf(task.id)).toBe("working");
    await database
      .update(workItems)
      .set({
        attempts: 1,
        claimedBy: "worker",
        leaseUntil: sql`now() + interval '5 minutes'`,
      })
      .where(where);
    expect(await statusOf(task.id)).toBe("working");
    // Finished: the run wrote its reply, so there is something to read.
    await database
      .update(workItems)
      .set({ finishedAt: new Date(), claimedBy: null, leaseUntil: null })
      .where(where);
    expect(await statusOf(task.id)).toBe("ready_for_review");

    // Its reply stopped for Allow once: needs input.
    const approvalId = `${prefix}-approval-${randomUUID()}`;
    await database.insert(approvalRequests).values({
      id: approvalId,
      ownerUserId: owner.id,
      runId: `task-${task.id}`,
      toolCallId: "send",
      actionDigest: "digest",
      action: {
        threadId: task.threadId,
        botId: bot,
        toolRef: "google-workspace/gmail_send_reply",
      } as never,
    });
    expect(await statusOf(task.id)).toBe("needs_input");

    // Allowed: carried on, so working; done, so ready to read.
    await database
      .update(approvalRequests)
      .set({ status: "approved", decision: "allow_once" })
      .where(eq(approvalRequests.id, approvalId));
    await database.insert(workItems).values({
      kind: "approval.resume",
      key: approvalId,
      payload: { ownerUserId: owner.id, approvalId },
    });
    expect(await statusOf(task.id)).toBe("working");
    await database
      .update(workItems)
      .set({ finishedAt: new Date() })
      .where(
        and(
          eq(workItems.kind, "approval.resume"),
          eq(workItems.key, approvalId),
        ),
      );
    await database
      .update(approvalRequests)
      .set({ status: "completed" })
      .where(eq(approvalRequests.id, approvalId));
    expect(await statusOf(task.id)).toBe("ready_for_review");

    // A question its Bot asked in its conversation: needs input until answered.
    const question = `${prefix}-question-${randomUUID()}`;
    await database.insert(workItems).values({
      kind: "person.question",
      key: question,
      payload: {
        actorId: owner.id,
        botId: bot,
        threadId: task.threadId,
        question: "Which glaze?",
      },
    });
    expect(await statusOf(task.id)).toBe("needs_input");
    await database
      .update(workItems)
      .set({ finishedAt: new Date() })
      .where(
        and(eq(workItems.kind, "person.question"), eq(workItems.key, question)),
      );

    // Marked done: resolved. Something waiting on the person still shows over it.
    await taskStore.resolve(owner.id, task.id);
    expect(await statusOf(task.id)).toBe("resolved");
    await taskStore.reopen(owner.id, task.id);
    expect(await statusOf(task.id)).toBe("ready_for_review");

    // Nothing about status is a column.
    const [row] = await database
      .select()
      .from(openduetTasks)
      .where(eq(openduetTasks.id, task.id));
    expect(Object.keys(row ?? {})).not.toContain("status");
  });

  test("another person's pending approval on the same thread id is not this task's", async () => {
    const task = await freshTask();
    await turnFor(task.id, { attempts: 1, finishedAt: new Date() });
    await database.insert(approvalRequests).values({
      id: `${prefix}-theirs-${randomUUID()}`,
      ownerUserId: other.id,
      runId: "theirs",
      toolCallId: "send",
      actionDigest: "digest",
      action: { threadId: task.threadId, botId: bot } as never,
    });
    expect(await statusOf(task.id)).toBe("ready_for_review");
  });
});

describe("/api/openduet/tasks", () => {
  const routes = createTaskRoutes(taskStore, async (context, next) => {
    context.set("actor", {
      id: context.req.header("x-person") ?? owner.id,
    } as AuthenticatedActor);
    await next();
  });
  const call = (person: string, path: string, method = "GET") =>
    routes.request(path, { method, headers: { "x-person": person } });

  test("lists the person's own tasks, newest first, and resolves and reopens them", async () => {
    const first = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: "Older",
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    await Bun.sleep(5);
    const second = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: "Newer",
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    const listed = (await (await call(owner.id, "/")).json()) as {
      tasks: TaskRecord[];
    };
    const ids = listed.tasks.map((task) => task.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(listed.tasks.every((task) => typeof task.status === "string")).toBe(
      true,
    );

    // Each names its conversation's thread, which its approvals and questions carry.
    const conversation = await channelStore.get(owner, second.channelId);
    expect(listed.tasks.find((task) => task.id === second.id)?.threadId).toBe(
      conversation?.threadId ?? "missing",
    );

    await turnFor(second.id, { attempts: 1, finishedAt: new Date() });
    const resolved = (await (
      await call(owner.id, `/${second.id}/resolve`, "POST")
    ).json()) as { task: TaskRecord };
    expect(resolved.task.status).toBe("resolved");
    expect(resolved.task.resolvedAt).not.toBeNull();
    const reopened = (await (
      await call(owner.id, `/${second.id}/reopen`, "POST")
    ).json()) as { task: TaskRecord };
    expect(reopened.task.status).toBe("ready_for_review");
    expect(reopened.task.resolvedAt).toBeNull();
  });

  test("another person's task is the same as no task", async () => {
    const mine = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: "Mine",
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    expect((await call(other.id, `/${mine.id}`)).status).toBe(404);
    expect((await call(other.id, `/${mine.id}/resolve`, "POST")).status).toBe(
      404,
    );
    expect((await call(other.id, `/${mine.id}/reopen`, "POST")).status).toBe(
      404,
    );
    const theirs = (await (await call(other.id, "/")).json()) as {
      tasks: TaskRecord[];
    };
    expect(theirs.tasks).toEqual([]);
    expect((await taskStore.get(owner.id, mine.id)).resolvedAt).toBeNull();
  });
});

describe("a task whose turn fails", () => {
  async function opened(title = `Failing ${randomUUID()}`) {
    const task = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title,
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    return task;
  }
  const read = (id: string, store = taskStore) => store.get(owner.id, id);

  test("reads Working while its one retry is due, then Failed with the reason in plain words, never Ready for review", async () => {
    const task = await opened();
    // The first run threw: let go with its reason, and due once more.
    const where = await turnFor(task.id, {
      attempts: 1,
      lastError: "fetch failed",
    });
    expect((await read(task.id)).status).toBe("working");
    // A restart cut the first run off: the lease ran out, so the retry is due.
    await database
      .update(workItems)
      .set({
        lastError: null,
        claimedBy: "gone",
        leaseUntil: sql`now() - interval '1 second'`,
      })
      .where(where);
    expect((await read(task.id)).status).toBe("working");
    // The retry running.
    await database
      .update(workItems)
      .set({
        attempts: 2,
        claimedBy: "worker",
        leaseUntil: sql`now() + interval '3 minutes'`,
      })
      .where(where);
    expect((await read(task.id)).status).toBe("working");
    // The retry threw too: out of runs, so it failed, and says why without the error itself.
    await database
      .update(workItems)
      .set({
        claimedBy: null,
        leaseUntil: null,
        lastError: "The routine's turn was stopped after 300s.",
      })
      .where(where);
    const failed = await read(task.id);
    expect(failed.status).toBe("failed");
    expect(failed.failure).toBe("the run took longer than 5 minutes");
    expect(failed.failedAt).not.toBeNull();

    // Marked done, it is done; reopened, it is failed again.
    expect((await taskStore.resolve(owner.id, task.id)).status).toBe(
      "resolved",
    );
    // Its failure stays on the record while it is done, so a reply can still run it.
    expect((await taskStore.resolve(owner.id, task.id)).failure).toBe(
      "the run took longer than 5 minutes",
    );
    expect((await taskStore.reopen(owner.id, task.id)).status).toBe("failed");

    // Try again's turn is the newest, so it counts: working, then ready once it finished.
    const again = await turnFor(task.id, {}, `task:${task.id}:again:1`);
    expect((await read(task.id)).status).toBe("working");
    await database
      .update(workItems)
      .set({ attempts: 1, finishedAt: new Date() })
      .where(again);
    const done = await read(task.id);
    expect(done.status).toBe("ready_for_review");
    expect(done.failure).toBeNull();
    expect(done.failedAt).toBeNull();
  });

  test("whose last run a restart cut off fails, saying so, at the moment its lease ran out", async () => {
    const task = await opened();
    const expired = new Date(Date.now() - 60_000);
    // The first run threw and left its error; the second was cut off, and that is what is said.
    await turnFor(task.id, {
      attempts: 2,
      claimedBy: "gone",
      leaseUntil: expired,
      lastError: "fetch failed",
      updatedAt: new Date(Date.now() - 4 * 60_000),
    });
    expect(await read(task.id)).toMatchObject({
      status: "failed",
      failure: "the run was cut off partway through",
      failedAt: expired.toISOString(),
    });
  });

  test("whose turn never reached the queue fails to start, once it should have", async () => {
    const task = await opened();
    expect((await read(task.id)).status).toBe("working");
    const later = createTaskStore(database, {
      now: () => new Date(Date.now() + 2 * 60_000),
    });
    expect(await read(task.id, later)).toMatchObject({
      status: "failed",
      failure: "it never started",
    });
  });

  test("stays Failed whatever is said in its conversation, until a turn of its own finishes", async () => {
    const task = await opened();
    await turnFor(task.id, { attempts: 2, lastError: "fetch failed" });
    await channelStore.recordActivity(
      owner,
      task.channelId,
      {
        text: "I couldn't finish this: a service didn't answer.",
        agentId: bot,
        at: new Date(),
      },
      { id: `task-${task.id}-x:failed` },
    );
    // A Bot answer from the browser is not the task's turn: it may not have had the task at all.
    await channelStore.recordActivity(owner, task.channelId, {
      text: "Try it with the other glaze.",
      agentId: null,
      at: new Date(Date.now() + 1_000),
    });
    await channelStore.recordActivity(owner, task.channelId, {
      text: "Evening. Here's what's in your inbox.",
      agentId: bot,
      at: new Date(Date.now() + 2_000),
    });
    expect((await read(task.id)).status).toBe("failed");
    // Its own turn finishing is.
    const again = await turnFor(task.id, {}, `task:${task.id}:again:1`);
    await database
      .update(workItems)
      .set({ attempts: 1, finishedAt: new Date() })
      .where(again);
    expect((await read(task.id)).status).toBe("ready_for_review");
  });

  test("runs once more after throwing, and the second run is its last", async () => {
    const { engine, items, started } = engineFor(async () => {
      throw new Error("The routine's turn was stopped after 300s.");
    });
    const task = await engine.startAsked(owner.id, bot, {
      title: "Prepare notes for the Hearth & Co visit",
      instruction: "Prepare notes for the Hearth & Co visit.",
    });
    await engine.idle();
    expect(started.map((run) => run.final)).toEqual([false, true]);
    expect(started[0]?.runId).toBe(`task-${task.id}`);
    // The retry is a run of its own, so it never collides with the first in the conversation.
    expect(started[1]?.runId).toStartWith(`task-${task.id}-`);
    expect(started[1]?.runId).not.toBe(started[0]?.runId);
    expect(started[1]?.text).toBe(started[0]?.text);
    // Out of runs: unfinished on the queue, with its reason, which is what reads as Failed.
    expect(
      items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)?.payload,
    ).toMatchObject({ runs: 2 });
    expect(items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)).toMatchObject({
      attempts: 2,
      finished: false,
      lastError: "The routine's turn was stopped after 300s.",
    });
  });

  test("whose first run a restart cut off is picked up by the sweep, as its last run", async () => {
    const task = await opened();
    const { engine, items, started } = engineFor();
    // Claimed once by a process that died: its lease has run out.
    items.set(`${PROACTIVE_TASK_KIND}:task:${task.id}`, {
      kind: PROACTIVE_TASK_KIND,
      key: `task:${task.id}`,
      payload: {
        ownerUserId: owner.id,
        taskId: task.id,
        text: "Go on.",
        runs: 2,
      },
      attempts: 1,
      finished: false,
      claimed: false,
    });
    await engine.sweep();
    expect(started).toHaveLength(1);
    expect(started[0]?.final).toBe(true);
    expect(started[0]?.runId).toStartWith(`task-${task.id}-`);
    expect(started[0]?.text).toBe(frameTaskBrief("Go on."));
    expect(items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)?.finished).toBe(
      true,
    );
  });

  test("a turn from before retries is never run a second time, and stays failed", async () => {
    const task = await opened();
    const { engine, items, started } = engineFor();
    // Failed once, when one failure was final, and left unfinished.
    items.set(`${PROACTIVE_TASK_KIND}:task:${task.id}`, {
      kind: PROACTIVE_TASK_KIND,
      key: `task:${task.id}`,
      payload: { ownerUserId: owner.id, taskId: task.id, text: "Go on." },
      attempts: 1,
      finished: false,
      claimed: false,
    });
    await engine.sweep().catch(() => undefined);
    expect(started).toHaveLength(0);
    expect(items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)).toMatchObject({
      attempts: 2,
      finished: false,
      lastError: "This turn failed before it could be tried again.",
    });
  });

  test("a research run that throws in the sweep does not hold back a task's turn", async () => {
    const task = await opened();
    const { engine, items, started } = engineFor();
    items.set(`${PROACTIVE_RUN_KIND}:broken`, {
      kind: PROACTIVE_RUN_KIND,
      key: "broken",
      payload: {},
      attempts: 0,
      finished: false,
      claimed: false,
    });
    items.set(`${PROACTIVE_TASK_KIND}:task:${task.id}`, {
      kind: PROACTIVE_TASK_KIND,
      key: `task:${task.id}`,
      payload: {
        ownerUserId: owner.id,
        taskId: task.id,
        text: "Go on.",
        runs: 2,
      },
      attempts: 0,
      finished: false,
      claimed: false,
    });
    await expect(engine.sweep()).rejects.toThrow();
    expect(started).toHaveLength(1);
    expect(items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)?.finished).toBe(
      true,
    );
  });

  test("a reply on a failed task is Try again: the person's own message, with the ask beside it for the model", async () => {
    const task = await opened();
    await turnFor(task.id, { attempts: 2, lastError: "fetch failed" });
    const { engine, items, started } = engineFor();
    await engine.again(owner.id, task.id, {
      reply: "Use the Oat Satin glaze.",
      messageId: "reply-0123456789",
    });
    await engine.idle();
    expect(started).toHaveLength(1);
    expect(started[0]?.text).toBe(
      frameTaskReply("Prepare the notes.", "Use the Oat Satin glaze."),
    );
    // Their bubble is their words, under the id the browser already drew it with.
    expect(readTaskBrief(started[0]?.text ?? "")).toBe(
      "Use the Oat Satin glaze.",
    );
    expect(started[0]?.runId).toBe("reply-0123456789");
    expect(
      items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}:again:1`)?.payload,
    ).toMatchObject({
      reply: "Use the Oat Satin glaze.",
      again: true,
      runs: 2,
    });
  });

  test("marked done after failing, it keeps its failure, and a reply runs it and makes it not done", async () => {
    const task = await opened();
    await turnFor(task.id, { attempts: 2, lastError: "fetch failed" });
    const done = await taskStore.resolve(owner.id, task.id);
    expect(done).toMatchObject({
      status: "resolved",
      failure: "a service didn't answer",
    });
    expect(done.failedAt).not.toBeNull();
    const { engine, started } = engineFor();
    await engine.again(owner.id, task.id, { reply: "Please do it now." });
    await engine.idle();
    expect(started).toHaveLength(1);
    expect((await taskStore.get(owner.id, task.id)).resolvedAt).toBeNull();
    // Done and never failed has nothing to try again.
    const fine = await opened();
    await turnFor(fine.id, { attempts: 1, finishedAt: new Date() });
    await taskStore.resolve(owner.id, fine.id);
    await expect(engine.again(owner.id, fine.id)).rejects.toThrow(
      "Only a task that couldn't finish can be tried again.",
    );
  });

  test("a turn shaped as main queued it, from before tasks and retries, opens nothing and never runs again", async () => {
    const { engine, items, started } = engineFor();
    const suggestionId = `${prefix}-main-suggestion-${randomUUID()}`;
    // Main's Start: keyed by the suggestion, no task, no run count, failed once and left.
    items.set(`${PROACTIVE_TASK_KIND}:${suggestionId}`, {
      kind: PROACTIVE_TASK_KIND,
      key: suggestionId,
      payload: { ownerUserId: owner.id, suggestionId },
      attempts: 1,
      finished: false,
      claimed: false,
    });
    const tasksBefore = await database
      .select({ id: openduetTasks.id })
      .from(openduetTasks)
      .where(eq(openduetTasks.ownerUserId, owner.id));
    await engine.sweep().catch(() => undefined);
    const tasksAfter = await database
      .select({ id: openduetTasks.id })
      .from(openduetTasks)
      .where(eq(openduetTasks.ownerUserId, owner.id));
    expect(tasksAfter).toHaveLength(tasksBefore.length);
    expect(started).toHaveLength(0);
    expect(items.get(`${PROACTIVE_TASK_KIND}:${suggestionId}`)).toMatchObject({
      attempts: 2,
      finished: false,
      lastError: "This turn failed before it could be tried again.",
    });
  });

  test("Try again runs it once more in its own conversation, and only when it failed", async () => {
    const task = await opened();
    await turnFor(task.id, { attempts: 2, lastError: "fetch failed" });
    const { engine, items, started } = engineFor();

    // Somebody else's task is no task.
    await expect(engine.again(other.id, task.id)).rejects.toThrow(
      "Couldn't find that task.",
    );
    // Pressed twice at once, it is one run, and the second is told so rather than answered as done.
    const both = await Promise.allSettled([
      engine.again(owner.id, task.id),
      engine.again(owner.id, task.id),
    ]);
    expect(both.map((outcome) => outcome.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      both.find((outcome) => outcome.status === "rejected")?.reason,
    ).toBeInstanceOf(ProactiveRefusedError);
    await engine.idle();
    expect(started).toHaveLength(1);
    expect(started[0]?.scope.channelId).toBe(task.channelId);
    expect(started[0]?.text).toBe(frameTaskBrief("Prepare the notes."));
    expect(started[0]?.runId).toStartWith(`task-${task.id}-`);
    expect(started[0]?.final).toBe(false);
    expect(
      items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}:again:1`)?.finished,
    ).toBe(true);

    // One that did not fail has nothing to try again.
    const fine = await opened();
    await turnFor(fine.id, { attempts: 1, finishedAt: new Date() });
    await expect(engine.again(owner.id, fine.id)).rejects.toThrow(
      "Only a task that couldn't finish can be tried again.",
    );
  });

  test("Try again is served to the task's owner, for a failed task only", async () => {
    const task = await opened();
    await turnFor(task.id, { attempts: 2, lastError: "fetch failed" });
    const fine = await opened();
    await turnFor(fine.id, { attempts: 1, finishedAt: new Date() });
    const { engine, started } = engineFor();
    const routes = createTaskRoutes(
      taskStore,
      async (context, next) => {
        context.set("actor", {
          id: context.req.header("x-person") ?? owner.id,
        } as AuthenticatedActor);
        await next();
      },
      engine,
    );
    const again = (person: string, id: string) =>
      routes.request(`/${id}/again`, {
        method: "POST",
        headers: { "x-person": person },
      });

    expect((await again(other.id, task.id)).status).toBe(404);
    const refused = await again(owner.id, fine.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "Only a task that couldn't finish can be tried again.",
    );
    const tooLong = await routes.request(`/${task.id}/again`, {
      method: "POST",
      headers: { "x-person": owner.id, "content-type": "application/json" },
      body: JSON.stringify({ reply: "x".repeat(4001) }),
    });
    expect(tooLong.status).toBe(400);
    const badId = await routes.request(`/${task.id}/again`, {
      method: "POST",
      headers: { "x-person": owner.id, "content-type": "application/json" },
      body: JSON.stringify({ reply: "Hi", messageId: "<script>" }),
    });
    expect(badId.status).toBe(400);
    const accepted = await routes.request(`/${task.id}/again`, {
      method: "POST",
      headers: { "x-person": owner.id, "content-type": "application/json" },
      body: JSON.stringify({
        reply: "Use the Oat Satin glaze.",
        messageId: "reply-route-0001",
      }),
    });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { task: TaskRecord }).task.id).toBe(
      task.id,
    );
    await engine.idle();
    expect(started).toHaveLength(1);
    expect(readTaskBrief(started[0]?.text ?? "")).toBe(
      "Use the Oat Satin glaze.",
    );
    expect(started[0]?.runId).toBe("reply-route-0001");
    // And with no body, as the button sends it.
    const fresh = await opened();
    await turnFor(fresh.id, { attempts: 2, lastError: "fetch failed" });
    expect((await again(owner.id, fresh.id)).status).toBe(200);
    await engine.idle();
    expect(readTaskBrief(started[1]?.text ?? "")).toBe("Prepare the notes.");
  });
});

describe("the + on Tasks", () => {
  function plus() {
    const { engine, started } = engineFor();
    const routes = createTaskRoutes(
      taskStore,
      async (context, next) => {
        context.set("actor", {
          id: context.req.header("x-person") ?? owner.id,
        } as AuthenticatedActor);
        await next();
      },
      undefined,
      createTaskIntake({
        database,
        directChannel: async (ownerUserId, agentId) =>
          channelStore.direct(await actorFor(ownerUserId), agentId),
        startTask: ({ ownerUserId, agentId, task }) =>
          engine.startAsked(ownerUserId, agentId, task),
      }),
    );
    const post = (path: string, body: unknown, person = owner.id) =>
      routes.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-person": person },
        body: JSON.stringify(body),
      });
    return { engine, started, post };
  }

  test("Start now opens a task in a conversation of its own and starts it, titled from its first sentence", async () => {
    const chat = await chatOf();
    const { engine, started, post } = plus();
    const instruction =
      "Find a time for coffee with Sam next week.\nHe prefers mornings.";
    const response = await post("/", { botId: bot, instruction });
    expect(response.status).toBe(201);
    const { task } = (await response.json()) as { task: TaskRecord };
    await engine.idle();

    expect(task).toMatchObject({
      botId: bot,
      title: "Find a time for coffee with Sam next week",
      origin: "asked",
      suggestionId: null,
      resolvedAt: null,
    });
    expect(task.channelId).not.toBe(chat.id);
    const conversation = await channelStore.get(owner, task.channelId);
    expect(task.threadId).toBe(conversation?.threadId ?? "missing");
    // One turn, in its conversation, carrying the whole ask.
    expect(started).toHaveLength(1);
    expect(started[0]?.scope.channelId).toBe(task.channelId);
    expect(started[0]?.text).toBe(frameTaskBrief(instruction));
    expect((await taskStore.list(owner.id)).map((row) => row.id)).toContain(
      task.id,
    );
  });

  test("a title the person gives is kept", async () => {
    const { engine, post } = plus();
    const response = await post("/", {
      botId: bot,
      title: "Coffee with Sam",
      instruction: "Find a time for coffee with Sam next week.",
    });
    const { task } = (await response.json()) as { task: TaskRecord };
    await engine.idle();
    expect(task.title).toBe("Coffee with Sam");
  });

  test("Save for Up next adds a card the person asked for, and starts nothing", async () => {
    const { started, post } = plus();
    const one = await post("/up-next", {
      botId: bot,
      instruction: "Chase the booth deposit.",
    });
    expect(one.status).toBe(201);
    const saved = (await one.json()) as {
      suggestion: { id: string; title: string };
    };
    expect(saved.suggestion.title).toBe("Chase the booth deposit");
    const many = (await (
      await post("/up-next", {
        botId: bot,
        instruction: "Book the kiln service\nAsk for a Friday slot.",
      })
    ).json()) as { suggestion: { id: string } };

    const open = await proactiveStore.suggestions(owner.id);
    const card = open.find((row) => row.id === saved.suggestion.id);
    expect(card?.runId.startsWith(ASKED_RUN_PREFIX)).toBe(true);
    expect(card?.agentId).toBe(bot);
    // A one-line ask is all title; a longer one keeps the whole ask under it.
    expect(card?.detail).toBe("");
    expect(open.find((row) => row.id === many.suggestion.id)?.detail).toBe(
      "Book the kiln service\nAsk for a Friday slot.",
    );
    expect(started).toHaveLength(0);
    // Research is never turned on by saving a card.
    const setting = (await proactiveStore.list(owner.id)).find(
      (row) => row.agentId === bot,
    );
    expect(setting?.id).toBe(card?.settingId);
  });

  test("an empty ask, or no Bot, is refused with what to do", async () => {
    const { post } = plus();
    const empty = await post("/", { botId: bot, instruction: "   " });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain(
      "Say what OpenDuet should do",
    );
    const noBot = await post("/up-next", { instruction: "Do a thing" });
    expect(noBot.status).toBe(400);
    expect(((await noBot.json()) as { error: string }).error).toBe(
      "Choose one of your Bots.",
    );
    const extra = await post("/", {
      botId: bot,
      instruction: "Do a thing",
      runAs: "someone-else",
    });
    expect(extra.status).toBe(400);
  });

  test("a Bot the person cannot reach is the same as no Bot", async () => {
    const { started, post } = plus();
    const before = (await taskStore.list(other.id)).length;
    const response = await post(
      "/",
      { botId: bot, instruction: "Read their mail" },
      other.id,
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Couldn't find that Bot. Reload the page.",
    );
    expect(started).toHaveLength(0);
    expect(await taskStore.list(other.id)).toHaveLength(before);
    expect(
      (await post("/up-next", { botId: bot, instruction: "Read" }, other.id))
        .status,
    ).toBe(404);
  });

  test("without anywhere to start or save a task, the + routes are not served", async () => {
    const routes = createTaskRoutes(taskStore, async (context, next) => {
      context.set("actor", { id: owner.id } as AuthenticatedActor);
      await next();
    });
    const response = await routes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: bot, instruction: "Do a thing" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("report", () => {
  test("reads its decisions and turn ends from the ledgers and the rest from the conversation", async () => {
    const opened = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: `Report ${randomUUID()}`,
      why: "Ana needs an answer today.",
      origin: "suggestion",
      suggestionId: null,
      sourceApp: "Gmail",
      sourceLink: null,
    });
    const task = await taskStore.get(owner.id, opened.id);
    const threadId = task.threadId ?? "";
    expect(threadId).not.toBe("");

    // The first turn ended here, and stopped to ask before sending.
    const firstTurnEnded = new Date("2026-10-22T16:41:12.000Z");
    await database.insert(workItems).values({
      kind: PROACTIVE_TASK_KIND,
      key: `task:${task.id}`,
      payload: { ownerUserId: owner.id, taskId: task.id, text: "Go" },
      finishedAt: firstTurnEnded,
    });
    const approvalId = `${prefix}-report-${randomUUID()}`;
    const asked = new Date("2026-10-22T16:41:10.000Z");
    const decided = new Date("2026-10-22T16:42:00.000Z");
    const resumed = new Date("2026-10-22T16:42:20.000Z");
    const action = {
      threadId,
      botId: bot,
      toolRef: "openbot/share_private_information",
      effect: "share_private",
      scope: "external:ana@hearthandco.com",
      args: { audience: "google-workspace: ana@hearthandco.com" },
    };
    await database.insert(approvalRequests).values([
      {
        id: approvalId,
        ownerUserId: owner.id,
        runId: `task-${task.id}`,
        toolCallId: "call-send",
        actionDigest: "digest",
        action: action as never,
        status: "completed",
        decision: "allow_once",
        createdAt: asked,
        decidedAt: decided,
        completedAt: resumed,
      },
      // Another conversation's, and another person's: neither is this report's.
      {
        id: `${approvalId}-elsewhere`,
        ownerUserId: owner.id,
        runId: "elsewhere",
        toolCallId: "call-send",
        actionDigest: "digest",
        action: { ...action, threadId: "another-thread" } as never,
        status: "completed",
        decision: "deny",
        decidedAt: decided,
      },
      {
        id: `${approvalId}-theirs`,
        ownerUserId: other.id,
        runId: "theirs",
        toolCallId: "call-send-theirs",
        actionDigest: "digest",
        action: action as never,
        status: "completed",
        decision: "deny",
        decidedAt: decided,
      },
    ]);
    await database.insert(workItems).values({
      kind: "approval.resume",
      key: approvalId,
      payload: { ownerUserId: owner.id, approvalId },
      finishedAt: resumed,
    });

    const read: [string, string][] = [];
    const report = await createTaskReportReader({
      database,
      history: async ({ threadId: wanted, ownerUserId }) => {
        read.push([wanted, ownerUserId]);
        return [
          {
            id: `task-${task.id}`,
            role: "user",
            content: frameTaskBrief("Reply to Ana."),
          },
          {
            id: "a1",
            role: "assistant",
            content: "I read Ana's email. Sending the reply.",
            toolCalls: [{ id: "call-send", name: "send", args: "{}" }],
          },
          {
            id: `approval:${approvalId}`,
            role: "tool",
            toolCallId: "call-send",
            content: "Allowed.",
          },
          { id: "a2", role: "assistant", content: "Sent. Ana has it." },
        ];
      },
      // Read again now its turns are on the ledgers: just opened, with none, it is still starting.
    })(owner.id, await taskStore.get(owner.id, task.id));

    expect(read).toEqual([[threadId, owner.id]]);
    expect(
      report.entries.map((entry) =>
        entry.kind === "decision"
          ? `${entry.decision} ${entry.id} ${entry.at}`
          : `${entry.kind} ${entry.text} ${entry.at}`,
      ),
    ).toEqual([
      `update I read Ana's email. ${asked.toISOString()}`,
      `allow_once ${approvalId} ${decided.toISOString()}`,
      `update Sent. ${resumed.toISOString()}`,
    ]);
    expect(report.resources).toEqual([]);
  });
});
