import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { clockTime } from "@/lib/approval-view";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";
import {
  replyToTaskMutationOptions,
  resolveTaskMutationOptions,
  tryTaskAgainMutationOptions,
} from "@/lib/tasks/mutations";
import {
  failureLine,
  liveStatus,
  type TaskRecord,
  taskKeys,
  taskQueryOptions,
  taskReportQueryOptions,
} from "@/lib/tasks/queries";
import { useConversationBusy } from "@/lib/tasks/use-task";
import { useSheetPresence } from "@/hooks/use-sheet-presence";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { ChannelTagOf } from "./channel-tag";
import { DuetIcon } from "./icons";
import { TaskButton, TaskStatusPill } from "./task-card";
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
 *
 * A task that couldn't finish says why under its pill, and offers Try again beside Mark done: its
 * turn runs once more in this conversation. A reply typed on it does the same, with the person's
 * words as their message and the ask beside them, so a reply never runs without the task. While the
 * task's own turn runs on the server, replies wait in the conversation's queue and go when it ends.
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
  // Fades out and sinks a little before the route closes it (use-sheet-presence.ts).
  const presence = useSheetPresence();
  const close = () => presence.close(onClose);
  return (
    <DialogPrimitive.Root
      onOpenChange={(next) => {
        if (!next) close();
      }}
      onOpenChangeComplete={presence.onOpenChangeComplete}
      open={presence.open}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          aria-modal="true"
          className={cn(
            "duet-veil duet-face group fixed inset-0 z-50 flex flex-col text-duet-ink outline-none",
            "transition-opacity duration-[var(--duet-dur-enter)] data-ending-style:duration-[var(--duet-dur-swap)] data-ending-style:opacity-0 data-starting-style:opacity-0",
          )}
          // The sheet takes focus, not ×, so a stray Enter does not close what was just opened.
          initialFocus={popup}
          ref={popup}
        >
          <div className="mx-auto flex min-h-0 w-full max-w-[430px] flex-1 flex-col px-2.5 pt-[max(env(safe-area-inset-top),12px)] pb-[max(env(safe-area-inset-bottom),10px)]">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] bg-duet-card shadow-duet-raised transition-transform duration-[var(--duet-dur-sheet)] group-data-ending-style:duration-[var(--duet-dur-swap)] motion-reduce:transition-none motion-safe:group-data-ending-style:translate-y-3 motion-safe:group-data-starting-style:translate-y-6">
              <header className="grid min-h-16 shrink-0 grid-cols-[44px_1fr_44px] items-center px-2 py-1">
                <button
                  aria-label="Close"
                  className="grid size-[44px] place-items-center rounded-full text-duet-ink outline-none transition-colors hover:bg-duet-tile focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:bg-duet-tile"
                  onClick={close}
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
      <p className="type-label pt-1 text-duet-ink-3">
        Your reply runs this task again.
      </p>
    </div>
  );
}

/** What a refused Try again or reply says, when it lost to a run already going. */
const STILL_FINISHING =
  "OpenDuet is still finishing something. Send this again when it's done.";
const friendly = (error: Error) =>
  /already running|couldn't finish can be tried/i.test(error.message)
    ? STILL_FINISHING
    : error.message;

function TaskBody({ task }: { task: TaskRecord }) {
  // Open on screen is read, as a conversation's own page is.
  useMarkOpenChannelRead(task.channelId);
  const busy = useConversationBusy(task.channelId);
  const status = liveStatus(task.status, busy);
  const resolve = useMutation(resolveTaskMutationOptions(queryClient));
  const reply = useMutation(replyToTaskMutationOptions(queryClient));
  const again = useMutation(tryTaskAgainMutationOptions(queryClient));
  const conversation = useQuery(channelQueryOptions(task.channelId));
  const report = useQuery(taskReportQueryOptions(task.id, status));
  const agents = useQuery(agentListQueryOptions());
  const botName =
    agents.data?.find((agent) => agent.id === task.botId)?.name ?? "your Bot";
  const [conversationShown, setConversationShown] = useState(false);
  const done = task.resolvedAt !== null;
  const failed = status === "failed";
  /*
   * A turn is running in the task's conversation, or about to: its own on the server, or one another
   * tab started (the working dot). Replies wait for it, so two tabs never send into one turn.
   */
  const serverTurn = task.status === "working" || again.isPending || busy;
  /*
   * While the task carries a failure, failed or marked done after failing, a reply runs it again:
   * the person's words as their own message, with the ask beside them, as the task's own turn.
   */
  const replyRunsTask = task.failure !== null && !serverTurn;
  const [contextError, setContextError] = useState<Error | null>(null);
  const error = contextError ?? resolve.error ?? again.error ?? reply.error;
  function clearActionErrors() {
    setContextError(null);
    // A new action owns the notice; keep pending mutations attached so their busy state survives.
    for (const mutation of [resolve, again, reply]) {
      if (mutation.error) mutation.reset();
    }
  }
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
      <div className="flex max-h-[50%] shrink-0 flex-col gap-2 overflow-y-auto border-duet-hair-2 border-b px-5 pt-0.5 pb-3">
        <p className="type-sub line-clamp-2 shrink-0 text-duet-ink-2">
          {noticedLine(task)}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <TaskStatusPill status={status} />
            <ChannelTagOf channelId={task.fromChannelId} />
          </span>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <TaskButton
              busy={resolve.isPending}
              label={done ? "Reopen this task" : "Mark this task done"}
              onClick={() => {
                clearActionErrors();
                resolve.mutate({ id: task.id, done: !done });
              }}
              primary={!done && !failed}
            >
              {done ? "Reopen" : "Mark done"}
            </TaskButton>
            {failed ? (
              <TaskButton
                busy={again.isPending}
                label="Try this task again"
                onClick={() => {
                  clearActionErrors();
                  again.mutate({ id: task.id });
                }}
                primary
              >
                Try again
              </TaskButton>
            ) : null}
          </div>
        </div>
        {replyRunsTask ? <FailureUpdate task={task} /> : null}
      </div>
      {error ? (
        <p className="type-label px-5 pt-2 text-duet-red" role="alert">
          {friendly(error)}
        </p>
      ) : null}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col px-3",
          // A reply that runs the task carries words only: no attachment button, not even a greyed one.
          replyRunsTask &&
            "[&_button[aria-label='More_message_options_unavailable']]:hidden",
        )}
      >
        {conversation.isPending ? null : conversation.error ||
          !conversation.data ? (
          <p className="type-sub px-2 pt-4 text-duet-red" role="alert">
            Couldn't load this task's conversation. Close it and try again.
          </p>
        ) : (
          /*
           * ONE CONVERSATION IN EVERY STATE. Failed, working on the server, or waiting on the person,
           * it is the same one, so nothing typed or queued is lost when the state changes under it.
           */
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
            task={{
              busy: serverTurn,
              queued: task.queuedReplies ?? [],
              durable: !replyRunsTask,
              send: async ({ text, messageId, ...context }) => {
                clearActionErrors();
                if (replyRunsTask) {
                  // A draft may have acquired files or skills before a background turn failed.
                  // The retry endpoint carries words only; preserve the draft instead of dropping context.
                  if (
                    context.attachmentIds?.length ||
                    context.skillIds?.length
                  ) {
                    const error = new Error(
                      "This task now needs a retry. Remove attachments and skills before sending again.",
                    );
                    setContextError(error);
                    throw error;
                  }
                  try {
                    await again.mutateAsync({
                      id: task.id,
                      reply: text,
                      messageId,
                    });
                    return;
                  } catch (error) {
                    if (
                      !(error instanceof Error) ||
                      !/already running|couldn't finish can be tried/i.test(
                        error.message,
                      )
                    )
                      throw error;
                    // The durable reply now owns this send, including any failure it reports.
                    again.reset();
                  }
                }
                await reply.mutateAsync({
                  ...context,
                  id: task.id,
                  reply: text,
                  messageId,
                });
              },
            }}
          />
        )}
      </div>
    </>
  );
}
