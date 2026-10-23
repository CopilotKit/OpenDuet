import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { RowButton } from "@/components/shell/activity-screen";
import { clockTime } from "@/lib/approval-view";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";
import { resolveTaskMutationOptions } from "@/lib/tasks/mutations";
import {
  liveStatus,
  type TaskRecord,
  taskQueryOptions,
} from "@/lib/tasks/queries";
import { useConversationBusy } from "@/lib/tasks/use-task";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { DuetIcon } from "./icons";
import { TaskStatusPill } from "./task-card";

/*
 * A task, opened: a large card on the frosted veil, × at its top left and the title across its
 * header with when it started, then where it stands with Mark done (Reopen once it is done), then
 * the task's own conversation, where the person can reply to steer it.
 *
 * Opened from its card in Chat or its row in Tasks, at `/tasks/<id>`, over the Tasks list. Never
 * over Chat itself: that would put two conversations on screen at once.
 *
 * The conversation is the whole report for now. A fuller layout (the decisions it made, its updates,
 * the resources it used) is a later slice.
 */

export function TaskSheet({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  const task = useQuery(taskQueryOptions(taskId));
  const popup = useRef<HTMLDivElement>(null);
  return (
    <DialogPrimitive.Root
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          aria-modal="true"
          className={cn(
            "duet-veil duet-face group fixed inset-0 z-50 flex flex-col text-duet-ink outline-none",
            "transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none",
          )}
          // The sheet takes focus, not ×, so a stray Enter does not close what was just opened.
          initialFocus={popup}
          ref={popup}
        >
          <div className="mx-auto flex min-h-0 w-full max-w-[430px] flex-1 flex-col px-2.5 pt-[max(env(safe-area-inset-top),12px)] pb-[max(env(safe-area-inset-bottom),10px)]">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] bg-duet-card shadow-duet-raised transition-transform duration-300 ease-out motion-reduce:transition-none motion-safe:group-data-starting-style:translate-y-6">
              <header className="grid min-h-16 shrink-0 grid-cols-[44px_1fr_44px] items-center px-2 py-1">
                <button
                  aria-label="Close"
                  className="grid size-11 place-items-center rounded-full text-duet-ink outline-none transition-colors hover:bg-duet-tile focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:bg-duet-tile"
                  onClick={onClose}
                  type="button"
                >
                  <DuetIcon name="x" size={22} stroke={2.1} />
                </button>
                <div className="min-w-0 px-1 text-center">
                  <DialogPrimitive.Title className="type-row truncate font-semibold">
                    {task.data?.title ?? ""}
                  </DialogPrimitive.Title>
                  {task.data ? <StartedAt iso={task.data.createdAt} /> : null}
                </div>
                <span aria-hidden />
              </header>
              {task.isPending ? null : task.error ? (
                <p className="type-sub px-5 text-duet-red" role="alert">
                  Couldn't open this task. Close it and try again.
                </p>
              ) : (
                <TaskBody task={task.data} />
              )}
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** When the task began, under its title: "Started 9:41 AM", or the day for an older one. */
function StartedAt({ iso }: { iso: string }) {
  const when = clockTime(iso);
  return when ? (
    <p className="type-label truncate font-medium text-duet-ink-3">
      Started {when}
    </p>
  ) : null;
}

function TaskBody({ task }: { task: TaskRecord }) {
  // Open on screen is read, as a conversation's own page is.
  useMarkOpenChannelRead(task.channelId);
  const busy = useConversationBusy(task.channelId);
  const status = liveStatus(task.status, busy);
  const resolve = useMutation(resolveTaskMutationOptions(queryClient));
  const conversation = useQuery(channelQueryOptions(task.channelId));
  const done = task.resolvedAt !== null;
  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2.5 border-duet-hair-2 border-b px-5 pt-1 pb-3">
        <TaskStatusPill status={status} />
        <RowButton
          busy={resolve.isPending}
          label={done ? "Reopen this task" : "Mark this task done"}
          onClick={() => resolve.mutate({ id: task.id, done: !done })}
          primary={!done}
        >
          {done ? "Reopen" : "Mark done"}
        </RowButton>
      </div>
      {resolve.error ? (
        <p className="type-label px-5 pt-2 text-duet-red" role="alert">
          {resolve.error.message}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col px-3">
        {conversation.isPending ? null : conversation.error ||
          !conversation.data ? (
          <p className="type-sub px-2 pt-4 text-duet-red" role="alert">
            Couldn't load this task's conversation. Close it and try again.
          </p>
        ) : (
          <ChannelChat
            channel={conversation.data}
            key={conversation.data.id}
            runtimeAgentId={task.botId}
          />
        )}
      </div>
    </>
  );
}
