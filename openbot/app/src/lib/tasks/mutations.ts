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
