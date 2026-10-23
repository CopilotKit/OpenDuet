import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type TaskRecord, taskKeys } from "./queries";

/** Mark a task done, or reopen one marked done. Its conversation stays either way. */
export const resolveTaskMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, done }: { id: string; done: boolean }) =>
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
