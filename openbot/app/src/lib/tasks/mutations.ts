import type { DurableTaskReply } from "@openbot/shared/task-reply";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { proactiveKeys } from "@/lib/proactive";
import { type TaskRecord, taskKeys } from "./queries";

/** What the + on Tasks sends: which Bot, and the ask in the person's words. */
export type TaskAsk = { botId: string; instruction: string };

/** Start now: the ask opens a task in a conversation of its own and starts there. */
export const startTaskMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (ask: TaskAsk) =>
      client<TaskRecord>("/api/openduet/tasks", "task", {
        method: "POST",
        body: ask,
        fallback: "Couldn't start this task. Try again.",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: taskKeys.all }),
  });

/** Save for Up next: the ask waits on Up next as a card the person asked for, with Start and Hide. */
export const saveForUpNextMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (ask: TaskAsk) =>
      client<{ id: string; title: string }>(
        "/api/openduet/tasks/up-next",
        "suggestion",
        {
          method: "POST",
          body: ask,
          fallback: "Couldn't save this for Up next. Try again.",
        },
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: proactiveKeys.suggestions }),
        queryClient.invalidateQueries({ queryKey: proactiveKeys.settings }),
      ]),
  });

/**
 * Mark a task done, or reopen one marked done. Its conversation stays either way.
 *
 * `holdMs` keeps the lists as they are for at least that long after a task is marked done, so a
 * check drawn on its row is seen before the row moves. The request itself goes at once, and is not
 * lost if the person leaves the screen in the meantime.
 */
export const resolveTaskMutationOptions = (
  queryClient: QueryClient,
  { holdMs = 0 }: { holdMs?: number } = {},
) =>
  mutationOptions({
    mutationFn: async ({ id, done }: { id: string; done: boolean }) => {
      const [task] = await Promise.all([
        client<TaskRecord>(
          `/api/openduet/tasks/${encodeURIComponent(id)}/${done ? "resolve" : "reopen"}`,
          "task",
          {
            method: "POST",
            fallback: done
              ? "Couldn't mark this task done. Try again."
              : "Couldn't reopen this task. Try again.",
          },
        ),
        done && holdMs > 0
          ? new Promise((resolve) => setTimeout(resolve, holdMs))
          : null,
      ]);
      return task;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: taskKeys.all }),
  });

/**
 * Try again: a task that couldn't finish runs its turn once more, in its own conversation. A reply
 * typed on the failed task goes with it, beside the ask.
 */
export const tryTaskAgainMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      id,
      reply,
      messageId,
    }: {
      id: string;
      reply?: string;
      /** The id the reply is drawn under, so the run records it as the same message. */
      messageId?: string;
    }) =>
      client<TaskRecord>(
        `/api/openduet/tasks/${encodeURIComponent(id)}/again`,
        "task",
        {
          method: "POST",
          body: {
            ...(reply ? { reply } : {}),
            ...(messageId ? { messageId } : {}),
          },
          fallback: "Couldn't run this task again. Try again in a moment.",
        },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: taskKeys.all }),
  });

/** Accepted by the server before the composer clears; delivered without this page staying open. */
export const replyToTaskMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      id,
      reply,
      messageId,
      ...context
    }: { id: string } & DurableTaskReply) =>
      client<TaskRecord>(
        `/api/openduet/tasks/${encodeURIComponent(id)}/reply`,
        "task",
        {
          method: "POST",
          body: { reply, messageId, ...context },
          fallback: "Couldn't save this reply. Try again.",
        },
      ),
    onSuccess: (task) => {
      queryClient.setQueryData(taskKeys.detail(task.id), task);
      return queryClient.invalidateQueries({ queryKey: taskKeys.all });
    },
  });
