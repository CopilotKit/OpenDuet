import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  approvalRequests,
  channels,
  intelligenceChannelMappings,
  workItems,
} from "../db/schema";
import { type OpenDuetTaskOrigin, openduetTasks } from "../db/schema/openduet";
import { PROACTIVE_TASK_KIND, TASK_RUNS } from "../proactive/engine";
import { ProactiveRefusedError } from "../proactive/types";
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
 *
 * FAILING IS READ THE SAME WAY. A task's turn runs at most twice (`TASK_RUNS`): once, and once more
 * if the first run threw or was cut off by a restart. A turn that has run out of runs stays on the
 * queue unfinished, with its count and its last error, which is the queue's own terminal state
 * (work/queue.ts). That row is the failure and its reason; nothing else records it.
 */

export type { OpenDuetTaskOrigin as TaskOrigin };

/**
 * Where a task stands, worked out on every read, first match wins:
 * - `needs_input`: an approval or a question in its conversation waits on the person;
 * - `working`: its turn is queued, running, or due its one retry, or an answered approval is being
 *   carried on;
 * - `resolved`: the person marked it done;
 * - `failed`: its turn ran out of runs without finishing, and nothing has happened in its
 *   conversation since;
 * - `ready_for_review`: its turn finished and wrote a reply.
 */
export type TaskStatus =
  | "needs_input"
  | "working"
  | "resolved"
  | "failed"
  | "ready_for_review";

export type TaskRecord = {
  id: string;
  botId: string;
  /** The task's own conversation. */
  channelId: string;
  title: string;
  why: string | null;
  origin: OpenDuetTaskOrigin;
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  status: TaskStatus;
  /** Why its turn couldn't finish, in plain words, while it is `failed`. Null otherwise. */
  failure: string | null;
  /** When it failed, while it is `failed`. Null otherwise. */
  failedAt: string | null;
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
  failed?: boolean;
}): TaskStatus {
  if (state.needsInput) return "needs_input";
  if (state.working) return "working";
  if (state.resolved) return "resolved";
  if (state.failed) return "failed";
  return "ready_for_review";
}

/** How long a task with no turn on the queue yet still reads as just started. */
const STARTING_MS = 60_000;
/** A turn the second run of which was cut off too, so the queue holds no error for it. */
const CUT_OFF = "the run was cut off partway through, twice";
/** A task whose turn never reached the queue. */
const NEVER_STARTED = "it never started";

/**
 * Why a task's turn couldn't finish, in words the person reads after "Couldn't finish:". Never the
 * error itself: that is an operator's, kept on the queue's row, and can be a status code, a JSON
 * body or a stack. Anything not recognised here is said generically.
 */
export function plainFailure(error: string | null | undefined): string {
  if (!error) return CUT_OFF;
  if (error === NEVER_STARTED) return NEVER_STARTED;
  const stopped = /stopped after (\d+)s/.exec(error);
  if (stopped) {
    const minutes = Math.max(1, Math.round(Number(stopped[1]) / 60));
    return `the run took longer than ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const rules: [RegExp, string][] = [
    [/finished without saying anything/i, "the run ended without a reply"],
    [/stopped to ask a question/i, "the run stopped to ask a question"],
    [/no longer available/i, "the Bot or its conversation is gone"],
    [/nothing to start/i, "there was nothing to start"],
    [/\bpaused\b/i, "the Bot is paused"],
    [/allowed model/i, "the Bot's model isn't allowed"],
    [/lock/i, "the conversation was busy with another reply"],
    [/cancel|abort/i, "the run was stopped"],
    [
      /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|unavailable|overloaded|\b50[234]\b/i,
      "a service it needed didn't answer",
    ],
  ];
  return (
    rules.find(([pattern]) => pattern.test(error))?.[1] ??
    "something went wrong during the run"
  );
}

type Row = typeof openduetTasks.$inferSelect;
type TaskState = {
  needsInput: boolean;
  working: boolean;
  /** The plain reason, when its turn ran out of runs, and when. */
  failure: string | null;
  failedAt: Date | null;
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
        { needsInput: false, working: false, failure: null, failedAt: null },
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
     * Its turns, newest first, and the conversation's last line. The newest turn is the one that
     * counts: Try again queues another beside the one that failed. The turn is the proactive
     * engine's to run, queued under its kind (proactive/engine.ts). A turn queued before tasks
     * existed names only its suggestion.
     */
    const suggestionIds = rows.flatMap((row) =>
      row.suggestionId ? [row.suggestionId] : [],
    );
    const [turns, lines, resuming] = await Promise.all([
      database
        .select({
          taskId: payload("taskId"),
          suggestionId: payload("suggestionId"),
          attempts: workItems.attempts,
          live: sql<boolean>`coalesce(${workItems.leaseUntil} > now(), false)`,
          finished: sql<boolean>`${workItems.finishedAt} is not null`,
          lastError: workItems.lastError,
          updatedAt: workItems.updatedAt,
          leaseUntil: workItems.leaseUntil,
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            or(
              inArray(
                payload("taskId"),
                rows.map((row) => row.id),
              ),
              suggestionIds.length > 0
                ? and(
                    sql`${payload("taskId")} is null`,
                    inArray(payload("suggestionId"), suggestionIds),
                  )
                : undefined,
            ),
          ),
        )
        .orderBy(desc(workItems.createdAt)),
      database
        .select({
          id: channels.id,
          sourceId: channels.lastMessageSourceId,
          agentId: channels.lastMessageAgentId,
        })
        .from(channels)
        .where(inArray(channels.id, channelIds)),
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
    const taskOfSuggestion = new Map(
      rows.flatMap((row) =>
        row.suggestionId ? [[row.suggestionId, row.id] as const] : [],
      ),
    );
    const newest = new Map<string, (typeof turns)[number]>();
    for (const turn of turns) {
      const taskId =
        turn.taskId ?? taskOfSuggestion.get(turn.suggestionId ?? "");
      if (taskId && !newest.has(taskId)) newest.set(taskId, turn);
    }
    const lineOf = new Map(lines.map((line) => [line.id, line]));
    const at = now().getTime();
    for (const row of rows) {
      const entry = state.get(row.id);
      if (!entry) continue;
      const turn = newest.get(row.id);
      if (!turn) {
        /*
         * Opened, and its turn not queued yet: the moment between the two writes that start a task.
         * Past that, it never will be, so it failed to start rather than reading Working for ever.
         */
        if (at - row.createdAt.getTime() < STARTING_MS) entry.working = true;
        else {
          entry.failure = plainFailure(NEVER_STARTED);
          entry.failedAt = new Date(row.createdAt.getTime() + STARTING_MS);
        }
        continue;
      }
      if (turn.finished) continue;
      /*
       * Working while it is queued, running, or due its one retry: a run that threw, or one a
       * restart cut off once its lease runs out. Out of runs and let go, it failed.
       */
      if (turn.live || turn.attempts < TASK_RUNS) {
        entry.working = true;
        continue;
      }
      /*
       * Unless the conversation moved on: the person replied in it from the browser and the Bot
       * answered there, which a server turn never records without a source.
       */
      const line = lineOf.get(row.channelId);
      if (line && line.sourceId === null && line.agentId !== null) continue;
      entry.failure = plainFailure(turn.lastError);
      // Let go after its last run threw, or, cut off, when its lease ran out.
      entry.failedAt =
        turn.leaseUntil && turn.leaseUntil > turn.updatedAt
          ? turn.leaseUntil
          : turn.updatedAt;
    }
    for (const row of resuming)
      mark(channelOfThread.get(row.threadId), "working");
    return state;
  }

  function recordOf(row: Row, state: TaskState | undefined): TaskRecord {
    const status = taskStatus({
      resolved: row.resolvedAt !== null,
      needsInput: state?.needsInput ?? false,
      working: state?.working ?? false,
      failed: (state?.failure ?? null) !== null,
    });
    return {
      id: row.id,
      botId: row.botId,
      channelId: row.channelId,
      title: row.title,
      why: row.why,
      origin: row.origin,
      suggestionId: row.suggestionId,
      sourceApp: row.sourceApp,
      sourceLink: row.sourceLink,
      status,
      failure: status === "failed" ? (state?.failure ?? null) : null,
      failedAt:
        status === "failed" ? (state?.failedAt?.toISOString() ?? null) : null,
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
    /**
     * What a failed task's turn was asked to do, to run it again, and how many turns it has had:
     * the ask its newest turn carried, or, for one that never reached the queue, its suggestion or
     * its title. Refused unless it failed, so Try again never starts a second run beside a live one.
     */
    async failedTurn(
      owner: string,
      id: string,
    ): Promise<{
      ask: { text?: string; suggestionId?: string };
      turns: number;
    }> {
      const task = await one(owner, id);
      if (task.status !== "failed")
        throw new ProactiveRefusedError(
          "Only a task that couldn't finish can be tried again.",
        );
      const turns = await database
        .select({
          text: payload("text"),
          suggestionId: payload("suggestionId"),
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            sql`${payload("taskId")} = ${id}`,
          ),
        )
        .orderBy(desc(workItems.createdAt));
      const [newest] = turns;
      const suggestionId = newest?.suggestionId ?? task.suggestionId;
      const ask = newest?.text
        ? { text: newest.text }
        : suggestionId
          ? { suggestionId }
          : { text: task.title };
      return { ask, turns: turns.length };
    },
    /** The person is done with it. Its conversation stays, and Reopen brings it back. */
    resolve: (owner: string, id: string) => setResolved(owner, id, true),
    reopen: (owner: string, id: string) => setResolved(owner, id, false),
  };
}

/** Runs a failed task's turn again: the proactive engine's `again`. */
export type TaskRetry = {
  again(ownerUserId: string, taskId: string): Promise<unknown>;
};

/** `/api/openduet/tasks`: the person's own tasks, as Chat's cards, the task page and Tasks read them. */
export function createTaskRoutes(
  store: TaskStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Absent, Try again is not served. */
  retry?: TaskRetry,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof TaskNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof ProactiveRefusedError)
      return context.json({ error: error.message }, 409);
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
  // Try again: the failed turn runs once more, in the task's own conversation.
  if (retry)
    routes.post("/:id/again", async (context) => {
      const owner = context.var.actor.id;
      const id = context.req.param("id");
      await retry.again(owner, id);
      return context.json({ task: await store.get(owner, id) });
    });
  return routes;
}
