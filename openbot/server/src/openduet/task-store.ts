import { MAX_ATTACHMENTS_PER_MESSAGE } from "@openbot/shared/attachments";
import type { DurableTaskReply } from "@openbot/shared/task-reply";
import { sanitizeThumbnail } from "@openbot/shared/thumbnail";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AgentNotFoundError } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import {
  type PersonQuestion,
  questionResponseMessage,
  pendingPersonQuestion,
} from "../approvals/questions";
import type { Database } from "../db/client";
import {
  approvalRequests,
  channels,
  intelligenceChannelMappings,
  workItems,
} from "../db/schema";
import { type OpenDuetTaskOrigin, openduetTasks } from "../db/schema/openduet";
import {
  PROACTIVE_TASK_KIND,
  replyEnding,
  replyTail,
  TASK_RUNS,
  type TaskInput,
  taskInputSchema,
} from "../proactive/engine";
import { ProactiveRefusedError } from "../proactive/types";
import { DEFAULT_MAX_ATTEMPTS } from "../work/queue";
import type { TaskReportReader } from "./task-report";

/*
 * The person's tasks: work OpenDuet does in the background, each in a conversation of its own, so
 * Chat stays one thread. Chat shows a card that opens the task; the task page is its conversation,
 * where the person can reply to steer it; Tasks lists them.
 *
 * WHAT A TASK IS DOING IS READ, NEVER STORED. The work queue already knows whether the task's turn is
 * queued or running, the approval inbox whether it stopped for Allow once, and the question queue
 * whether its Bot asked the person something. Copying any of that onto the task would be a second
 * ledger that drifts from the first the moment one of them changes without it. The one thing only
 * the person can say, that they are done with it, is the one thing kept: `resolvedAt`. It covers
 * work accepted by then; a later durable turn supersedes it, without a separate reopening write.
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
 * - `working`: its turn is queued, running, or due its one retry, or an answered approval or question
 *   is being carried on;
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
  thumbnail?: string | null;
  queuedReplies?: { messageId: string; text: string }[];
  /** Questions the person already answered in accepted replies, even if their turns failed. */
  answeredQuestionIds?: string[];
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
  /** The OpenDuet channel it was asked for in, or null for Everything. */
  fromChannelId: string | null;
  status: TaskStatus;
  /**
   * Why its turn couldn't finish, in plain words, while it is `failed`, or marked done after failing.
   * Null otherwise.
   */
  failure: string | null;
  /** When it failed, alongside `failure`. */
  failedAt: string | null;
  /**
   * The run's own next step, one line, for Tasks: the last sentence or question of the Bot's newest
   * words in its conversation, or the person's own words in quotes while their reply is being
   * worked on. Null before anything has been said there.
   */
  next: string | null;
  /** Null once durable work accepted after the person's last completion supersedes it. */
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewTask = {
  thumbnail?: string | null;
  ownerUserId: string;
  botId: string;
  channelId: string;
  title: string;
  why: string | null;
  origin: OpenDuetTaskOrigin;
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  /** Absent or null: asked for in Everything. */
  fromChannelId?: string | null;
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
/** A turn whose last run a crash or restart cut off. */
const CUT_OFF = "the run was cut off partway through";
/** A task whose turn never reached the queue. */
const NEVER_STARTED = "it never started";

/**
 * Why a task's turn couldn't finish, in words that read right after both the row's "Couldn't
 * finish:" and the Bot's own "I couldn't finish this:", so never the Bot in the third person. Never
 * the error itself: that is an operator's, kept on the queue's row, and can be a status code, a
 * JSON body or a stack. Anything not recognised here is said generically.
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
    [/no longer available/i, "this conversation is gone"],
    [/nothing to start/i, "there was nothing to start"],
    [/before (it|retries) could/i, "it failed before it could be tried again"],
    [/\bpaused\b/i, "work is paused"],
    [/allowed model/i, "the model isn't allowed here"],
    [/lock/i, "the conversation was busy with another reply"],
    [/cancel|abort/i, "the run was stopped"],
    [
      /\b40[13]\b|authentication|api.?key/i,
      "the model provider turned the request away",
    ],
    [
      /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|unavailable|overloaded|\b50[234]\b/i,
      "a service didn't answer",
    ],
  ];
  return (
    rules.find(([pattern]) => pattern.test(error))?.[1] ??
    "something went wrong during the run"
  );
}

type Row = typeof openduetTasks.$inferSelect;
/** What a task's conversation is doing, and its thread, as one read of the ledgers found them. */
type TaskState = {
  /** The person's completion, unless genuinely new durable work superseded it. */
  resolvedAt: Date | null;
  /** The same effective turn supplies both the visible outcome and Try again's complete input. */
  turnInput: Record<string, unknown> | null;
  /** Explicit task turns, for Try again's durable key (legacy suggestion turns had no task id). */
  turns: number;
  queuedReplies: { messageId: string; text: string }[];
  answeredQuestionIds: Set<string>;
  needsInput: boolean;
  working: boolean;
  threadId: string | null;
  /** The plain reason, when its turn ran out of runs, and when. */
  failure: string | null;
  failedAt: Date | null;
  /** See `TaskRecord.next`. */
  next: string | null;
};

/** How long the person's own words may run as a task's next step. */
const QUOTE_MAX = 120;

/**
 * A task's next step, from the last line said in its conversation: the Bot's words end on what comes
 * next (`replyTail`); the person's are what the Bot is now working on, quoted.
 */
export function nextStepOf(
  said: string | null | undefined,
  byBot: boolean,
): string | null {
  const text = said?.trim();
  if (!text) return null;
  if (byBot) return replyTail(text);
  const words = Array.from(text);
  return `“${words.length > QUOTE_MAX ? `${words.slice(0, QUOTE_MAX - 1).join("")}…` : text}”`;
}

/** A JSON field of a work item's payload, as text. */
const payload = (field: string) => sql<string>`${workItems.payload}->>${field}`;
/** The conversation an approval was raised in, as text. */
const approvalThread = sql<string>`${approvalRequests.action}->>'threadId'`;

export type TaskStore = ReturnType<typeof createTaskStore>;
type TaskTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

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
        {
          resolvedAt: row.resolvedAt,
          turnInput: null,
          turns: 0,
          queuedReplies: [],
          answeredQuestionIds: new Set<string>(),
          needsInput: false,
          working: false,
          threadId: null,
          failure: null,
          failedAt: null,
          next: null,
        },
      ]),
    );
    if (rows.length === 0) return state;
    const channelIds = rows.map((row) => row.channelId);
    // The last line said in each task's conversation, for its next step.
    const lastSaid = await database
      .select({
        id: channels.id,
        lastMessage: channels.lastMessage,
        byBot: sql<boolean>`${channels.lastMessageAgentId} is not null`,
        sourceId: channels.lastMessageSourceId,
        needsInput: channels.lastMessageNeedsInput,
        afterResolution: sql<boolean>`coalesce(${channels.lastMessageAt} > ${openduetTasks.resolvedAt}, true)`,
      })
      .from(channels)
      .innerJoin(openduetTasks, eq(openduetTasks.channelId, channels.id))
      .where(inArray(channels.id, channelIds));
    const taskOfChannelId = new Map(rows.map((row) => [row.channelId, row.id]));
    for (const said of lastSaid) {
      const entry = state.get(taskOfChannelId.get(said.id) ?? "");
      // The ask a turn starts on is the task itself, not a step: "Just started" says that better.
      const ask = !said.byBot && (said.sourceId?.endsWith(":input") ?? false);
      if (entry && !ask) entry.next = nextStepOf(said.lastMessage, said.byBot);
    }
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
          key: workItems.key,
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

    /*
     * Its turns, in creation order for the queued reply list. The effective outcome follows when
     * each turn finished or failed: an older insert may commit and run after a newer turn finished.
     * The proactive engine owns task turns; an older one may name its suggestion. Question-card
     * answers are continuations in the same conversation, owned by the person-response worker.
     */
    const suggestionIds = rows.flatMap((row) =>
      row.suggestionId ? [row.suggestionId] : [],
    );
    // The same ledger timestamps order task executions and question-card continuations.
    const turnState = {
      key: workItems.key,
      acceptedAt: sql`extract(epoch from ${workItems.createdAt})`.mapWith(
        Number,
      ),
      // Compare in SQL so a same-millisecond acceptance still follows the exact completion.
      afterResolution: sql<boolean>`coalesce(${workItems.createdAt} > ${openduetTasks.resolvedAt}, false)`,
      // A crash fails at lease expiry, not its last heartbeat. Finished rows use their actual
      // completion; released rows use the release timestamp. Keep PostgreSQL's sub-ms order.
      outcomeAt: sql`extract(epoch from coalesce(
        ${workItems.finishedAt},
        case when ${workItems.claimedBy} is not null then ${workItems.leaseUntil} end,
        ${workItems.updatedAt}
      ))`.mapWith(Number),
      attempts: workItems.attempts,
      live: sql<boolean>`coalesce(${workItems.leaseUntil} > now(), false)`,
      finished: sql<boolean>`${workItems.finishedAt} is not null`,
      lastError: workItems.lastError,
      claimed: sql<boolean>`${workItems.claimedBy} is not null`,
      updatedAt: workItems.updatedAt,
      leaseUntil: workItems.leaseUntil,
    };
    const responseQuestion = sql<PersonQuestion>`${workItems.payload}->'question'`;
    const responseThread = sql<string>`${responseQuestion}->>'threadId'`;
    const responseChannel = sql<string>`${responseQuestion}->>'channelId'`;
    const [turns, resuming, responses] = await Promise.all([
      database
        .select({
          ...turnState,
          input: workItems.payload,
          reply: payload("reply"),
          followup: payload("followup"),
          questionIds: sql<
            string[] | null
          >`${workItems.payload}->'questionIds'`,
          messageId: payload("messageId"),
          taskId: payload("taskId"),
          suggestionId: payload("suggestionId"),
        })
        .from(workItems)
        .leftJoin(openduetTasks, eq(openduetTasks.id, payload("taskId")))
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
        .orderBy(desc(workItems.createdAt), desc(workItems.key)),
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
      database
        .select({
          ...turnState,
          taskId: openduetTasks.id,
          question: responseQuestion,
          response: payload("response"),
        })
        .from(workItems)
        .innerJoin(
          intelligenceChannelMappings,
          and(
            eq(intelligenceChannelMappings.userId, owner),
            eq(intelligenceChannelMappings.threadId, responseThread),
          ),
        )
        .innerJoin(
          openduetTasks,
          and(
            eq(openduetTasks.ownerUserId, owner),
            eq(openduetTasks.channelId, intelligenceChannelMappings.channelId),
          ),
        )
        .where(
          and(
            eq(workItems.kind, "person.response"),
            sql`${payload("ownerUserId")} = ${owner}`,
            sql`${responseQuestion}->>'actorId' = ${owner}`,
            inArray(
              openduetTasks.id,
              rows.map((row) => row.id),
            ),
            or(
              isNull(responseChannel),
              eq(responseChannel, openduetTasks.channelId),
            ),
          ),
        ),
    ]);
    const taskOfSuggestion = new Map(
      rows.flatMap((row) =>
        row.suggestionId ? [[row.suggestionId, row.id] as const] : [],
      ),
    );
    const taskTurns = [
      ...turns.map((turn) => ({
        ...turn,
        explicit: true,
        maxAttempts: TASK_RUNS,
      })),
      ...responses.map(({ question, response, ...turn }) => {
        const message = questionResponseMessage(
          question,
          response,
          `person-response:${turn.key}`,
        );
        return {
          ...turn,
          explicit: false,
          // The person-response worker accepts one attempt, unlike proactive task executions.
          maxAttempts: 1,
          suggestionId: null,
          followup: "true",
          reply: response,
          messageId: message.id,
          questionIds: [turn.key],
          input: {
            text: message.content,
            followup: true,
            questionIds: [turn.key],
            inputId: message.id,
            reply: response,
          },
        };
      }),
    ].sort((a, b) => b.acceptedAt - a.acceptedAt || b.key.localeCompare(a.key));
    const latestOutcome = new Map<string, (typeof taskTurns)[number]>();
    const unfinished = new Map<string, (typeof taskTurns)[number]>();
    for (const turn of taskTurns) {
      const taskId =
        turn.taskId ?? taskOfSuggestion.get(turn.suggestionId ?? "");
      // Acceptance answers only the captured questions. Keep that fact across exhausted turns
      // and historical Try again turns that did not carry the original reply's snapshot.
      if (taskId && turn.followup === "true")
        for (const id of turn.questionIds ?? [])
          state.get(taskId)?.answeredQuestionIds.add(id);
      if (taskId) {
        const entry = state.get(taskId);
        if (entry && turn.taskId) {
          if (turn.explicit) entry.turns += 1;
          if (turn.afterResolution) entry.resolvedAt = null;
        }
        const latest = latestOutcome.get(taskId);
        // Ties retain creation/key order, but insertion order never hides a later terminal turn.
        if (!latest || turn.outcomeAt > latest.outcomeAt)
          latestOutcome.set(taskId, turn);
      }
      if (
        taskId &&
        !turn.finished &&
        (turn.live || turn.attempts < turn.maxAttempts) &&
        !unfinished.has(taskId)
      )
        unfinished.set(taskId, turn);
      if (
        taskId &&
        turn.reply &&
        turn.messageId &&
        !turn.finished &&
        !turn.live &&
        turn.attempts < turn.maxAttempts
      )
        state.get(taskId)?.queuedReplies.unshift({
          messageId: turn.messageId,
          text: turn.reply,
        });
    }
    for (const question of questions) {
      const channelId =
        question.channelId ?? channelOfThread.get(question.threadId ?? "");
      const taskId = channelId ? taskOfChannel.get(channelId) : undefined;
      if (!taskId || !state.get(taskId)?.answeredQuestionIds.has(question.key))
        mark(channelId, "needsInput");
    }
    const at = now().getTime();
    for (const row of rows) {
      const entry = state.get(row.id);
      if (!entry) continue;
      // Any queued/live turn takes priority, including one whose older insert committed late.
      const turn = unfinished.get(row.id) ?? latestOutcome.get(row.id);
      entry.turnInput = turn?.input ?? null;
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
       * Working while queued, running, or below its worker's attempt cap after a throw or restart.
       * Question-card answers have one attempt; proactive task turns have two.
       */
      if (turn.live || turn.attempts < turn.maxAttempts) {
        entry.working = true;
        continue;
      }
      /*
       * It stays failed until a turn of its own finishes. Anything else said in its conversation
       * since is not that turn: the task page sends a reply on a failed task as Try again.
       *
       * Still claimed means its last run was cut off, not let go after a throw, whatever error an
       * earlier run left on the row; it failed when that lease ran out.
       */
      const cutOff = turn.claimed && turn.leaseUntil !== null;
      entry.failure = plainFailure(cutOff ? null : turn.lastError);
      entry.failedAt =
        cutOff && turn.leaseUntil ? turn.leaseUntil : turn.updatedAt;
    }
    for (const row of resuming)
      mark(channelOfThread.get(row.threadId), "working");
    for (const said of lastSaid) {
      const taskId = taskOfChannelId.get(said.id);
      const entry = state.get(taskId ?? "");
      if (
        entry &&
        said.byBot &&
        (said.needsInput ?? replyEnding(said.lastMessage).asks) &&
        !entry.working &&
        !entry.failure &&
        !entry.resolvedAt &&
        // New work must not resurrect a final question the person already dismissed.
        said.afterResolution
      )
        entry.needsInput = true;
    }
    return state;
  }

  function recordOf(row: Row, state: TaskState | undefined): TaskRecord {
    const resolvedAt = state ? state.resolvedAt : row.resolvedAt;
    const status = taskStatus({
      resolved: resolvedAt !== null,
      needsInput: state?.needsInput ?? false,
      working: state?.working ?? false,
      failed: (state?.failure ?? null) !== null,
    });
    const failedOrDone = status === "failed" || status === "resolved";
    return {
      id: row.id,
      thumbnail: row.thumbnail,
      queuedReplies: state?.queuedReplies ?? [],
      answeredQuestionIds: [...(state?.answeredQuestionIds ?? [])],
      botId: row.botId,
      channelId: row.channelId,
      threadId: state?.threadId ?? null,
      title: row.title,
      why: row.why,
      origin: row.origin,
      suggestionId: row.suggestionId,
      sourceApp: row.sourceApp,
      sourceLink: row.sourceLink,
      fromChannelId: row.fromChannelId,
      status,
      // Kept while it is marked done, too: Reopen brings the failure back, and so may a reply.
      failure: failedOrDone ? (state?.failure ?? null) : null,
      failedAt: failedOrDone ? (state?.failedAt?.toISOString() ?? null) : null,
      next: state?.next ?? null,
      resolvedAt: resolvedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function withState(owner: string, rows: Row[]) {
    const state = await stateOf(owner, rows);
    return rows.map((row) => recordOf(row, state.get(row.id)));
  }

  async function oneWithState(owner: string, id: string) {
    const [row] = await database
      .select()
      .from(openduetTasks)
      .where(owned(owner, id))
      .limit(1);
    if (!row) throw new TaskNotFoundError();
    const state = (await stateOf(owner, [row])).get(id);
    if (!state) throw new TaskNotFoundError();
    return { record: recordOf(row, state), state };
  }

  async function one(owner: string, id: string): Promise<TaskRecord> {
    return (await oneWithState(owner, id)).record;
  }

  async function setResolved(owner: string, id: string, resolved: boolean) {
    // The same clock and precision as durable acceptance, across every server replica.
    const at = sql`now()`;
    const [row] = await database
      .update(openduetTasks)
      .set({ resolvedAt: resolved ? at : null, updatedAt: at })
      .where(owned(owner, id))
      .returning({ id: openduetTasks.id });
    if (!row) throw new TaskNotFoundError();
    return one(owner, id);
  }

  return {
    /** Share the channel's transaction so neither half can become visible on its own. */
    async create(
      input: NewTask,
      executor: Database | TaskTransaction = database,
    ): Promise<TaskRecord> {
      const at = now();
      const [row] = await executor
        .insert(openduetTasks)
        .values({
          id: randomUUID(),
          ...input,
          thumbnail: sanitizeThumbnail(input.thumbnail),
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (!row) throw new Error("The task was not saved.");
      return recordOf(row, undefined);
    },
    async pendingQuestions(owner: string, id: string): Promise<string[]> {
      const task = await one(owner, id);
      const rows = await database
        .select({ key: workItems.key })
        .from(workItems)
        .where(
          and(
            pendingPersonQuestion(owner),
            sql`${workItems.payload}->>'mode' = 'completed_question'`,
            or(
              sql`${workItems.payload}->>'channelId' = ${task.channelId}`,
              task.threadId
                ? sql`${workItems.payload}->>'threadId' = ${task.threadId}`
                : sql`false`,
            ),
          ),
        );
      return rows.map((row) => row.key);
    },
    async answerQuestions(
      owner: string,
      ids: readonly string[],
    ): Promise<void> {
      if (!ids.length) return;
      await database
        .update(workItems)
        .set({ finishedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(workItems.kind, "person.question"),
            inArray(workItems.key, [...ids]),
            sql`${workItems.payload}->>'actorId' = ${owner}`,
            isNull(workItems.finishedAt),
          ),
        );
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
     * the ask its effective failed turn carried, or, for one never queued, its suggestion or
     * its title. Refused unless it failed, so Try again never starts a second run beside a live one.
     *
     * A task marked done after it failed is taken too. Its completion is superseded only when
     * the retry is durably accepted; selecting the input leaves that completion intact.
     */
    async failedTurn(
      owner: string,
      id: string,
    ): Promise<{
      ask: TaskInput;
      turns: number;
    }> {
      const { record: task, state } = await oneWithState(owner, id);
      const failed =
        task.status === "failed" ||
        (task.status === "resolved" && task.failure !== null);
      if (!failed)
        throw new ProactiveRefusedError(
          "Only a task that couldn't finish can be tried again.",
        );
      const input = taskInputSchema.parse(state.turnInput ?? {});
      const suggestionId = input.suggestionId ?? task.suggestionId;
      // Empty text is intentional for a file-only reply. Only a missing ask uses the fallback.
      const ask =
        input.text !== undefined
          ? input
          : {
              ...input,
              ...(suggestionId ? { suggestionId } : { text: task.title }),
            };
      return { ask, turns: state.turns };
    },
    /** The person is done with it. Its conversation stays, and Reopen brings it back. */
    resolve: (owner: string, id: string) => setResolved(owner, id, true),
    reopen: (owner: string, id: string) => setResolved(owner, id, false),
  };
}

/** What a reply on a failed task carries: the person's words, and the id their message is drawn under. */
export type TaskReply = { reply?: string; messageId?: string };

/** Runs a failed task's turn again, with the person's reply when there is one: the engine's `again`. */
export type TaskRetry = {
  reply?: (
    owner: string,
    taskId: string,
    input: DurableTaskReply,
  ) => Promise<unknown>;
  again(
    ownerUserId: string,
    taskId: string,
    input?: TaskReply,
  ): Promise<unknown>;
};

/** The longest reply that goes with Try again. */
const MAX_REPLY = 4000;
const againSchema = z
  .object({
    reply: z.string().trim().max(MAX_REPLY).optional(),
    /**
     * The id the browser drew the reply under, so the message the run records is the same one and
     * the reply is not drawn twice.
     */
    messageId: z
      .string()
      .regex(/^[A-Za-z0-9-]{8,64}$/)
      .optional(),
  })
  .strict();

/** Ordinary replies retain files and skills; failed-task Try again stays words-only. */
const replySchema = againSchema
  .extend({
    reply: z.string().trim().max(MAX_REPLY).default(""),
    messageId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    attachmentIds: z
      .array(z.uuid())
      .max(MAX_ATTACHMENTS_PER_MESSAGE)
      .optional(),
    skillIds: z.array(z.string().min(1).max(200)).max(32).optional(),
  })
  .refine(
    (input) => input.reply.length > 0 || (input.attachmentIds?.length ?? 0) > 0,
  );

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
  /** Absent, Try again is not served. */
  retry?: TaskRetry,
  /** Absent, the + routes are not served: there is nowhere to start or save a task. */
  intake?: TaskIntake,
  /** Absent, a task's report is not served: there is no conversation history to read it from. */
  report?: TaskReportReader,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 16_384 }));
  routes.onError((error, context) => {
    if (error instanceof TaskNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof ProactiveRefusedError)
      return context.json({ error: error.message }, 409);
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
  if (report) {
    /*
     * The task page's report: decisions, updates and what it read, worked out from its conversation
     * on every read (openduet/task-report.ts). Another person's task is the same as no task.
     */
    routes.get("/:id/report", async (context) => {
      const owner = context.var.actor.id;
      const task = await store.get(owner, context.req.param("id"));
      try {
        return context.json({ report: await report(owner, task) });
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "openduet-task-report-error",
            error: error instanceof Error ? error.name : "unknown",
            timestamp: new Date().toISOString(),
          }),
        );
        return context.json(
          { error: "Couldn't load this task's report. Try again." },
          503,
        );
      }
    });
  }
  const queueReply = retry?.reply;
  if (queueReply)
    routes.post("/:id/reply", async (context) => {
      const owner = context.var.actor.id;
      const id = context.req.param("id");
      const parsed = replySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success)
        return context.json(
          {
            error: `A reply of at most ${MAX_REPLY} characters or an attachment, and its message id, are required.`,
          },
          400,
        );
      await store.get(owner, id);
      await queueReply(owner, id, parsed.data);
      return context.json({ task: await store.get(owner, id) }, 202);
    });
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
  /*
   * Try again: the failed turn runs once more, in the task's own conversation. A reply typed on a
   * failed task comes here too, and goes with the ask, so the run has the task and the person's
   * words both.
   */
  if (retry)
    routes.post("/:id/again", async (context) => {
      const owner = context.var.actor.id;
      const id = context.req.param("id");
      const body = context.req
        .header("content-type")
        ?.includes("application/json")
        ? await context.req.json().catch(() => null)
        : {};
      const parsed = againSchema.safeParse(body ?? {});
      if (!parsed.success)
        return context.json(
          { error: `Say it in at most ${MAX_REPLY} characters.` },
          400,
        );
      await retry.again(owner, id, {
        ...(parsed.data.reply ? { reply: parsed.data.reply } : {}),
        ...(parsed.data.messageId ? { messageId: parsed.data.messageId } : {}),
      });
      return context.json({ task: await store.get(owner, id) });
    });
  return routes;
}
