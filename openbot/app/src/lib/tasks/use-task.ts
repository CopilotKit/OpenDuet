import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  liveStatus,
  type TaskRecord,
  type TaskStatus,
  taskListQueryOptions,
  taskQueryOptions,
} from "./queries";

/** Whether a turn is running in this conversation now, as the roster's working dot says. */
export function useConversationBusy(channelId: string | undefined): boolean {
  const roster = useInfiniteQuery(channelListQueryOptions());
  return channelId
    ? (roster.data?.find((channel) => channel.id === channelId)?.busy ?? false)
    : false;
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
