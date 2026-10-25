import { readTaskFrame } from "@openbot/shared/task-brief";
import { historyOrEmpty } from "@openbot/toolkit/thread-history";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { approvalRequests, channels, workItems } from "../db/schema";
import { PROACTIVE_TASK_KIND, taskExecutionId } from "../proactive/engine";
import { UNTRUSTED_TAG } from "../untrusted-content";
import type { TaskRecord } from "./task-store";

/*
 * A task's report: what it decided and said, and what it read, worked out from what its
 * conversation already holds. Nothing here is stored.
 *
 * WHERE EACH PART COMES FROM.
 * - The conversation is read from Intelligence, as the runtime holds it. Its messages carry no
 *   times, so a time comes from whichever ledger saw that moment, or there is none.
 * - Decisions are the approval inbox's: Allowed once, Always allowed or Refused, by the person, at
 *   `decidedAt`. Each sits where the conversation carried it on (the `approval:<id>` message the
 *   resume writes), or after the call it was asked about.
 * - Updates are each finished turn's last words from the Bot, cut to their first sentence. A turn
 *   ends when the Bot's work item finishes (the task's first turn, a turn carried on after an
 *   approval), when it pauses to ask for approval, or, for the latest turn, at the conversation's
 *   last message.
 * - The person's replies are their own messages after the ask that opened the task.
 * - Resources are the emails and events the task's tool calls read, from the calls' own results.
 */

/** A message as Intelligence keeps it. Only the fields the report reads. */
export type ReportMessage = {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
};

/** An approval asked in the task's conversation, as the inbox holds it. */
export type ReportApproval = {
  id: string;
  toolCallId: string;
  status: string;
  decision: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  completedAt: Date | null;
  action: {
    toolRef: string;
    effect: string;
    scope: string;
    args: unknown;
    target?: unknown;
  };
};

export type ReportDecision = {
  kind: "decision";
  id: string;
  decision: "allow_once" | "allow_always" | "deny" | "handled";
  /** Always the person: a task's approvals are asked of the person it belongs to. */
  by: "you";
  at: string | null;
  /** What was asked about, in the inbox's shape, so the app names it the way the inbox does. */
  action: ReportApproval["action"];
};
export type ReportReply = {
  kind: "reply";
  id: string;
  text: string;
  at: string | null;
};
export type ReportUpdate = {
  kind: "update";
  id: string;
  text: string;
  at: string | null;
};
export type ReportEntry = ReportDecision | ReportReply | ReportUpdate;

export type ReportEmail = {
  kind: "email";
  id: string;
  from: string;
  subject: string;
  at: string | null;
  link: string | null;
};
export type ReportEvent = {
  kind: "event";
  id: string;
  title: string;
  start: string;
  end: string | null;
  location: string | null;
  link: string | null;
};
export type ReportResource = ReportEmail | ReportEvent;

export type TaskReport = {
  taskId: string;
  entries: ReportEntry[];
  resources: ReportResource[];
};

/** What the report is built from, read beforehand so the building can be tested without a database. */
export type ReportInput = {
  task: Pick<TaskRecord, "id" | "status">;
  messages: readonly ReportMessage[];
  approvals: readonly ReportApproval[];
  /** When the task's first turn finished, from its work item. */
  firstTurnEndedAt: Date | null;
  /** When the turn carried on after each approval finished, from the resume's work item. */
  resumedEndedAt: ReadonlyMap<string, Date>;
  /** The conversation's last message, from its channel. */
  lastMessageAt: Date | null;
  /** Transcript openers whose particular execution finished, even while later work waits. */
  completedTurnIds?: ReadonlySet<string>;
  /** Accepted question answers, keyed by their original response message ID, without model context. */
  questionResponses?: ReadonlyMap<string, string>;
};

const DECISIONS = new Set(["allow_once", "allow_always", "deny", "handled"]);

/** How long an update or a reply gets before it is cut at a word. */
const LINE_LENGTH = 160;

/** A message's text: a string, or the text parts of structured content. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** Markdown's marks taken off a line, so a sentence reads as words. */
function plain(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut at a word with an ellipsis past `LINE_LENGTH`. */
function capped(text: string): string {
  if (text.length <= LINE_LENGTH) return text;
  const cut = text.slice(0, LINE_LENGTH);
  const space = cut.lastIndexOf(" ");
  return `${(space > LINE_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * The first sentence of what the Bot said: its first line with words on it, up to a stop followed
 * by a capital, so "Sent. Ana" ends at "Sent." but "no. 5521" and "e.g. this" do not end early.
 */
export function firstSentence(text: string): string {
  const line =
    text
      .split("\n")
      .map(plain)
      .find((part) => /\p{L}|\p{N}/u.test(part)) ?? "";
  const sentence = line.split(/(?<=[^.][.!?])\s+(?=\p{Lu})/u)[0] ?? line;
  return capped(sentence);
}

/** The person's words, on one line. */
function said(text: string): string {
  return capped(text.split("\n").map(plain).filter(Boolean).join(" "));
}

/**
 * A tool's answer as JSON, out of what the transcript carries it in: a string encoded once or twice
 * on the way through the runtime, inside the untrusted-content envelope the server put round it.
 */
export function readToolJson(content: unknown): unknown {
  let text: unknown = content;
  for (let depth = 0; depth < 2 && typeof text === "string"; depth++) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('"')) break;
    try {
      text = JSON.parse(trimmed);
    } catch {
      break;
    }
  }
  if (typeof text !== "string") return text ?? null;
  const open = text.indexOf(`<${UNTRUSTED_TAG} source="`);
  if (open >= 0) {
    const start = text.indexOf(">\n", open);
    const end = text.lastIndexOf(`\n</${UNTRUSTED_TAG}>`);
    if (start >= 0 && end > start)
      text = text
        .slice(start + 2, end)
        .replace(
          new RegExp(`<\\\\/${UNTRUSTED_TAG}`, "gi"),
          `</${UNTRUSTED_TAG}`,
        );
  }
  try {
    return JSON.parse((text as string).trim());
  } catch {
    return null;
  }
}

/** A Gmail web link from the message's id, which Gmail's own addresses take. */
export function gmailLink(id: string): string | null {
  return /^[0-9a-f]{6,40}$/i.test(id)
    ? `https://mail.google.com/mail/u/0/#all/${id}`
    : null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

function emailFrom(value: unknown): ReportEmail | null {
  const message = asRecord(value);
  const id = asString(message?.id);
  if (!message || !id) return null;
  const date = asString(message.date);
  return {
    kind: "email",
    id,
    from: asString(message.from),
    subject: asString(message.subject),
    at: date || null,
    link: gmailLink(id),
  };
}

function eventFrom(value: unknown): ReportEvent | null {
  const event = asRecord(value);
  const id = asString(event?.id);
  const start = asString(event?.start);
  if (!event || !id || !start) return null;
  return {
    kind: "event",
    id,
    title: asString(event.summary) || "(no title)",
    start,
    end: asString(event.end) || null,
    location: asString(event.location) || null,
    link: null,
  };
}

/** Which kind of read a tool name is, by either spelling: `mcp__google-workspace__x` or `x`. */
function readKind(
  name: string,
): "read" | "search" | "calendar" | "brief" | null {
  const tool = name.split(/__|\//).at(-1) ?? name;
  if (tool === "gmail_read_message") return "read";
  if (tool === "gmail_search_messages") return "search";
  if (tool === "calendar_list_events") return "calendar";
  if (tool === "morning_brief") return "brief";
  return null;
}

/**
 * The emails and events the task's tool calls read, each once, in the order first read. A message
 * a search only turned up counts when the task opened none in full: then the search is what it read.
 */
export function resourcesOf(
  messages: readonly ReportMessage[],
): ReportResource[] {
  const results = new Map<string, unknown>();
  for (const message of messages)
    if (message.role === "tool" && message.toolCallId)
      results.set(message.toolCallId, message.content);
  const opened: ReportResource[] = [];
  const found: ReportEmail[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      const kind = readKind(call.name);
      if (!kind || !results.has(call.id)) continue;
      const result = asRecord(readToolJson(results.get(call.id)));
      if (!result) continue;
      if (kind === "read") {
        const email = emailFrom(result);
        if (email) opened.push(email);
      } else if (kind === "search") {
        for (const item of Array.isArray(result.messages)
          ? result.messages
          : []) {
          const email = emailFrom(item);
          if (email) found.push(email);
        }
      } else if (kind === "calendar") {
        for (const item of Array.isArray(result.events) ? result.events : []) {
          const event = eventFrom(item);
          if (event) opened.push(event);
        }
      } else {
        for (const item of Array.isArray(result.needsYou)
          ? result.needsYou
          : []) {
          const email = emailFrom(item);
          if (email) opened.push(email);
        }
        for (const item of Array.isArray(result.calendar)
          ? result.calendar
          : []) {
          const event = eventFrom(item);
          if (event) opened.push(event);
        }
      }
    }
  }
  const anyEmailOpened = opened.some((resource) => resource.kind === "email");
  const all = anyEmailOpened ? opened : [...found, ...opened];
  const seen = new Set<string>();
  return all.filter((resource) => {
    const key = `${resource.kind}:${resource.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type Turn = {
  id: string;
  /** What opened it: the task's ask or replay, the person's reply, or an approval carried on from. */
  opener:
    | { kind: "brief" }
    | { kind: "reply"; id: string; text: string }
    | { kind: "resume"; approvalId: string };
  messages: ReportMessage[];
};

const RESUME_PREFIX = "approval:";

/** The conversation as turns: each opened by the ask, a reply, or an approval carried on from. */
function turnsOf(
  messages: readonly ReportMessage[],
  questionResponses: ReportInput["questionResponses"],
): Turn[] {
  const turns: Turn[] = [];
  const acceptedInputs = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content);
      const frame = readTaskFrame(text);
      // New execution IDs still open outcome turns, but only accepted input adds a human reply.
      const replay =
        frame?.inputId !== undefined && acceptedInputs.has(frame.inputId);
      if (frame?.inputId) acceptedInputs.add(frame.inputId);
      // Question-card answers predate task frames. Their stable message ID is also the accepted
      // input ID carried by Try again, so replay adds an outcome without another human answer.
      else if (message.id.startsWith("person-response:"))
        acceptedInputs.add(message.id);
      turns.push({
        id: message.id,
        opener:
          frame?.kind === "brief" || replay
            ? { kind: "brief" }
            : {
                kind: "reply",
                id: message.id,
                // The ledger preserves the literal answer even if the question or answer quotes
                // framing syntax. Never split the generated question wrapper to recover it.
                text: questionResponses?.get(message.id) ?? frame?.text ?? text,
              },
        messages: [],
      });
      continue;
    }
    if (message.role === "tool" && message.id.startsWith(RESUME_PREFIX)) {
      turns.push({
        id: message.id,
        opener: {
          kind: "resume",
          approvalId: message.id.slice(RESUME_PREFIX.length),
        },
        messages: [message],
      });
      continue;
    }
    if (message.role !== "assistant" && message.role !== "tool") continue;
    const current = turns.at(-1);
    if (current) current.messages.push(message);
    // Anything before the first user message (a seeded greeting) opens a turn of its own.
    else
      turns.push({
        id: message.id,
        opener: { kind: "brief" },
        messages: [message],
      });
  }
  return turns;
}

const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null);

/** The report, from what was read. Pure, so every rule above is tested without a database. */
export function buildTaskReport(input: ReportInput): TaskReport {
  const approvalsByCall = new Map(
    input.approvals.map((approval) => [approval.toolCallId, approval]),
  );
  const approvalsById = new Map(
    input.approvals.map((approval) => [approval.id, approval]),
  );
  const decided = (approval: ReportApproval | undefined) =>
    approval?.decision && DECISIONS.has(approval.decision) ? approval : null;
  const decisionEntry = (approval: ReportApproval): ReportDecision => ({
    kind: "decision",
    id: approval.id,
    decision: approval.decision as ReportDecision["decision"],
    by: "you",
    at: iso(approval.decidedAt),
    action: {
      toolRef: approval.action.toolRef,
      effect: approval.action.effect,
      scope: approval.action.scope,
      args: approval.action.args,
      ...(approval.action.target === undefined
        ? {}
        : { target: approval.action.target }),
    },
  });

  const turns = turnsOf(input.messages, input.questionResponses);
  const entries: ReportEntry[] = [];
  const placed = new Set<string>();
  turns.forEach((turn, index) => {
    const last = index === turns.length - 1;
    if (turn.opener.kind === "reply") {
      const text = said(turn.opener.text);
      if (text)
        entries.push({
          kind: "reply",
          id: turn.opener.id,
          text,
          at: null,
        });
    }
    if (turn.opener.kind === "resume") {
      const approval = decided(approvalsById.get(turn.opener.approvalId));
      if (approval && !placed.has(approval.id)) {
        placed.add(approval.id);
        entries.push(decisionEntry(approval));
      }
    }

    // The approvals this turn stopped to ask for: it ended when it asked.
    const asked = turn.messages
      .flatMap((message) => message.toolCalls ?? [])
      .map((call) => approvalsByCall.get(call.id))
      .filter((approval): approval is ReportApproval => approval !== undefined);
    const reply = turn.messages.findLast(
      (message) =>
        message.role === "assistant" && textOf(message.content).trim() !== "",
    );
    // Working includes future queued work. Keep a known completed execution's update, while
    // still excluding the latest turn when its own completion has not reached the ledger.
    const finished =
      !(last && input.task.status === "working") ||
      input.completedTurnIds?.has(turn.id);
    if (reply && finished) {
      const text = firstSentence(textOf(reply.content));
      const endedAt =
        asked[0]?.createdAt ??
        (turn.opener.kind === "brief" && index === 0
          ? input.firstTurnEndedAt
          : turn.opener.kind === "resume"
            ? (input.resumedEndedAt.get(turn.opener.approvalId) ??
              approvalsById.get(turn.opener.approvalId)?.completedAt ??
              null)
            : null) ??
        (last ? input.lastMessageAt : null);
      if (text)
        entries.push({ kind: "update", id: reply.id, text, at: iso(endedAt) });
    }

    // A decision the conversation has not carried on from yet sits after the call it was about.
    for (const approval of asked) {
      const answered = decided(approval);
      if (answered && !placed.has(answered.id)) {
        placed.add(answered.id);
        entries.push(decisionEntry(answered));
      }
    }
  });
  // Decided in this conversation but on a call its history no longer holds: last, in time order.
  for (const approval of [...input.approvals].sort(
    (a, b) => (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0),
  )) {
    const answered = decided(approval);
    if (answered && !placed.has(answered.id)) {
      placed.add(answered.id);
      entries.push(decisionEntry(answered));
    }
  }
  return {
    taskId: input.task.id,
    entries,
    resources: resourcesOf(input.messages),
  };
}

/** Reads a thread's messages for its owner. Index.ts gives it Intelligence's client. */
export type ReportHistory = (input: {
  threadId: string;
  ownerUserId: string;
}) => Promise<readonly ReportMessage[]>;

export type TaskReportReader = (
  ownerUserId: string,
  task: TaskRecord,
) => Promise<TaskReport>;

/** The history reader over an Intelligence client: a thread it has never heard of has no messages. */
export function intelligenceHistory(client: {
  getThreadMessages(params: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: ReportMessage[] }>;
}): ReportHistory {
  return async ({ threadId, ownerUserId }) =>
    (
      await historyOrEmpty(
        () => client.getThreadMessages({ threadId, userId: ownerUserId }),
        { messages: [] },
      )
    ).messages;
}

/** `GET /api/openduet/tasks/:id/report`'s reader: the ledgers, then `buildTaskReport`. */
export function createTaskReportReader(deps: {
  database: Database;
  history: ReportHistory;
}): TaskReportReader {
  return async (ownerUserId, task) => {
    if (!task.threadId) return { taskId: task.id, entries: [], resources: [] };
    const threadId = task.threadId;
    const [messages, rows, turns, channel, answers] = await Promise.all([
      deps.history({ threadId, ownerUserId }),
      deps.database
        .select({
          id: approvalRequests.id,
          toolCallId: approvalRequests.toolCallId,
          status: approvalRequests.status,
          decision: approvalRequests.decision,
          createdAt: approvalRequests.createdAt,
          decidedAt: approvalRequests.decidedAt,
          completedAt: approvalRequests.completedAt,
          action: approvalRequests.action,
        })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, ownerUserId),
            sql`${approvalRequests.action}->>'threadId' = ${threadId}`,
          ),
        ),
      deps.database
        .select({
          key: workItems.key,
          attempts: workItems.attempts,
          payload: workItems.payload,
          finishedAt: workItems.finishedAt,
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            sql`${workItems.payload}->>'taskId' = ${task.id}`,
            sql`${workItems.payload}->>'ownerUserId' = ${ownerUserId}`,
          ),
        )
        .orderBy(workItems.createdAt),
      deps.database
        .select({ lastMessageAt: channels.lastMessageAt })
        .from(channels)
        .where(eq(channels.id, task.channelId))
        .limit(1),
      deps.database
        .select({
          key: workItems.key,
          payload: workItems.payload,
          finishedAt: workItems.finishedAt,
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "person.response"),
            sql`${workItems.payload}->>'ownerUserId' = ${ownerUserId}`,
            sql`${workItems.payload}->'question'->>'actorId' = ${ownerUserId}`,
            sql`${workItems.payload}->'question'->>'threadId' = ${threadId}`,
            sql`(${workItems.payload}->'question'->>'channelId' is null
              or ${workItems.payload}->'question'->>'channelId' = ${task.channelId})`,
          ),
        ),
    ]);
    const approvals: ReportApproval[] = rows.map((row) => ({
      id: row.id,
      toolCallId: row.toolCallId,
      status: row.status,
      decision: row.decision,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      completedAt: row.completedAt,
      action: {
        toolRef: row.action.toolRef,
        effect: row.action.effect,
        scope: row.action.scope,
        args: row.action.args,
        ...(row.action.target === undefined
          ? {}
          : { target: row.action.target }),
      },
    }));
    const resumed =
      approvals.length === 0
        ? []
        : await deps.database
            .select({ key: workItems.key, finishedAt: workItems.finishedAt })
            .from(workItems)
            .where(
              and(
                eq(workItems.kind, "approval.resume"),
                inArray(
                  workItems.key,
                  approvals.map((approval) => approval.id),
                ),
              ),
            );
    return buildTaskReport({
      task,
      messages,
      approvals,
      firstTurnEndedAt: turns[0]?.finishedAt ?? null,
      resumedEndedAt: new Map(
        resumed.flatMap((row) =>
          row.finishedAt ? [[row.key, row.finishedAt] as const] : [],
        ),
      ),
      lastMessageAt: channel[0]?.lastMessageAt ?? null,
      completedTurnIds: new Set([
        ...turns.flatMap((row) =>
          row.finishedAt && row.attempts > 0
            ? [
                taskExecutionId({
                  taskId: task.id,
                  workKey: row.key,
                  attempt: row.attempts,
                  messageId: asString(row.payload.messageId) || undefined,
                  again: row.payload.again === true,
                }),
              ]
            : [],
        ),
        ...resumed.flatMap((row) =>
          row.finishedAt ? [`${RESUME_PREFIX}${row.key}`] : [],
        ),
        ...answers.flatMap((row) =>
          row.finishedAt ? [`person-response:${row.key}`] : [],
        ),
      ]),
      questionResponses: new Map(
        answers.flatMap((row) =>
          typeof row.payload.response === "string"
            ? [[`person-response:${row.key}`, row.payload.response] as const]
            : [],
        ),
      ),
    });
  };
}
