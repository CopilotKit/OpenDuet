import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import { auditEvents } from "../db/schema/core";
import {
  proactiveSettings,
  proactiveSuggestions,
} from "../db/schema/proactive";
import { workItems } from "../db/schema/work";
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
  type TaskOutcome,
} from "./types";

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
    /**
     * Titles the person hid from this Bot since `since`, newest first. Hide has to mean hide: a later
     * check-in is told never to suggest them again, as it is for the open ones.
     */
    async hiddenSince(
      owner: string,
      agentId: string,
      since: Date,
    ): Promise<string[]> {
      const rows = await database
        .select({ title: proactiveSuggestions.title })
        .from(proactiveSuggestions)
        .where(
          and(
            eq(proactiveSuggestions.ownerUserId, owner),
            eq(proactiveSuggestions.agentId, agentId),
            eq(proactiveSuggestions.status, "dismissed"),
            gte(proactiveSuggestions.resolvedAt, since),
          ),
        )
        .orderBy(desc(proactiveSuggestions.resolvedAt))
        .limit(50);
      return rows.map((row) => row.title);
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
