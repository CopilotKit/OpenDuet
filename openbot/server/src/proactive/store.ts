import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import { approvalRequests } from "../db/schema/approvals";
import { auditEvents, intelligenceChannelMappings } from "../db/schema/core";
import {
  proactiveSettings,
  proactiveSuggestions,
} from "../db/schema/proactive";
import { workItems } from "../db/schema/work";
import { DEFAULT_MAX_ATTEMPTS } from "../work/queue";
import { lockDefaults, recordOptOut } from "../memory/defaults";
import { PROACTIVE_TASK_KIND, replyEnding, TASK_ATTEMPTS } from "./engine";
import { PROACTIVE_INITIATOR_PREFIX } from "./restriction";
import {
  ProactiveNotFoundError,
  ProactiveRefusedError,
  type ProactiveRunStatus,
  type ProactiveSetting,
  type ProactiveSuggestion,
  parseWith,
  proactiveSettingInputSchema,
  proactiveSettingPatchSchema,
  type StartedList,
  type StartedState,
  type StartedSuggestion,
  type TaskOutcome,
} from "./types";

/**
 * `start` marks the suggestion started, then queues its turn. A read between the two finds no
 * queue row; only one still missing after this long was never queued.
 */
const QUEUEING_GRACE_MS = 60_000;
/** How long after a turn finishes a question it asked can still be counted as its own. */
const ASKED_SLACK_MS = 15_000;
/** Written on a queue row made only to hold a check mark, for a turn that was never queued. */
const NEVER_QUEUED = "It was never queued.";

/**
 * What a started suggestion's work queue row carries, beyond who and which: what its turn ended
 * on, the check mark, and its conversation since. A person who answers it in that conversation sets
 * `answeredAt` and `answer`; the reply that follows, from their browser or from a decision being
 * carried out, sets `repliedAt` with a new `reply`.
 */
type TaskPayload = TaskOutcome & {
  resolvedAt?: string;
  answeredAt?: string;
  answer?: string;
  repliedAt?: string;
};

/** Approval states in which the conversation is still waiting on it, or still carrying it out. */
const LIVE_APPROVAL = ["pending", "approved", "denied", "consumed"] as const;

const timeOf = (iso: string | undefined) => (iso ? Date.parse(iso) : 0);
/**
 * How long an answer waits for its reply before it stops counting. The turn it started runs in the
 * person's browser, and a browser closed mid-turn never reports a reply.
 */
const ANSWER_REPLY_WAIT_MS = 5 * 60_000;
/** Answered in its conversation, and nothing has replied to that answer yet. */
const awaitingReply = (payload: TaskPayload) =>
  Boolean(payload.answeredAt) &&
  timeOf(payload.answeredAt) > timeOf(payload.repliedAt) &&
  Date.now() - timeOf(payload.answeredAt) < ANSWER_REPLY_WAIT_MS;
/** Ended on something the person has to say, in words. Older rows carry only their reply. */
const asksPerson = (payload: TaskPayload) =>
  payload.asks ?? Boolean(payload.reply?.endsWith("?"));

/**
 * The work queue payload with `remove` taken out and these fields written, built in SQL: a JSON
 * string parameter would be stored as a string.
 */
function patchPayload(
  fields: TaskOutcome & {
    repliedAt?: Date;
    answer?: { at: Date; text: string };
  },
  remove: readonly ("waiting" | "answeredAt" | "answer")[] = [],
) {
  const base = remove.reduce(
    (payload, key) => sql`${payload} - ${key}::text`,
    sql`${workItems.payload}`,
  );
  const parts = [
    ...("reply" in fields
      ? [sql`jsonb_build_object('reply', ${fields.reply ?? null}::text)`]
      : []),
    ...(fields.asks === undefined
      ? []
      : [sql`jsonb_build_object('asks', ${fields.asks}::boolean)`]),
    ...(fields.waiting
      ? [
          sql`jsonb_build_object('waiting', jsonb_build_object('kind', ${fields.waiting.kind}::text, 'id', ${fields.waiting.id}::text))`,
        ]
      : []),
    ...(fields.repliedAt
      ? [
          sql`jsonb_build_object('repliedAt', ${fields.repliedAt.toISOString()}::text)`,
        ]
      : []),
    ...(fields.answer
      ? [
          sql`jsonb_build_object('answeredAt', ${fields.answer.at.toISOString()}::text, 'answer', ${Array.from(fields.answer.text.trim()).slice(0, 160).join("")}::text)`,
        ]
      : []),
  ];
  return parts.length ? sql`${base} || ${sql.join(parts, sql` || `)}` : base;
}

/**
 * An answer to a question was carried on and its conversation replied: the started task that
 * asked takes the reply as where it now stands. The task that asked is the one waiting on that
 * question, or failing that the first task turn in its conversation to finish after it was asked:
 * task turns run one at a time. Called by the person-response sweep.
 */
export async function recordQuestionContinuation(
  database: Database,
  input: {
    ownerUserId: string;
    questionKey: string;
    replyText: string | null | undefined;
    /** The request the conversation stopped on next, when it did: the task now waits on that. */
    stoppedOn?: { kind: string; id: string };
  },
) {
  const [question] = await database
    .select({ createdAt: workItems.createdAt, payload: workItems.payload })
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, "person.question"),
        eq(workItems.key, input.questionKey),
      ),
    )
    .limit(1);
  if (!question) return;
  const channelId = String(question.payload.channelId ?? "");
  const tasks = await database
    .select({
      key: workItems.key,
      finishedAt: workItems.finishedAt,
      startedAt: proactiveSuggestions.resolvedAt,
      payload: workItems.payload,
    })
    .from(workItems)
    .innerJoin(proactiveSuggestions, eq(proactiveSuggestions.id, workItems.key))
    .innerJoin(
      proactiveSettings,
      eq(proactiveSettings.id, proactiveSuggestions.settingId),
    )
    .where(
      and(
        eq(workItems.kind, PROACTIVE_TASK_KIND),
        eq(proactiveSuggestions.ownerUserId, input.ownerUserId),
        eq(proactiveSettings.channelId, channelId),
        isNotNull(workItems.finishedAt),
      ),
    );
  const own = tasks.find(
    (task) => (task.payload as TaskPayload).waiting?.id === input.questionKey,
  );
  const asked = question.createdAt.getTime();
  const asker =
    own ??
    tasks
      .filter(
        (task) =>
          task.finishedAt &&
          (task.startedAt?.getTime() ?? 0) <= asked &&
          task.finishedAt.getTime() + ASKED_SLACK_MS >= asked,
      )
      .sort(
        (a, b) =>
          (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0),
      )
      .at(0);
  if (!asker) return;
  const ending = replyEnding(input.replyText);
  await database
    .update(workItems)
    .set({
      payload: patchPayload(
        input.stoppedOn
          ? { waiting: input.stoppedOn }
          : { reply: ending.tail, asks: ending.asks, repliedAt: new Date() },
        own || input.stoppedOn ? ["waiting"] : [],
      ),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(workItems.kind, PROACTIVE_TASK_KIND),
        eq(workItems.key, asker.key),
      ),
    );
}

/**
 * A decision was carried out and its conversation replied, or stopped on another request: the
 * started task waiting on that approval takes the reply as where it now stands, or waits on the
 * new request. Failing that, the task the person last answered in that conversation before the
 * approval was asked for takes it: their answer is what the approval came from. Called by the
 * approval resume sweep.
 */
export async function recordTaskContinuation(
  database: Database,
  input: {
    ownerUserId: string;
    approvalId: string;
    channelId: string | null;
    askedAt: Date;
    replyText: string | null | undefined;
    /** The request the conversation stopped on next, when it did: the task now waits on that. */
    stoppedOn?: { kind: string; id: string };
  },
) {
  const ending = replyEnding(input.replyText);
  const fields: Parameters<typeof patchPayload>[0] = input.stoppedOn
    ? { waiting: input.stoppedOn }
    : { reply: ending.tail, asks: ending.asks, repliedAt: new Date() };
  const [own] = await database
    .update(workItems)
    .set({ payload: patchPayload(fields, ["waiting"]), updatedAt: sql`now()` })
    .where(
      and(
        eq(workItems.kind, PROACTIVE_TASK_KIND),
        sql`${workItems.payload}->>'ownerUserId' = ${input.ownerUserId}`,
        sql`${workItems.payload}->'waiting'->>'id' = ${input.approvalId}`,
      ),
    )
    .returning({ key: workItems.key });
  if (own || !input.channelId) return;
  const answered = await database
    .select({ key: workItems.key, payload: workItems.payload })
    .from(workItems)
    .innerJoin(proactiveSuggestions, eq(proactiveSuggestions.id, workItems.key))
    .innerJoin(
      proactiveSettings,
      eq(proactiveSettings.id, proactiveSuggestions.settingId),
    )
    .where(
      and(
        eq(workItems.kind, PROACTIVE_TASK_KIND),
        eq(proactiveSuggestions.ownerUserId, input.ownerUserId),
        eq(proactiveSettings.channelId, input.channelId),
        sql`${workItems.payload}->>'answeredAt' is not null`,
      ),
    );
  const asker = answered
    .map((row) => ({ key: row.key, payload: row.payload as TaskPayload }))
    .filter((row) => timeOf(row.payload.answeredAt) <= input.askedAt.getTime())
    .sort((a, b) => timeOf(b.payload.answeredAt) - timeOf(a.payload.answeredAt))
    .at(0);
  if (!asker) return;
  await database
    .update(workItems)
    .set({
      payload: patchPayload(fields, input.stoppedOn ? ["waiting"] : []),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(workItems.kind, PROACTIVE_TASK_KIND),
        eq(workItems.key, asker.key),
      ),
    );
}

/**
 * Why a turn failed, in the words a person reads after "Couldn't finish:". The queue keeps the
 * runner's own message ("The routine's turn was stopped after 180s."), which is for logs.
 */
export function plainReason(error: string | null): string {
  if (!error) return "it was interrupted twice";
  if (error === NEVER_QUEUED) return "it never started";
  if (/stopped after|did not finish within|timed out/i.test(error))
    return "it ran out of time";
  if (/cancelled/i.test(error)) return "it was stopped";
  if (/no longer available/i.test(error))
    return "this Bot or its conversation is no longer available";
  if (/without saying anything/i.test(error)) return "it ended without a reply";
  if (/paused/i.test(error)) return "the Bot is paused";
  if (/waiting for (?:permission|your approval|another decision)/i.test(error))
    return "it needed another approval to carry on";
  return "something went wrong while it worked";
}

/** What a proactive run read, as the audit trail recorded it. The source of truth for provenance. */
export type ProactiveRead = { ref: string; at: Date };

export function createProactiveStore(database: Database) {
  const owned = (owner: string, id: string) =>
    and(eq(proactiveSettings.ownerUserId, owner), eq(proactiveSettings.id, id));
  async function get(owner: string, id: string): Promise<ProactiveSetting> {
    const [row] = await database
      .select()
      .from(proactiveSettings)
      .where(owned(owner, id))
      .limit(1);
    if (!row) throw new ProactiveNotFoundError();
    return row;
  }
  return {
    get,
    async byId(id: string): Promise<ProactiveSetting | null> {
      const [row] = await database
        .select()
        .from(proactiveSettings)
        .where(eq(proactiveSettings.id, id))
        .limit(1);
      return row ?? null;
    },
    async list(owner: string): Promise<ProactiveSetting[]> {
      return database
        .select()
        .from(proactiveSettings)
        .where(eq(proactiveSettings.ownerUserId, owner))
        .orderBy(desc(proactiveSettings.createdAt));
    },
    async create(
      owner: string,
      input: unknown,
      threadId: string,
    ): Promise<ProactiveSetting> {
      const parsed = parseWith(proactiveSettingInputSchema, input);
      const [row] = await database
        .insert(proactiveSettings)
        .values({
          id: randomUUID(),
          ownerUserId: owner,
          threadId,
          ...parsed,
        })
        .onConflictDoNothing()
        .returning();
      if (!row)
        throw new ProactiveRefusedError(
          "Background research is already set up for this Bot.",
        );
      return row;
    },
    async update(owner: string, id: string, input: unknown) {
      const patch = parseWith(proactiveSettingPatchSchema, input);
      const [row] = await database
        .update(proactiveSettings)
        .set({
          ...patch,
          ...(patch.enabled ? { nextRunAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(owned(owner, id))
        .returning();
      if (!row) throw new ProactiveNotFoundError();
      return row;
    },
    /** Removing research is turning it down for this Bot: OpenBot never switches it back on. */
    async remove(owner: string, id: string) {
      const { agentId } = await get(owner, id);
      await database.transaction(async (transaction) => {
        await lockDefaults(transaction, owner, agentId);
        const rows = await transaction
          .delete(proactiveSettings)
          .where(owned(owner, id))
          .returning({ id: proactiveSettings.id });
        if (!rows.length) throw new ProactiveNotFoundError();
        await recordOptOut(transaction, {
          ownerUserId: owner,
          agentId,
          feature: "proactive_research",
        });
      });
    },
    /**
     * Take the due settings and move each one's next run forward in the same statement, so two
     * sweeps can never both take one and the interval holds even when a run then fails.
     */
    async claimDue(limit = 5): Promise<ProactiveSetting[]> {
      const due = await database
        .select({ id: proactiveSettings.id })
        .from(proactiveSettings)
        .where(
          and(
            eq(proactiveSettings.enabled, true),
            lte(proactiveSettings.nextRunAt, new Date()),
          ),
        )
        .limit(Math.min(limit, 10));
      const claimed: ProactiveSetting[] = [];
      for (const { id } of due) {
        const [row] = await database
          .update(proactiveSettings)
          .set({
            nextRunAt: sql`now() + make_interval(mins => ${proactiveSettings.intervalMinutes})`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(proactiveSettings.id, id),
              eq(proactiveSettings.enabled, true),
              lte(proactiveSettings.nextRunAt, new Date()),
            ),
          )
          .returning();
        if (row) claimed.push(row);
      }
      return claimed;
    },
    async recordRun(
      id: string,
      status: ProactiveRunStatus,
      error: string | null = null,
    ) {
      await database
        .update(proactiveSettings)
        .set({
          lastStatus: status,
          lastError: error?.slice(0, 500) ?? null,
          ...(status === "running" ? { lastRunAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(proactiveSettings.id, id));
    },
    /** Successful connector reads this proactive run made, from the audit trail. */
    async readsFor(runId: string): Promise<ProactiveRead[]> {
      const rows = await database
        .select({ ref: auditEvents.targetId, at: auditEvents.createdAt })
        .from(auditEvents)
        .where(
          and(
            eq(
              auditEvents.initiatorId,
              `${PROACTIVE_INITIATOR_PREFIX}${runId}`,
            ),
            eq(auditEvents.eventType, "mcp.call_succeeded"),
            gte(auditEvents.createdAt, new Date(Date.now() - 86_400_000)),
          ),
        )
        .limit(200);
      return rows.flatMap((row) =>
        row.ref ? [{ ref: row.ref, at: row.at }] : [],
      );
    },
    async countSuggestions(runId: string) {
      const [row] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(proactiveSuggestions)
        .where(eq(proactiveSuggestions.runId, runId));
      return row?.count ?? 0;
    },
    async addSuggestion(
      input: Omit<
        ProactiveSuggestion,
        "id" | "status" | "deliveredAt" | "resolvedAt" | "createdAt"
      >,
    ): Promise<ProactiveSuggestion> {
      const [row] = await database
        .insert(proactiveSuggestions)
        .values({ id: randomUUID(), ...input })
        .returning();
      if (!row) throw new Error("Suggestion insert returned no row.");
      return row;
    },
    async undelivered(runId: string): Promise<ProactiveSuggestion[]> {
      return database
        .select()
        .from(proactiveSuggestions)
        .where(
          and(
            eq(proactiveSuggestions.runId, runId),
            isNull(proactiveSuggestions.deliveredAt),
          ),
        );
    },
    async markDelivered(id: string) {
      await database
        .update(proactiveSuggestions)
        .set({ deliveredAt: new Date() })
        .where(eq(proactiveSuggestions.id, id));
    },
    async suggestions(owner: string): Promise<ProactiveSuggestion[]> {
      return database
        .select()
        .from(proactiveSuggestions)
        .where(
          and(
            eq(proactiveSuggestions.ownerUserId, owner),
            eq(proactiveSuggestions.status, "open"),
          ),
        )
        .orderBy(desc(proactiveSuggestions.createdAt))
        .limit(100);
    },
    /**
     * What the person started, with where each one stands: everything not yet checked off, and the
     * newest `resolvedLimit` of what was, with a count of the older ones.
     *
     * Read from what is already kept: the suggestion's own `started` state; the work queue row
     * `start` offered for it (keyed by the suggestion), which says whether its turn is queued,
     * leased, finished or given up, and carries what the turn ended on and the check mark; its
     * research setting's conversation, where the turn runs and its reply lands; and the approvals
     * and questions still waiting on the person. Whether a lease is live is asked of the
     * database's clock, as the queue itself does.
     */
    async started(owner: string, resolvedLimit = 20): Promise<StartedList> {
      const resolvedAt = sql`${workItems.payload}->>'resolvedAt'`;
      const read = (resolved: boolean) =>
        database
          .select({
            id: proactiveSuggestions.id,
            agentId: proactiveSuggestions.agentId,
            title: proactiveSuggestions.title,
            detail: proactiveSuggestions.detail,
            sourceApp: proactiveSuggestions.sourceApp,
            sourceLink: proactiveSuggestions.sourceLink,
            startedAt: proactiveSuggestions.resolvedAt,
            channelId: proactiveSettings.channelId,
            offered: sql<boolean>`${workItems.key} is not null`,
            attempts: workItems.attempts,
            leased: sql<boolean>`coalesce(${workItems.leaseUntil} > now(), false)`,
            finishedAt: workItems.finishedAt,
            updatedAt: workItems.updatedAt,
            lastError: workItems.lastError,
            payload: workItems.payload,
          })
          .from(proactiveSuggestions)
          .innerJoin(
            proactiveSettings,
            eq(proactiveSettings.id, proactiveSuggestions.settingId),
          )
          .leftJoin(
            workItems,
            and(
              eq(workItems.kind, PROACTIVE_TASK_KIND),
              eq(workItems.key, proactiveSuggestions.id),
            ),
          )
          .where(
            and(
              eq(proactiveSuggestions.ownerUserId, owner),
              eq(proactiveSuggestions.status, "started"),
              resolved
                ? sql`${resolvedAt} is not null`
                : sql`${resolvedAt} is null`,
            ),
          );
      const [open, checked, [counted]] = await Promise.all([
        read(false).orderBy(desc(proactiveSuggestions.resolvedAt)),
        read(true).orderBy(desc(resolvedAt)).limit(Math.max(0, resolvedLimit)),
        database
          .select({ total: sql<number>`count(*)::int` })
          .from(proactiveSuggestions)
          .innerJoin(
            workItems,
            and(
              eq(workItems.kind, PROACTIVE_TASK_KIND),
              eq(workItems.key, proactiveSuggestions.id),
            ),
          )
          .where(
            and(
              eq(proactiveSuggestions.ownerUserId, owner),
              eq(proactiveSuggestions.status, "started"),
              sql`${resolvedAt} is not null`,
            ),
          ),
      ]);
      const rows = [...open, ...checked];

      /*
       * What the person still has to answer, or has just answered: the approvals the turns stopped
       * on, any approval still live in these conversations, and the open questions.
       */
      const approvalIds = rows.flatMap((row) => {
        const waiting = (row.payload as TaskPayload | null)?.waiting;
        return waiting?.kind === "approval" && waiting.id ? [waiting.id] : [];
      });
      const channelIds = [...new Set(rows.map((row) => row.channelId))];
      const earliest = rows.reduce(
        (first, row) =>
          row.startedAt && row.startedAt < first ? row.startedAt : first,
        new Date(),
      );
      const [approvals, questions, threads, responses] = await Promise.all([
        rows.length
          ? database
              .select({
                id: approvalRequests.id,
                status: approvalRequests.status,
                createdAt: approvalRequests.createdAt,
                threadId: sql<string>`${approvalRequests.action}->>'threadId'`,
              })
              .from(approvalRequests)
              .where(
                and(
                  eq(approvalRequests.ownerUserId, owner),
                  or(
                    approvalIds.length
                      ? inArray(approvalRequests.id, approvalIds)
                      : undefined,
                    inArray(approvalRequests.status, [...LIVE_APPROVAL]),
                  ),
                ),
              )
          : [],
        rows.some((row) => row.finishedAt)
          ? database
              .select({
                key: workItems.key,
                payload: workItems.payload,
                createdAt: workItems.createdAt,
                finishedAt: workItems.finishedAt,
              })
              .from(workItems)
              .where(
                and(
                  eq(workItems.kind, "person.question"),
                  sql`${workItems.payload}->>'actorId' = ${owner}`,
                  or(
                    isNull(workItems.finishedAt),
                    gte(workItems.createdAt, earliest),
                  ),
                ),
              )
              .limit(200)
          : [],
        channelIds.length
          ? database
              .select({
                threadId: intelligenceChannelMappings.threadId,
                channelId: intelligenceChannelMappings.channelId,
              })
              .from(intelligenceChannelMappings)
              .where(
                and(
                  eq(intelligenceChannelMappings.userId, owner),
                  inArray(intelligenceChannelMappings.channelId, channelIds),
                ),
              )
          : [],
        // Answers to questions, still being carried on, or given up on.
        database
          .select({
            key: workItems.key,
            response: sql<string>`${workItems.payload}->>'response'`,
            leased: sql<boolean>`coalesce(${workItems.leaseUntil} > now(), false)`,
            attempts: workItems.attempts,
            lastError: workItems.lastError,
          })
          .from(workItems)
          .where(
            and(
              eq(workItems.kind, "person.response"),
              isNull(workItems.finishedAt),
              sql`${workItems.payload}->>'ownerUserId' = ${owner}`,
            ),
          )
          .limit(100),
      ]);
      // One attempt each (person-response-sweep.ts): tried, not held and with a reason is given up.
      const answerGaveUp = new Map(
        responses
          .filter((row) => row.attempts > 0 && !row.leased && row.lastError)
          .map((row) => [row.key, row.lastError]),
      );
      const answering = new Map(
        responses
          .filter((row) => !answerGaveUp.has(row.key))
          .map((row) => [row.key, row.response]),
      );
      const approvalById = new Map(approvals.map((row) => [row.id, row]));
      // A decision is carried out by its own work item. One that gave up never completes.
      const decided = approvals
        .filter((row) => row.status !== "pending" && row.status !== "completed")
        .map((row) => row.id);
      const resumes = decided.length
        ? await database
            .select({
              key: workItems.key,
              attempts: workItems.attempts,
              lastError: workItems.lastError,
            })
            .from(workItems)
            .where(
              and(
                eq(workItems.kind, "approval.resume"),
                inArray(workItems.key, decided),
                isNull(workItems.finishedAt),
                gte(workItems.attempts, DEFAULT_MAX_ATTEMPTS),
              ),
            )
        : [];
      const gaveUp = new Map(resumes.map((row) => [row.key, row.lastError]));
      const openQuestions = questions.map((row) => ({
        key: row.key,
        channelId: String(row.payload.channelId ?? ""),
        question: String(row.payload.question ?? ""),
        createdAt: row.createdAt,
        open: !row.finishedAt,
      }));
      /*
       * Which task asked each question it did not stop on. Task turns run one at a time, so the
       * asker is the first turn in that conversation to finish after the question, among those
       * already started. Each question goes to one task only.
       */
      const askedBy = new Map<string, string>();
      // A question a task stopped on is that task's already.
      const waitedOn = new Set(
        rows.flatMap((row) => {
          const id = (row.payload as TaskPayload | null)?.waiting?.id;
          return id ? [id] : [];
        }),
      );
      for (const question of openQuestions) {
        if (waitedOn.has(question.key)) continue;
        let asker: (typeof rows)[number] | undefined;
        for (const row of rows) {
          if (
            !row.finishedAt ||
            row.channelId !== question.channelId ||
            (row.startedAt ?? new Date(0)) > question.createdAt ||
            row.finishedAt.getTime() + ASKED_SLACK_MS <
              question.createdAt.getTime()
          )
            continue;
          if (!asker?.finishedAt || row.finishedAt < asker.finishedAt)
            asker = row;
        }
        if (asker) askedBy.set(question.key, asker.id);
      }
      /*
       * Which task an approval the person's answer led to belongs to. The turn their answer started
       * asked for it, so it goes to the task answered last before it was asked for, while that
       * answer's turn was still running or had just replied. Approvals a task stopped on are its
       * own already. Each goes to one task only.
       */
      const channelOfThread = new Map(
        threads.map((row) => [row.threadId, row.channelId]),
      );
      const claimed = new Set(approvalIds);
      const ledTo = new Map<string, (typeof approvals)[number]>();
      // In the order they were asked for, so a task's first open request is the one it shows.
      const byAsked = [...approvals].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      for (const approval of byAsked) {
        if (claimed.has(approval.id)) continue;
        const channelId = channelOfThread.get(approval.threadId);
        const asked = approval.createdAt.getTime();
        const answerer = rows
          .map((row) => ({ row, payload: (row.payload ?? {}) as TaskPayload }))
          .filter(
            ({ row, payload }) =>
              row.channelId === channelId &&
              payload.answeredAt &&
              timeOf(payload.answeredAt) <= asked &&
              (awaitingReply(payload) ||
                asked <= timeOf(payload.repliedAt) + ASKED_SLACK_MS),
          )
          .sort(
            (a, b) =>
              timeOf(b.payload.answeredAt) - timeOf(a.payload.answeredAt),
          )
          .at(0);
        if (answerer && !ledTo.has(answerer.row.id))
          ledTo.set(answerer.row.id, approval);
      }

      const stand = (
        row: (typeof rows)[number],
      ): Pick<
        StartedSuggestion,
        "state" | "next" | "waitingOn" | "at" | "canRetry"
      > => {
        const startedAt = row.startedAt ?? new Date(0);
        const payload = (row.payload ?? {}) as TaskPayload;
        const working = (next: string | null, at = startedAt) => ({
          state: "working" as StartedState,
          next,
          waitingOn: null,
          at,
          canRetry: false,
        });
        if (!row.offered)
          return Date.now() - startedAt.getTime() < QUEUEING_GRACE_MS
            ? working("Just started")
            : {
                state: "failed",
                next: plainReason(NEVER_QUEUED),
                waitingOn: null,
                at: startedAt,
                canRetry: true,
              };
        if (row.finishedAt) {
          const finishedAt = row.finishedAt;
          const lastAt = new Date(
            Math.max(
              finishedAt.getTime(),
              timeOf(payload.answeredAt),
              timeOf(payload.repliedAt),
            ),
          );
          const waiting = payload.waiting;
          const approval =
            (waiting?.kind === "approval" && waiting.id
              ? approvalById.get(waiting.id)
              : undefined) ?? ledTo.get(row.id);
          if (approval?.status === "pending")
            return {
              state: "needs_input",
              // What the Bot said since it asked, when it has: its newest words lead.
              next:
                payload.reply &&
                timeOf(payload.repliedAt) > approval.createdAt.getTime()
                  ? payload.reply
                  : null,
              waitingOn: { kind: "approval", id: approval.id },
              at: approval.createdAt,
              canRetry: false,
            };
          if (approval && approval.status !== "completed")
            // Carrying the decision out gave up: the conversation won't go on by itself, and running
            // the task again wouldn't carry the decision out either.
            return gaveUp.has(approval.id)
              ? {
                  state: "failed",
                  next: plainReason(gaveUp.get(approval.id) ?? null),
                  waitingOn: null,
                  at: lastAt,
                  canRetry: false,
                }
              : // Decided, and the conversation is carrying it on: working until its reply arrives.
                working(null, lastAt);
          // Answered in its conversation, and the turn their answer started has not replied yet.
          if (awaitingReply(payload))
            return working(
              payload.answer ? `“${payload.answer}”` : null,
              lastAt,
            );
          // A question it stopped on, or one it asked in its conversation while it ran.
          const itsOwn = openQuestions.filter((question) =>
            waiting?.id
              ? question.key === waiting.id
              : askedBy.get(question.key) === row.id,
          );
          // Answered on its card, and carrying the answer on gave up: it won't go on by itself.
          const stalled = itsOwn.find((question) =>
            answerGaveUp.has(question.key),
          );
          if (stalled)
            return {
              state: "failed",
              next: plainReason(answerGaveUp.get(stalled.key) ?? null),
              waitingOn: null,
              at: lastAt,
              canRetry: false,
            };
          // Answered on its card, and the answer is being carried on: working, on their words.
          const answered = itsOwn.find((question) =>
            answering.has(question.key),
          );
          if (answered)
            return working(`“${answering.get(answered.key) ?? ""}”`, lastAt);
          const asked = itsOwn.find((question) => question.open);
          if (asked)
            return {
              state: "needs_input",
              next: asked.question,
              waitingOn: { kind: "question", id: asked.key },
              at: lastAt,
              canRetry: false,
            };
          return {
            state: asksPerson(payload) ? "needs_input" : "ready_for_review",
            next: payload.reply ?? null,
            waitingOn: null,
            at: lastAt,
            canRetry: false,
          };
        }
        if (row.leased) return working("Just started");
        if (!row.attempts) return working("Just started");
        // Its replica died mid-run, and it gets one more go.
        if (row.attempts < TASK_ATTEMPTS && !row.lastError)
          return working("Just started");
        return {
          state: "failed",
          next: plainReason(row.lastError),
          waitingOn: null,
          at: row.updatedAt ?? startedAt,
          canRetry: true,
        };
      };

      return {
        started: rows.map((row) => {
          const payload = (row.payload ?? {}) as TaskPayload;
          const resolved = payload.resolvedAt
            ? new Date(payload.resolvedAt)
            : null;
          const where = stand(row);
          return {
            id: row.id,
            agentId: row.agentId,
            title: row.title,
            detail: row.detail,
            sourceApp: row.sourceApp,
            sourceLink: row.sourceLink,
            startedAt: row.startedAt ?? new Date(0),
            channelId: row.channelId,
            ...where,
            resolvedAt: resolved,
            at: resolved ?? where.at,
          };
        }),
        olderResolved: Math.max(0, (counted?.total ?? 0) - checked.length),
      };
    },
    /** Keep what a started suggestion's turn ended on, on its work queue row. */
    async recordTaskOutcome(suggestionId: string, outcome: TaskOutcome) {
      await database
        .update(workItems)
        .set({ payload: patchPayload(outcome), updatedAt: sql`now()` })
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            eq(workItems.key, suggestionId),
          ),
        );
    },
    /**
     * Something said in a conversation started tasks run in, by the person or by a turn their own
     * browser ran: never by a turn this server ran, which carries its own outcome.
     *
     * The person's message answers the task that last spoke there, when that task ended asking them
     * something in words: it goes back to Working, on their answer. Task turns run one at a time,
     * so the task that last spoke is the one they are answering. The reply that follows is then
     * that task's, and where it stands comes from it. Nothing changes for a task waiting on an
     * approval or a question card: those are answered there.
     */
    async noteConversation(
      owner: string,
      channelId: string,
      said: { text: string; agentId: string | null; at: Date },
    ) {
      const rows = (
        await database
          .select({
            key: workItems.key,
            finishedAt: workItems.finishedAt,
            payload: workItems.payload,
          })
          .from(workItems)
          .innerJoin(
            proactiveSuggestions,
            eq(proactiveSuggestions.id, workItems.key),
          )
          .innerJoin(
            proactiveSettings,
            eq(proactiveSettings.id, proactiveSuggestions.settingId),
          )
          .where(
            and(
              eq(workItems.kind, PROACTIVE_TASK_KIND),
              eq(proactiveSuggestions.ownerUserId, owner),
              eq(proactiveSettings.channelId, channelId),
              isNotNull(workItems.finishedAt),
              sql`${workItems.payload}->>'resolvedAt' is null`,
            ),
          )
      ).map((row) => ({
        key: row.key,
        finishedAt: row.finishedAt?.getTime() ?? 0,
        payload: row.payload as TaskPayload,
      }));
      const at = said.at.getTime();
      const write = (key: string, payload: ReturnType<typeof patchPayload>) =>
        database
          .update(workItems)
          .set({ payload, updatedAt: sql`now()` })
          .where(
            and(
              eq(workItems.kind, PROACTIVE_TASK_KIND),
              eq(workItems.key, key),
            ),
          );
      if (said.agentId === null) {
        const lastHeard = (row: (typeof rows)[number]) =>
          Math.max(
            row.finishedAt,
            timeOf(row.payload.answeredAt),
            timeOf(row.payload.repliedAt),
          );
        const latest = rows
          .filter((row) => lastHeard(row) < at)
          .sort((a, b) => lastHeard(b) - lastHeard(a))
          .at(0);
        if (
          !latest ||
          awaitingReply(latest.payload) ||
          latest.payload.waiting ||
          !asksPerson(latest.payload)
        )
          return;
        await write(
          latest.key,
          patchPayload({ answer: { at: said.at, text: said.text } }),
        );
        return;
      }
      const answered = rows
        .filter(
          (row) =>
            awaitingReply(row.payload) && timeOf(row.payload.answeredAt) <= at,
        )
        .sort(
          (a, b) => timeOf(b.payload.answeredAt) - timeOf(a.payload.answeredAt),
        )
        .at(0);
      if (!answered) return;
      const ending = replyEnding(said.text);
      await write(
        answered.key,
        patchPayload({
          reply: ending.tail,
          asks: ending.asks,
          repliedAt: said.at,
        }),
      );
    },
    /**
     * End a started suggestion's turn that errored, on its first try: at the attempt cap, so it is
     * never claimed again, with the reason. Only while `replica` still holds it.
     */
    async giveUpTask(
      suggestionId: string,
      replica: string,
      reason: string,
      attempts: number,
    ) {
      await database
        .update(workItems)
        .set({
          claimedBy: null,
          leaseUntil: null,
          attempts: sql`greatest(${workItems.attempts}, ${attempts})`,
          lastError: reason.slice(0, 500),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            eq(workItems.key, suggestionId),
            eq(workItems.claimedBy, replica),
            isNull(workItems.finishedAt),
          ),
        );
    },
    /**
     * Put a failed turn back on the queue as new: not finished, not held, no attempts, nothing it
     * ended on. One statement, so a turn that is queued, running, waiting for its retry or
     * finished is never reset. `missing` is a suggestion whose turn was never queued.
     */
    async resetTask(
      suggestionId: string,
      attempts: number,
    ): Promise<"reset" | "missing" | "busy"> {
      const [reset] = await database
        .update(workItems)
        .set({
          finishedAt: null,
          claimedBy: null,
          leaseUntil: null,
          attempts: 0,
          lastError: null,
          runAt: sql`now()`,
          payload: sql`${workItems.payload} - 'reply' - 'waiting' - 'resolvedAt'`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            eq(workItems.key, suggestionId),
            isNull(workItems.finishedAt),
            or(
              isNull(workItems.leaseUntil),
              lte(workItems.leaseUntil, sql`now()`),
            ),
            or(
              gte(workItems.attempts, attempts),
              isNotNull(workItems.lastError),
            ),
          ),
        )
        .returning({ key: workItems.key });
      if (reset) return "reset";
      const [exists] = await database
        .select({ key: workItems.key })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            eq(workItems.key, suggestionId),
          ),
        )
        .limit(1);
      return exists ? "busy" : "missing";
    },
    /**
     * Check a started suggestion off, or put it back. The mark lives on its work queue row. A turn
     * that was never queued gets a row that says so, given up, to hold the mark.
     */
    async resolveTask(owner: string, suggestionId: string, resolved: boolean) {
      const [suggestion] = await database
        .select({ status: proactiveSuggestions.status })
        .from(proactiveSuggestions)
        .where(
          and(
            eq(proactiveSuggestions.ownerUserId, owner),
            eq(proactiveSuggestions.id, suggestionId),
          ),
        )
        .limit(1);
      if (!suggestion) throw new ProactiveNotFoundError();
      if (suggestion.status !== "started")
        throw new ProactiveRefusedError(
          "Only a started task can be checked off.",
        );
      const [marked] = await database
        .update(workItems)
        .set({
          payload: resolved
            ? sql`${workItems.payload} || jsonb_build_object('resolvedAt', now())`
            : sql`${workItems.payload} - 'resolvedAt'`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            eq(workItems.key, suggestionId),
          ),
        )
        .returning({ key: workItems.key });
      if (marked || !resolved) return;
      await database
        .insert(workItems)
        .values({
          kind: PROACTIVE_TASK_KIND,
          key: suggestionId,
          payload: {
            ownerUserId: owner,
            suggestionId,
            resolvedAt: new Date().toISOString(),
          },
          attempts: TASK_ATTEMPTS,
          lastError: NEVER_QUEUED,
        })
        .onConflictDoNothing();
    },
    async suggestion(owner: string, id: string): Promise<ProactiveSuggestion> {
      const [row] = await database
        .select()
        .from(proactiveSuggestions)
        .where(
          and(
            eq(proactiveSuggestions.ownerUserId, owner),
            eq(proactiveSuggestions.id, id),
          ),
        )
        .limit(1);
      if (!row) throw new ProactiveNotFoundError();
      return row;
    },
    /** Open to dismissed or started, once. A second click is refused rather than run twice. */
    async resolveSuggestion(
      owner: string,
      id: string,
      status: "dismissed" | "started",
    ): Promise<ProactiveSuggestion> {
      const [row] = await database
        .update(proactiveSuggestions)
        .set({ status, resolvedAt: new Date() })
        .where(
          and(
            eq(proactiveSuggestions.ownerUserId, owner),
            eq(proactiveSuggestions.id, id),
            eq(proactiveSuggestions.status, "open"),
          ),
        )
        .returning();
      if (!row)
        throw new ProactiveRefusedError(
          "This suggestion was already started or dismissed.",
        );
      return row;
    },
  };
}
export type ProactiveStore = ReturnType<typeof createProactiveStore>;
