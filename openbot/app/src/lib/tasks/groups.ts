import { describeApproval } from "@/lib/approval-view";
import {
  type ApprovalInboxData,
  type ApprovalRequest,
  type PersonQuestion,
  waitingOnYou,
} from "@/lib/approvals";
import {
  couldNotFinish,
  liveStatus,
  TASK_STATUS_LABEL,
  type TaskRecord,
  type TaskStatus,
} from "./queries";

/*
 * Tasks' Active list, grouped by what each thing needs from the person: Ready for review, Needs
 * input, Working, Resolved. Worked out here, away from the screen, so the order, the counts and the
 * tab's badge can be read and tested without drawing anything.
 *
 * An approval or a question raised in a task's own conversation belongs to that task. The task is
 * listed, and says what it needs; the request is answered on the task's page. Everything else that
 * waits on the person is listed on its own, under Needs input, and answered in place.
 */

/** The groups, top to bottom. A task's status names the group it is in. */
export const GROUP_ORDER: readonly TaskStatus[] = [
  "ready_for_review",
  "needs_input",
  "failed",
  "working",
  "resolved",
];

/** How long a task the person marked done stays under Resolved. */
export const RESOLVED_FOR_MS = 7 * 24 * 60 * 60 * 1000;

export type SortOrder = "newest" | "oldest";

/** Something already in a ledger that is not a task: a delegated job under way, or finished work. */
export type OtherRow = { id: string; title: string; at: string };

export type ActiveItem<Row extends OtherRow> =
  | {
      kind: "task";
      key: string;
      at: string;
      title: string;
      task: TaskRecord;
      status: TaskStatus;
      /** The next thing it needs, after its status: "Read what it did". */
      need: string;
      /** The line under it: "You asked", or where it came from. */
      tag: string;
    }
  | {
      kind: "request";
      key: string;
      at: string;
      title: string;
      request: ApprovalRequest;
    }
  | {
      kind: "question";
      key: string;
      at: string;
      title: string;
      question: PersonQuestion;
    }
  | { kind: "row"; key: string; at: string; title: string; row: Row };

export type ActiveGroup<Row extends OtherRow> = {
  id: TaskStatus;
  label: string;
  items: ActiveItem<Row>[];
  /** The newest thing in it, for "Updated 1 min ago". */
  updatedAt: string;
};

/** What the roster knows about a task's conversation. */
export type ConversationFacts = { busy: boolean; lastMessageAt: string | null };

/** What waits on the person in each task's conversation, and what waits outside any task. */
function tie(
  tasks: readonly TaskRecord[],
  requests: readonly ApprovalRequest[],
  questions: readonly PersonQuestion[],
) {
  const taskOfThread = new Map<string, string>();
  const answeredByTask = new Map(
    tasks.map((task) => [task.id, new Set(task.answeredQuestionIds ?? [])]),
  );
  for (const task of tasks)
    if (task.threadId) taskOfThread.set(task.threadId, task.id);
  const waiting = new Map<
    string,
    { request?: ApprovalRequest; question?: PersonQuestion }
  >();
  const looseRequests: ApprovalRequest[] = [];
  const looseQuestions: PersonQuestion[] = [];
  for (const request of requests) {
    const taskId = taskOfThread.get(request.action.threadId);
    if (!taskId) looseRequests.push(request);
    else waiting.set(taskId, { request, ...waiting.get(taskId) });
  }
  for (const question of questions) {
    const taskId = taskOfThread.get(question.threadId);
    if (!taskId) looseQuestions.push(question);
    else if (!answeredByTask.get(taskId)?.has(question.id))
      waiting.set(taskId, { question, ...waiting.get(taskId) });
  }
  return { waiting, looseRequests, looseQuestions };
}

/**
 * Where a task stands: the server's word, Working while its conversation runs a turn the server
 * cannot see, and Needs input as soon as something in its conversation waits on the person, even
 * before the server's next read says so.
 */
function statusOf(task: TaskRecord, busy: boolean, waits: boolean) {
  return waits ? "needs_input" : liveStatus(task.status, busy);
}

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1);

/**
 * What a task needs next, said after its status: the run's own next step (parity-spec S3d). A
 * question it stopped on is the question itself, an approval says what it would do, and a failed
 * run says why. Otherwise the Bot's newest words end on what comes next; before it has said
 * anything, a working task has "Just started".
 */
function needOf(
  status: TaskStatus,
  waiting: { request?: ApprovalRequest; question?: PersonQuestion } | undefined,
  task: Pick<TaskRecord, "failure" | "next" | "why">,
): string {
  const said = task.next?.trim() || null;
  if (status === "failed") return couldNotFinish(task.failure);
  if (status === "needs_input") {
    if (waiting?.question) return waiting.question.question;
    if (waiting?.request)
      return `Allow it to ${lowerFirst(describeApproval(waiting.request).title)}, or refuse`;
    return said ?? "Open it to answer";
  }
  if (status === "working") return said ?? "Just started";
  return said ?? task.why ?? "Read what it did";
}

/** The line under a task: who asked for it, or where it came from. */
export function taskTag(task: Pick<TaskRecord, "origin" | "sourceApp">) {
  if (task.origin === "asked") return "You asked";
  return task.sourceApp ?? "Suggested";
}

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
};
const latest = (...times: (string | null | undefined)[]) =>
  times.reduce<string>(
    (best, next) => (next && time(next) > time(best) ? next : best),
    "",
  );

/** Whether a title matches what was typed in search: every word of it, in any case. */
export function matchesSearch(title: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const said = title.toLowerCase();
  return words.every((word) => said.includes(word));
}

/** Sorts newest or oldest first by `at`, leaving equal times in the order given. */
export function sortByTime<T extends { at: string }>(
  items: readonly T[],
  order: SortOrder,
): T[] {
  const sign = order === "newest" ? -1 : 1;
  return [...items].sort((a, b) => sign * (time(a.at) - time(b.at)));
}

/**
 * The Active list's groups, in order, each holding its things sorted by `order` and narrowed by
 * `query`. A group with nothing in it is left out.
 *
 * - Ready for review: tasks with something to read.
 * - Needs input: tasks waiting on the person, and the approvals and questions not in any task.
 * - Working: tasks under way, and the other work under way (`working`).
 * - Resolved: tasks marked done in the last week, and the other finished work (`handled`).
 */
export function activeGroups<Row extends OtherRow>(input: {
  tasks: readonly TaskRecord[];
  conversation: (channelId: string) => ConversationFacts | undefined;
  requests: readonly ApprovalRequest[];
  questions: readonly PersonQuestion[];
  working: readonly Row[];
  handled: readonly Row[];
  now: number;
  order: SortOrder;
  query: string;
}): ActiveGroup<Row>[] {
  const { waiting, looseRequests, looseQuestions } = tie(
    input.tasks,
    input.requests,
    input.questions,
  );
  const items = new Map<TaskStatus, ActiveItem<Row>[]>(
    GROUP_ORDER.map((id) => [id, []]),
  );
  const add = (id: TaskStatus, item: ActiveItem<Row>) => {
    if (matchesSearch(item.title, input.query)) items.get(id)?.push(item);
  };
  for (const task of input.tasks) {
    const facts = input.conversation(task.channelId);
    const waits = waiting.get(task.id);
    const status = statusOf(task, facts?.busy ?? false, Boolean(waits));
    if (
      status === "resolved" &&
      input.now - time(task.resolvedAt ?? task.updatedAt) > RESOLVED_FOR_MS
    )
      continue;
    add(status, {
      kind: "task",
      key: `task:${task.id}`,
      at:
        status === "resolved"
          ? latest(task.resolvedAt, task.updatedAt)
          : latest(
              task.updatedAt,
              facts?.lastMessageAt,
              waits?.request?.createdAt,
              waits?.question?.createdAt,
            ),
      title: task.title,
      task,
      status,
      need: needOf(status, waits, task),
      tag: taskTag(task),
    });
  }
  for (const request of looseRequests)
    add("needs_input", {
      kind: "request",
      key: `request:${request.id}`,
      at: request.createdAt,
      title: describeApproval(request).title,
      request,
    });
  for (const question of looseQuestions)
    add("needs_input", {
      kind: "question",
      key: `question:${question.id}`,
      at: question.createdAt,
      title: question.question,
      question,
    });
  for (const row of input.working)
    add("working", {
      kind: "row",
      key: `row:${row.id}`,
      at: row.at,
      title: row.title,
      row,
    });
  for (const row of input.handled)
    add("resolved", {
      kind: "row",
      key: `row:${row.id}`,
      at: row.at,
      title: row.title,
      row,
    });
  return GROUP_ORDER.flatMap((id) => {
    const listed = items.get(id) ?? [];
    if (listed.length === 0) return [];
    return [
      {
        id,
        label: TASK_STATUS_LABEL[id],
        items: sortByTime(listed, input.order),
        updatedAt: latest(...listed.map((item) => item.at)),
      },
    ];
  });
}

/**
 * The Tasks tab's badge: everything under Needs input. The tasks waiting on the person, and the
 * approvals and questions that are not in any task's conversation, so a task's own request is
 * counted once, as its task.
 */
export function needsInputCount(
  tasks: readonly TaskRecord[] | undefined,
  inbox: ApprovalInboxData | undefined,
): number {
  const { requests, questions } = waitingOnYou(inbox);
  const { waiting, looseRequests, looseQuestions } = tie(
    tasks ?? [],
    requests,
    questions,
  );
  const tasksWaiting = (tasks ?? []).filter(
    (task) => task.status === "needs_input" || waiting.has(task.id),
  ).length;
  return tasksWaiting + looseRequests.length + looseQuestions.length;
}
