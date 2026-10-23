import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import {
  liveStatus,
  type TaskRecord,
  type TaskStatus,
  taskKeys,
  taskListQueryOptions,
  taskQueryOptions,
} from "./queries";

/**
 * Whether a turn is running in this conversation now, as the roster's working dot says.
 *
 * When the dot comes on or goes out, the tasks are read again at once: a turn started or ended, so
 * where the task stands has changed, and the quiet poll would leave the old status up for half a
 * minute. A page open in another tab learns this way that a reply elsewhere is running the task.
 */
export function useConversationBusy(channelId: string | undefined): boolean {
  const roster = useInfiniteQuery(channelListQueryOptions());
  const busy = channelId
    ? (roster.data?.find((channel) => channel.id === channelId)?.busy ?? false)
    : false;
  const was = useRef(busy);
  useEffect(() => {
    if (was.current !== busy)
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
    was.current = busy;
  }, [busy]);
  return busy;
}

/**
 * One task and where it stands right now, for a card. Read from the list every card shares, so a
 * thread of cards is one request; a task too old to be on the list is read on its own.
 */
export function useTask(taskId: string): {
  task: TaskRecord | undefined;
  status: TaskStatus | null;
} {
  const list = useQuery(taskListQueryOptions());
  const listed = list.data?.find((task) => task.id === taskId);
  const alone = useQuery({
    ...taskQueryOptions(taskId),
    enabled: list.isSuccess && !listed,
  });
  const task = listed ?? alone.data;
  const busy = useConversationBusy(task?.channelId);
  return { task, status: task ? liveStatus(task.status, busy) : null };
}
