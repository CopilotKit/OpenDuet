import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { frameTaskBrief, readTaskBrief } from "@openbot/shared/task-brief";
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
  PROACTIVE_TASK_KIND,
  type ProactiveScope,
} from "../src/proactive/engine";
import { createProactiveStore } from "../src/proactive/store";
import { ProactiveNotFoundError } from "../src/proactive/types";
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
    WorkItem & { finished: boolean; claimed: boolean }
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
    claim: async ({ kind }: { kind: string }) => {
      const due = [...items.values()].find(
        (item) => item.kind === kind && !item.finished && !item.claimed,
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
    release: async ({ kind, key }: { kind: string; key: string }) => {
      const item = items.get(`${kind}:${key}`);
      if (item) item.claimed = false;
      return true;
    },
    purge: async () => 0,
  };
  return { queue: queue as unknown as WorkQueue, items };
}

type Started = { scope: ProactiveScope; runId: string; text: string };

function engineFor() {
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
      started.push({ scope, runId: input.runId, text: input.text });
    },
    catalogue: { listServers: async () => [] },
    mintThreadId: () => `${prefix}-research-thread`,
  });
  return { engine, items, started };
}

const chatOf = () => channelStore.direct(owner, bot);

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
    expect(await statusOf(task.id)).toBe("ready_for_review");

    // Its turn, queued and then running: working.
    const turn = { kind: PROACTIVE_TASK_KIND, key: `task:${task.id}` };
    await database.insert(workItems).values({
      ...turn,
      payload: { ownerUserId: owner.id, taskId: task.id, text: "Go" },
    });
    expect(await statusOf(task.id)).toBe("working");
    const where = and(
      eq(workItems.kind, turn.kind),
      eq(workItems.key, turn.key),
    );
    await database
      .update(workItems)
      .set({
        attempts: 1,
        claimedBy: "worker",
        leaseUntil: sql`now() + interval '5 minutes'`,
      })
      .where(where);
    expect(await statusOf(task.id)).toBe("working");
    // Let go after failing: not working any more, so it does not read Working for ever.
    await database
      .update(workItems)
      .set({ claimedBy: null, leaseUntil: null })
      .where(where);
    expect(await statusOf(task.id)).toBe("ready_for_review");
    await database
      .update(workItems)
      .set({ finishedAt: new Date() })
      .where(where);

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
    })(owner.id, task);

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
