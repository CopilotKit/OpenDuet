import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/*
 * The person's tasks: work OpenDuet does in the background, each in a conversation of its own
 * (server/src/openduet/task-store.ts). Chat draws a card for each one it starts, the task page is its
 * conversation, and Tasks lists them.
 *
 * `status` is the server's word, worked out on every read from what the task's conversation is doing:
 * its turn running, an approval or a question waiting on the person, its turn out of runs without
 * finishing, or the person's own Mark done.
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
  origin: "asked" | "suggestion" | "check_in";
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  status: TaskStatus;
  /**
   * Why its turn couldn't finish, in plain words, while it is `failed`, or marked done after failing.
   * Null otherwise.
   */
  failure: string | null;
  /** When it failed, alongside `failure`. */
  failedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const taskKeys = {
  all: ["openduet-tasks"] as const,
  list: ["openduet-tasks", "list"] as const,
  detail: (id: string) => ["openduet-tasks", "detail", id] as const,
};

/** Something is moving: read again soon. Otherwise only now and then, for a change made elsewhere. */
const LIVE_MS = 3_000;
const QUIET_MS = 30_000;
const moving = (status: TaskStatus | undefined) =>
  status === "working" || status === "needs_input";

/** Every task of the person's, newest first, kept live while any of them is under way. */
export const taskListQueryOptions = () =>
  queryOptions({
    queryKey: taskKeys.list,
    queryFn: (): Promise<TaskRecord[]> =>
      client("/api/openduet/tasks", "tasks", {
        fallback: "Couldn't load your tasks.",
      }),
    refetchInterval: (query) =>
      query.state.data?.some((task) => moving(task.status))
        ? LIVE_MS
        : QUIET_MS,
  });

/** One task, kept live while it is under way. */
export const taskQueryOptions = (id: string) =>
  queryOptions({
    queryKey: taskKeys.detail(id),
    queryFn: (): Promise<TaskRecord> =>
      client(`/api/openduet/tasks/${encodeURIComponent(id)}`, "task", {
        fallback: "Couldn't open this task.",
      }),
    refetchInterval: (query) =>
      moving(query.state.data?.status) ? LIVE_MS : QUIET_MS,
  });

/**
 * Where a task stands right now. A turn the person started by replying in the task runs in their
 * browser, which the server cannot see; the conversation's working dot can, so it counts as Working
 * too. Waiting on the person still comes first.
 */
export function liveStatus(status: TaskStatus, busy: boolean): TaskStatus {
  return busy && status !== "needs_input" ? "working" : status;
}

/** The pill's word for each status. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  working: "Working",
  needs_input: "Needs input",
  ready_for_review: "Ready for review",
  resolved: "Resolved",
  failed: "Failed",
};

/** What a failed task's row and card say after its status: "Couldn't finish: <reason>." */
export function couldNotFinish(failure: string | null): string {
  return failure ? `Couldn't finish: ${failure}.` : "Couldn't finish.";
}

/**
 * The Bot's own line when a task's last run fails, as the server records it in the task's
 * conversation (server/src/openduet/task-threads.ts). The task page shows it as its last update.
 */
export function failureLine(failure: string | null): string {
  return failure
    ? `I couldn't finish this: ${failure}.`
    : "I couldn't finish this.";
}
