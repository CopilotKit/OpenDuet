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
import { auditEvents } from "../db/schema/core";
import {
  proactiveSettings,
  proactiveSuggestions,
} from "../db/schema/proactive";
import { workItems } from "../db/schema/work";
import { lockDefaults, recordOptOut } from "../memory/defaults";
import { PROACTIVE_TASK_KIND, TASK_ATTEMPTS } from "./engine";
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

/** What a started suggestion's work queue row carries, beyond who and which. */
type TaskPayload = TaskOutcome & { resolvedAt?: string };

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

      // What the person still has to answer: the approvals turns stopped on, and open questions.
      const approvalIds = rows.flatMap((row) => {
        const waiting = (row.payload as TaskPayload | null)?.waiting;
        return waiting?.kind === "approval" && waiting.id ? [waiting.id] : [];
      });
      const [approvals, questions] = await Promise.all([
        approvalIds.length
          ? database
              .select({
                id: approvalRequests.id,
                status: approvalRequests.status,
                decision: approvalRequests.decision,
              })
              .from(approvalRequests)
              .where(
                and(
                  eq(approvalRequests.ownerUserId, owner),
                  inArray(approvalRequests.id, approvalIds),
                ),
              )
          : [],
        rows.some((row) => row.finishedAt)
          ? database
              .select({
                key: workItems.key,
                payload: workItems.payload,
                createdAt: workItems.createdAt,
              })
              .from(workItems)
              .where(
                and(
                  eq(workItems.kind, "person.question"),
                  isNull(workItems.finishedAt),
                  sql`${workItems.payload}->>'actorId' = ${owner}`,
                ),
              )
              .limit(100)
          : [],
      ]);
      const approvalById = new Map(approvals.map((row) => [row.id, row]));
      const openQuestions = questions.map((row) => ({
        key: row.key,
        channelId: String(row.payload.channelId ?? ""),
        question: String(row.payload.question ?? ""),
        createdAt: row.createdAt,
      }));
      /*
       * Which task asked each question it did not stop on. Task turns run one at a time, so the
       * asker is the first turn in that conversation to finish after the question, among those
       * already started. Each question goes to one task only.
       */
      const askedBy = new Map<string, string>();
      for (const question of openQuestions) {
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

      const stand = (
        row: (typeof rows)[number],
      ): Pick<StartedSuggestion, "state" | "next" | "waitingOn" | "at"> => {
        const startedAt = row.startedAt ?? new Date(0);
        const payload = (row.payload ?? {}) as TaskPayload;
        const working = (next: string) => ({
          state: "working" as StartedState,
          next,
          waitingOn: null,
          at: startedAt,
        });
        if (!row.offered)
          return Date.now() - startedAt.getTime() < QUEUEING_GRACE_MS
            ? working("Just started")
            : {
                state: "failed",
                next: plainReason(NEVER_QUEUED),
                waitingOn: null,
                at: startedAt,
              };
        if (row.finishedAt) {
          const at = row.finishedAt;
          const waiting = payload.waiting;
          if (waiting?.kind === "approval" && waiting.id) {
            const approval = approvalById.get(waiting.id);
            if (approval?.status === "pending")
              return {
                state: "needs_input",
                next: null,
                waitingOn: { kind: "approval", id: waiting.id },
                at,
              };
            return {
              state: "ready_for_review",
              next:
                approval?.decision === "deny"
                  ? "You refused what it asked to do."
                  : "You allowed what it asked to do.",
              waitingOn: null,
              at,
            };
          }
          // A question it stopped on, or one it asked in its conversation while it ran.
          const asked = openQuestions.find((question) =>
            waiting?.id
              ? question.key === waiting.id
              : askedBy.get(question.key) === row.id,
          );
          if (asked)
            return {
              state: "needs_input",
              next: asked.question,
              waitingOn: { kind: "question", id: asked.key },
              at,
            };
          const reply = payload.reply ?? null;
          return {
            state: reply?.endsWith("?") ? "needs_input" : "ready_for_review",
            next: reply,
            waitingOn: null,
            at,
          };
        }
        if (row.leased) return working("Just started");
        if (!row.attempts) return working("Just started");
        // Its replica died mid-run, and it gets one more go.
        if (row.attempts < TASK_ATTEMPTS && !row.lastError)
          return working("Starting again");
        return {
          state: "failed",
          next: plainReason(row.lastError),
          waitingOn: null,
          at: row.updatedAt ?? startedAt,
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
      // Built in SQL rather than serialised here: a JSON string parameter is stored as a string.
      const parts = [
        ...("reply" in outcome
          ? [sql`jsonb_build_object('reply', ${outcome.reply ?? null}::text)`]
          : []),
        ...(outcome.waiting
          ? [
              sql`jsonb_build_object('waiting', jsonb_build_object('kind', ${outcome.waiting.kind}::text, 'id', ${outcome.waiting.id}::text))`,
            ]
          : []),
      ];
      if (parts.length === 0) return;
      await database
        .update(workItems)
        .set({
          payload: sql`${workItems.payload} || ${sql.join(parts, sql` || `)}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            eq(workItems.key, suggestionId),
          ),
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
