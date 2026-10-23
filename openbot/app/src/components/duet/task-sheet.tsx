import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { RowButton } from "@/components/shell/activity-screen";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";
import { resolveTaskMutationOptions } from "@/lib/tasks/mutations";
import {
  liveStatus,
  type TaskRecord,
  taskKeys,
  taskQueryOptions,
  taskReportQueryOptions,
} from "@/lib/tasks/queries";
import { useConversationBusy } from "@/lib/tasks/use-task";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { ChannelTagOf } from "./channel-tag";
import { DuetIcon } from "./icons";
import { TaskStatusPill } from "./task-card";
import { noticedLine, TaskReportView } from "./task-report";

/*
 * A task, opened, as a report: a large card on the frosted veil, × at its top left and the title
 * across its header. Under it, when and why it was noticed, where it stands, and Mark done (Reopen
 * once it is done). Then the report itself (task-report.tsx): Decisions and updates, Resources, and
 * Show conversation, which unfolds the task's own conversation under them. The reply box sits at the
 * foot and sends into that conversation; sending unfolds it, so the reply is seen landing.
 *
 * Opened from its card in Chat or its row in Tasks, at `/tasks/<id>`, over the Tasks list. Never
 * over Chat itself: that would put two conversations on screen at once.
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
                <DialogPrimitive.Title className="type-row min-w-0 truncate px-1 text-center font-semibold">
                  {task.data?.title ?? ""}
                </DialogPrimitive.Title>
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

function TaskBody({ task }: { task: TaskRecord }) {
  // Open on screen is read, as a conversation's own page is.
  useMarkOpenChannelRead(task.channelId);
  const busy = useConversationBusy(task.channelId);
  const status = liveStatus(task.status, busy);
  const resolve = useMutation(resolveTaskMutationOptions(queryClient));
  const conversation = useQuery(channelQueryOptions(task.channelId));
  const report = useQuery(taskReportQueryOptions(task.id, status));
  const agents = useQuery(agentListQueryOptions());
  const botName =
    agents.data?.find((agent) => agent.id === task.botId)?.name ?? "your Bot";
  const [conversationShown, setConversationShown] = useState(false);
  const done = task.resolvedAt !== null;
  // A turn in the conversation just ended: what it said and did belongs in the report now.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy)
      void queryClient.invalidateQueries({
        queryKey: taskKeys.report(task.id),
      });
    wasBusy.current = busy;
  }, [busy, task.id]);
  return (
    <>
      <div className="shrink-0 border-duet-hair-2 border-b px-5 pt-0.5 pb-3">
        <p className="type-sub line-clamp-2 text-duet-ink-2">
          {noticedLine(task)}
        </p>
        <div className="mt-2.5 flex items-center justify-between gap-2.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <TaskStatusPill status={status} />
            <ChannelTagOf channelId={task.fromChannelId} />
          </span>
          <RowButton
            busy={resolve.isPending}
            label={done ? "Reopen this task" : "Mark this task done"}
            onClick={() => resolve.mutate({ id: task.id, done: !done })}
            primary={!done}
          >
            {done ? "Reopen" : "Mark done"}
          </RowButton>
        </div>
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
            folded={!conversationShown}
            key={conversation.data.id}
            lead={
              <TaskReportView
                botName={botName}
                conversationShown={conversationShown}
                error={report.error}
                onToggleConversation={() =>
                  setConversationShown((shown) => !shown)
                }
                pending={report.isPending}
                report={report.data}
              />
            }
            // A reply unfolds the conversation, so it is seen landing and answered.
            onSubmitted={() => setConversationShown(true)}
            runtimeAgentId={task.botId}
          />
        )}
      </div>
    </>
  );
}
