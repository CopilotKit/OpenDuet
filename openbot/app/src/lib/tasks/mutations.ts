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
