import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AgentNotFoundError } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  approvalRequests,
  intelligenceChannelMappings,
  workItems,
} from "../db/schema";
import { type OpenDuetTaskOrigin, openduetTasks } from "../db/schema/openduet";
import { PROACTIVE_TASK_KIND } from "../proactive/engine";
import { DEFAULT_MAX_ATTEMPTS } from "../work/queue";

/*
 * The person's tasks: work OpenDuet does in the background, each in a conversation of its own, so
 * Chat stays one thread. Chat shows a card that opens the task; the task page is its conversation,
 * where the person can reply to steer it; Tasks lists them.
 *
 * WHAT A TASK IS DOING IS READ, NEVER STORED. The work queue already knows whether the task's turn is
 * queued or running, the approval inbox whether it stopped for Allow once, and the question queue
 * whether its Bot asked the person something. Copying any of that onto the task would be a second
 * ledger that drifts from the first the moment one of them changes without it. The one thing only
 * the person can say, that they are done with it, is the one thing kept: `resolvedAt`.
 */

export type { OpenDuetTaskOrigin as TaskOrigin };

/**
 * Where a task stands, worked out on every read, first match wins:
 * - `needs_input`: an approval or a question in its conversation waits on the person;
 * - `working`: its turn is queued or running, or an answered approval is being carried on;
 * - `resolved`: the person marked it done;
 * - `ready_for_review`: none of those, so there is something to read.
 */
export type TaskStatus =
  | "needs_input"
  | "working"
  | "resolved"
  | "ready_for_review";

export type TaskRecord = {
  id: string;
  botId: string;
  /** The task's own conversation. */
  channelId: string;
  /**
   * That conversation's thread, which an approval or a question raised in it names. Null when the
   * conversation is gone, and on the record `create` returns.
   */
  threadId: string | null;
  title: string;
  why: string | null;
  origin: OpenDuetTaskOrigin;
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  status: TaskStatus;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewTask = {
  ownerUserId: string;
  botId: string;
  channelId: string;
  title: string;
  why: string | null;
  origin: OpenDuetTaskOrigin;
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
};

export class TaskNotFoundError extends Error {
  constructor() {
    super("Couldn't find that task.");
    this.name = "TaskNotFoundError";
  }
}

/** The rule above, on its own, so it can be read and tested without a database. */
export function taskStatus(state: {
  resolved: boolean;
  needsInput: boolean;
  working: boolean;
}): TaskStatus {
  if (state.needsInput) return "needs_input";
  if (state.working) return "working";
  if (state.resolved) return "resolved";
  return "ready_for_review";
}

type Row = typeof openduetTasks.$inferSelect;
/** What a task's conversation is doing, and its thread, as one read of the ledgers found them. */
type TaskState = {
  needsInput: boolean;
  working: boolean;
  threadId: string | null;
};

/** A JSON field of a work item's payload, as text. */
const payload = (field: string) => sql<string>`${workItems.payload}->>${field}`;
/** The conversation an approval was raised in, as text. */
const approvalThread = sql<string>`${approvalRequests.action}->>'threadId'`;

export type TaskStore = ReturnType<typeof createTaskStore>;

/** Every read and write is the owner's: another person's task is the same as no task. */
export function createTaskStore(
  database: Database,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const owned = (owner: string, id: string) =>
    and(eq(openduetTasks.ownerUserId, owner), eq(openduetTasks.id, id));

  /**
   * What each task is doing, from the ledgers that say so. A handful of queries for the whole list,
   * whatever its length, each narrowed to the person first.
   */
  async function stateOf(
    owner: string,
    rows: readonly Row[],
  ): Promise<Map<string, TaskState>> {
    const state = new Map<string, TaskState>(
      rows.map((row) => [
        row.id,
        { needsInput: false, working: false, threadId: null },
      ]),
    );
    if (rows.length === 0) return state;
    const channelIds = rows.map((row) => row.channelId);
    const threads = await database
      .select({
        channelId: intelligenceChannelMappings.channelId,
        threadId: intelligenceChannelMappings.threadId,
      })
      .from(intelligenceChannelMappings)
      .where(
        and(
          eq(intelligenceChannelMappings.userId, owner),
          inArray(intelligenceChannelMappings.channelId, channelIds),
        ),
      );
    const channelOfThread = new Map(
      threads.map((row) => [row.threadId, row.channelId]),
    );
    const threadIds = [...channelOfThread.keys()];
    const taskOfChannel = new Map(rows.map((row) => [row.channelId, row.id]));
    for (const row of threads) {
      const taskId = taskOfChannel.get(row.channelId);
      const entry = taskId ? state.get(taskId) : undefined;
      if (entry) entry.threadId = row.threadId;
    }
    const mark = (
      channelId: string | null | undefined,
      field: "needsInput" | "working",
    ) => {
      const taskId = channelId ? taskOfChannel.get(channelId) : undefined;
      const entry = taskId ? state.get(taskId) : undefined;
      if (entry) entry[field] = true;
    };
    const inThreads = (expression: SQL) =>
      threadIds.length > 0 ? inArray(expression, threadIds) : sql`false`;

    // Waiting on the person: an action its turn paused on for Allow once, or a question it asked.
    const [approvals, questions] = await Promise.all([
      database
        .select({ threadId: approvalThread })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, owner),
            eq(approvalRequests.status, "pending"),
            inThreads(approvalThread),
          ),
        ),
      database
        .select({
          channelId: payload("channelId"),
          threadId: payload("threadId"),
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "person.question"),
            isNull(workItems.finishedAt),
            sql`${payload("actorId")} = ${owner}`,
            or(
              inArray(payload("channelId"), channelIds),
              inThreads(payload("threadId")),
            ),
          ),
        ),
    ]);
    for (const row of approvals)
      mark(channelOfThread.get(row.threadId), "needsInput");
    for (const row of questions)
      mark(
        row.channelId ?? channelOfThread.get(row.threadId ?? ""),
        "needsInput",
      );

    /*
     * Working: its own turn waiting to be picked up or held by a live lease, or an approval the
     * person answered being carried on into the conversation. A turn that failed and was let go is
     * neither, so a task never reads Working for ever. The turn is the proactive engine's to run,
     * queued under its kind (proactive/engine.ts).
     */
    const [turns, resuming] = await Promise.all([
      database
        .select({ taskId: payload("taskId") })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            isNull(workItems.finishedAt),
            inArray(
              payload("taskId"),
              rows.map((row) => row.id),
            ),
            sql`(${workItems.attempts} = 0 or ${workItems.leaseUntil} > now())`,
          ),
        ),
      database
        .select({ threadId: approvalThread })
        .from(workItems)
        .innerJoin(
          approvalRequests,
          eq(approvalRequests.id, payload("approvalId")),
        )
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            isNull(workItems.finishedAt),
            eq(approvalRequests.ownerUserId, owner),
            inThreads(approvalThread),
            sql`(${workItems.attempts} < ${DEFAULT_MAX_ATTEMPTS} or ${workItems.leaseUntil} > now())`,
          ),
        ),
    ]);
    for (const row of turns) {
      const entry = state.get(row.taskId);
      if (entry) entry.working = true;
    }
    for (const row of resuming)
      mark(channelOfThread.get(row.threadId), "working");
    return state;
  }

  function recordOf(row: Row, state: TaskState | undefined): TaskRecord {
    return {
      id: row.id,
      botId: row.botId,
      channelId: row.channelId,
      threadId: state?.threadId ?? null,
      title: row.title,
      why: row.why,
      origin: row.origin,
      suggestionId: row.suggestionId,
      sourceApp: row.sourceApp,
      sourceLink: row.sourceLink,
      status: taskStatus({
        resolved: row.resolvedAt !== null,
        needsInput: state?.needsInput ?? false,
        working: state?.working ?? false,
      }),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function withState(owner: string, rows: Row[]) {
    const state = await stateOf(owner, rows);
    return rows.map((row) => recordOf(row, state.get(row.id)));
  }

  async function one(owner: string, id: string): Promise<TaskRecord> {
    const [row] = await database
      .select()
      .from(openduetTasks)
      .where(owned(owner, id))
      .limit(1);
    if (!row) throw new TaskNotFoundError();
    const [record] = await withState(owner, [row]);
    if (!record) throw new TaskNotFoundError();
    return record;
  }

  async function setResolved(owner: string, id: string, resolved: boolean) {
    const at = now();
    const [row] = await database
      .update(openduetTasks)
      .set({ resolvedAt: resolved ? at : null, updatedAt: at })
      .where(owned(owner, id))
      .returning({ id: openduetTasks.id });
    if (!row) throw new TaskNotFoundError();
    return one(owner, id);
  }

  return {
    async create(input: NewTask): Promise<TaskRecord> {
      const at = now();
      const [row] = await database
        .insert(openduetTasks)
        .values({ id: randomUUID(), ...input, createdAt: at, updatedAt: at })
        .returning();
      if (!row) throw new Error("The task was not saved.");
      return recordOf(row, undefined);
    },
    /** The owner's tasks, newest first. No cap on how many there are; a page is what a list shows. */
    async list(owner: string, limit = 200): Promise<TaskRecord[]> {
      const rows = await database
        .select()
        .from(openduetTasks)
        .where(eq(openduetTasks.ownerUserId, owner))
        .orderBy(desc(openduetTasks.createdAt), desc(openduetTasks.id))
        .limit(limit);
      return withState(owner, rows);
    },
    get: one,
    /** Whether this conversation of the person's is a task's own. */
    async isTaskConversation(owner: string, channelId: string) {
      const [row] = await database
        .select({ id: openduetTasks.id })
        .from(openduetTasks)
        .where(
          and(
            eq(openduetTasks.ownerUserId, owner),
            eq(openduetTasks.channelId, channelId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
    /** Where a task lives, without working out what it is doing: for running its turn. */
    async locate(
      owner: string,
      id: string,
    ): Promise<{ channelId: string; botId: string } | null> {
      const [row] = await database
        .select({
          channelId: openduetTasks.channelId,
          botId: openduetTasks.botId,
        })
        .from(openduetTasks)
        .where(owned(owner, id))
        .limit(1);
      return row ?? null;
    },
    /** The person is done with it. Its conversation stays, and Reopen brings it back. */
    resolve: (owner: string, id: string) => setResolved(owner, id, true),
    reopen: (owner: string, id: string) => setResolved(owner, id, false),
  };
}

/**
 * How a person adds a task themselves, from the + on Tasks: start it now, as `start_task` would from
 * Chat, or save it for Up next, as `add_tasks` does. The server's assembly provides both; see
 * wiring.ts.
 */
export type TaskIntake = {
  start(
    ownerUserId: string,
    botId: string,
    task: { title: string; instruction: string },
  ): Promise<{ id: string }>;
  save(
    ownerUserId: string,
    botId: string,
    card: { title: string; detail: string },
  ): Promise<{ id: string; title: string }>;
};

/** The longest ask the + takes, as `start_task` takes. */
export const MAX_ASK = 4000;
/** How long a title made from the ask gets before it is cut at a word. */
const TITLE_LENGTH = 80;

/**
 * A task's title from the person's ask when they gave none: the first sentence of its first line,
 * with its full stop dropped, cut at a word with an ellipsis past `TITLE_LENGTH`.
 */
export function titleFrom(ask: string): string {
  const line =
    ask
      .split("\n")
      .map((part) => part.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "";
  // A sentence ends at a stop followed by a capital: "Sam. He", but not "no. 5521" or "it... then".
  const sentence = line.split(/(?<=[^.][.!?])\s+(?=\p{Lu})/u)[0] ?? line;
  const plain = sentence.replace(/(?<!\.)\.$/, "");
  if (plain.length <= TITLE_LENGTH) return plain;
  const cut = plain.slice(0, TITLE_LENGTH);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

const askSchema = z
  .object({
    botId: z.string().trim().min(1).max(200),
    instruction: z.string().trim().min(1).max(MAX_ASK),
    title: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

class TaskRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRefusedError";
  }
}

/** The + sheet's ask, with its title worked out when the person gave none. */
async function readAsk(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new TaskRefusedError("Say what OpenDuet should do.");
  const parsed = askSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    throw new TaskRefusedError(
      parsed.error.issues.some((issue) => issue.path[0] === "instruction")
        ? `Say what OpenDuet should do, in at most ${MAX_ASK} characters.`
        : "Choose one of your Bots.",
    );
  const { botId, instruction } = parsed.data;
  return {
    botId,
    instruction,
    title: parsed.data.title ?? titleFrom(instruction),
  };
}

/** `/api/openduet/tasks`: the person's own tasks, as Chat's cards, the task page and Tasks read them. */
export function createTaskRoutes(
  store: TaskStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Absent, the + routes are not served: there is nowhere to start or save a task. */
  intake?: TaskIntake,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 16_384 }));
  routes.onError((error, context) => {
    if (error instanceof TaskNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof AgentNotFoundError)
      return context.json(
        { error: "Couldn't find that Bot. Reload the page." },
        404,
      );
    if (error instanceof TaskRefusedError)
      return context.json({ error: error.message }, 400);
    console.error(
      JSON.stringify({
        type: "openduet-tasks-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "Couldn't load your tasks. Try again." }, 503);
  });
  routes.get("/", async (context) =>
    context.json({ tasks: await store.list(context.var.actor.id) }),
  );
  if (intake) {
    /*
     * Start now: the ask opens a task in a conversation of its own and starts there, the path
     * `start_task` takes from Chat. Answers with the task as Tasks reads it.
     */
    routes.post("/", async (context) => {
      const owner = context.var.actor.id;
      const ask = await readAsk(context.req.raw);
      const opened = await intake.start(owner, ask.botId, {
        title: ask.title,
        instruction: ask.instruction,
      });
      return context.json({ task: await store.get(owner, opened.id) }, 201);
    });
    /*
     * Save for Up next: a card with Start and Hide, the path `add_tasks` takes, marked as one the
     * person asked for. The card's detail is the whole ask, unless the title already says all of it.
     */
    routes.post("/up-next", async (context) => {
      const ask = await readAsk(context.req.raw);
      const said = ask.instruction.replace(/\s+/g, " ").replace(/\.$/, "");
      const suggestion = await intake.save(context.var.actor.id, ask.botId, {
        title: ask.title,
        detail: said === ask.title ? "" : ask.instruction,
      });
      return context.json({ suggestion }, 201);
    });
  }
  routes.get("/:id", async (context) =>
    context.json({
      task: await store.get(context.var.actor.id, context.req.param("id")),
    }),
  );
  routes.post("/:id/resolve", async (context) =>
    context.json({
      task: await store.resolve(context.var.actor.id, context.req.param("id")),
    }),
  );
  routes.post("/:id/reopen", async (context) =>
    context.json({
      task: await store.reopen(context.var.actor.id, context.req.param("id")),
    }),
  );
  return routes;
}
