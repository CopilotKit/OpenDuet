import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ConversationView } from "@/components/channels/conversation-view";
import { clockTime } from "@/lib/approval-view";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";
import {
  resolveTaskMutationOptions,
  tryTaskAgainMutationOptions,
} from "@/lib/tasks/mutations";
import {
  failedConversationQueryOptions,
  failureLine,
  liveStatus,
  type TaskRecord,
  taskQueryOptions,
} from "@/lib/tasks/queries";
import { useConversationBusy } from "@/lib/tasks/use-task";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { DuetIcon } from "./icons";
import { TaskButton, TaskStatusPill } from "./task-card";

/*
 * A task, opened: a large card on the frosted veil, × at its top left and the title across its
 * header with when it started, then where it stands with Mark done (Reopen once it is done), then
 * the task's own conversation, where the person can reply to steer it.
 *
 * Opened from its card in Chat or its row in Tasks, at `/tasks/<id>`, over the Tasks list. Never
 * over Chat itself: that would put two conversations on screen at once.
 *
 * A task that couldn't finish says why under its pill, and offers Try again beside Mark done: its
 * turn runs once more in this conversation. A reply typed on it does the same, with the person's
 * words beside the ask, so a reply never runs without the task (see `FailedConversation`).
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

/**
 * The Bot's line saying the task couldn't finish and why, as the page's last update: the same words
 * it recorded in the task's conversation, and when.
 */
function FailureUpdate({ task }: { task: TaskRecord }) {
  const when = task.failedAt ? clockTime(task.failedAt) : null;
  return (
    <div className="flex flex-col gap-0.5" data-failure>
      <p className="type-sub text-duet-ink">{failureLine(task.failure)}</p>
      {when ? <p className="type-label text-duet-ink-3">{when}</p> : null}
    </div>
  );
}

function TaskBody({ task }: { task: TaskRecord }) {
  // Open on screen is read, as a conversation's own page is.
  useMarkOpenChannelRead(task.channelId);
  const busy = useConversationBusy(task.channelId);
  const status = liveStatus(task.status, busy);
  const resolve = useMutation(resolveTaskMutationOptions(queryClient));
  const again = useMutation(tryTaskAgainMutationOptions(queryClient));
  const conversation = useQuery(channelQueryOptions(task.channelId));
  const done = task.resolvedAt !== null;
  const failed = status === "failed";
  const error = resolve.error ?? again.error;
  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 border-duet-hair-2 border-b px-5 pt-1 pb-3">
        <div className="flex items-center justify-between gap-2.5">
          <TaskStatusPill status={status} />
          <div className="flex items-center gap-2">
            <TaskButton
              busy={resolve.isPending}
              label={done ? "Reopen this task" : "Mark this task done"}
              onClick={() => resolve.mutate({ id: task.id, done: !done })}
              primary={!done && !failed}
            >
              {done ? "Reopen" : "Mark done"}
            </TaskButton>
            {failed ? (
              <TaskButton
                busy={again.isPending}
                label="Try this task again"
                onClick={() => again.mutate({ id: task.id })}
                primary
              >
                Try again
              </TaskButton>
            ) : null}
          </div>
        </div>
        {failed ? <FailureUpdate task={task} /> : null}
      </div>
      {error ? (
        <p className="type-label px-5 pt-2 text-duet-red" role="alert">
          {error.message}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col px-3">
        {conversation.isPending ? null : conversation.error ||
          !conversation.data ? (
          <p className="type-sub px-2 pt-4 text-duet-red" role="alert">
            Couldn't load this task's conversation. Close it and try again.
          </p>
        ) : failed ? (
          <FailedConversation
            busy={again.isPending}
            onReply={(reply) => again.mutateAsync({ id: task.id, reply })}
            task={task}
            threadId={conversation.data.threadId}
          />
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

/**
 * A failed task's conversation: what its runs left, read from the history store, with a composer
 * whose reply is Try again with the person's words.
 *
 * NOT THE LIVE CONVERSATION. Sent there, a reply would start a turn of its own beside the task, and
 * when the task's ask never reached the thread the Bot would answer it without the task. So while
 * the task is failed, a reply goes to the server with the ask (`POST /again`), and the run it starts
 * is the task's own turn. Once that run is under way the page draws the live conversation again.
 */
function FailedConversation({
  task,
  threadId,
  busy,
  onReply,
}: {
  task: TaskRecord;
  threadId: string;
  busy: boolean;
  onReply: (reply: string) => Promise<unknown>;
}) {
  const stored = useQuery(
    failedConversationQueryOptions({
      taskId: task.id,
      threadId,
      botId: task.botId,
    }),
  );
  return (
    <ConversationView
      busy={busy}
      messages={stored.data?.messages ?? []}
      notice={
        <p className="type-label px-2 text-duet-ink-3">
          Your reply runs this task again.
        </p>
      }
      onSubmit={async (draft) => {
        if (draft.text.trim()) await onReply(draft.text.trim());
      }}
      placeholder="Message OpenDuet"
      restoring={stored.isPending}
    />
  );
}
