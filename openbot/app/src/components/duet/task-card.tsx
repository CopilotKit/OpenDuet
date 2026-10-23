import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { RowButton } from "@/components/shell/activity-screen";
import { tryTaskAgainMutationOptions } from "@/lib/tasks/mutations";
import {
  couldNotFinish,
  TASK_STATUS_LABEL,
  type TaskStatus,
} from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";
import { DuetIcon, type DuetIconName } from "./icons";
import { CardRow, DuetCard, OutcomePill, type PillTone } from "./kit";

/*
 * A task OpenDuet is working on, as one compact row: what it is, where it stands, and a chevron that
 * opens it. The same row sits under the Bot's "On it" in Chat and in Tasks' Your tasks. The caller
 * supplies the link, since a task opens from both.
 *
 * A task that couldn't finish says why under its pill, and has Try again under the row. The button
 * sits outside the link, so pressing it never opens the task.
 */

const PILL: Record<TaskStatus, { tone: PillTone; icon: DuetIconName | null }> =
  {
    working: { tone: "blue", icon: "clock" },
    needs_input: { tone: "amber", icon: "inbox" },
    ready_for_review: { tone: "green", icon: "checkCircle" },
    resolved: { tone: "neutral", icon: "check" },
    failed: { tone: "red", icon: "x" },
  };

/** Where a task stands, in a word or two. */
export function TaskStatusPill({ status }: { status: TaskStatus }) {
  const pill = PILL[status];
  return (
    <span data-status={status}>
      <OutcomePill icon={pill.icon} tone={pill.tone}>
        {TASK_STATUS_LABEL[status]}
      </OutcomePill>
    </span>
  );
}

/** The row itself, with no card around it, for a list that draws its own. */
export function TaskRow({
  title,
  status,
  failure = null,
}: {
  title: string;
  /** Null while the task has not been read yet: the row draws without a pill rather than a guess. */
  status: TaskStatus | null;
  /** Why it couldn't finish, said under the pill while it is failed. */
  failure?: string | null;
}) {
  return (
    <CardRow
      detail={
        status ? (
          <>
            <span className="mt-1.5 flex">
              <TaskStatusPill status={status} />
            </span>
            {status === "failed" ? (
              <span className="mt-1 line-clamp-2 block" data-failure>
                {couldNotFinish(failure)}
              </span>
            ) : null}
          </>
        ) : undefined
      }
      icon="tasks"
      title={<span className="line-clamp-2">{title}</span>}
      trailing={
        <span aria-hidden className="shrink-0 text-duet-ink-3">
          <DuetIcon name="chevronRight" size={18} stroke={2.2} />
        </span>
      }
    />
  );
}

/**
 * Try again, under a failed task's row: its turn runs once more in its own conversation, and the
 * row reads Working until that run ends.
 */
export function TryTaskAgain({ taskId }: { taskId: string }) {
  const again = useMutation(tryTaskAgainMutationOptions(queryClient));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pr-4 pb-3 pl-[69px]">
      <RowButton
        busy={again.isPending}
        label="Try this task again"
        onClick={() => again.mutate(taskId)}
        primary
      >
        Try again
      </RowButton>
      {again.error ? (
        <p className="type-label text-duet-red" role="alert">
          {again.error.message}
        </p>
      ) : null}
    </div>
  );
}

/** The card Chat draws under the Bot's "On it": the row on a card of its own. */
export function TaskCard({
  taskId,
  title,
  status,
  failure = null,
  link,
}: {
  taskId: string;
  title: string;
  status: TaskStatus | null;
  failure?: string | null;
  /** Wraps the row in whatever opens the task: a router link, given the row and its class. */
  link: (props: { className: string; children: ReactNode }) => ReactNode;
}) {
  return (
    <DuetCard>
      {link({
        className:
          "group block w-full rounded-[22px] outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 focus-visible:ring-inset",
        children: (
          <div className="transition-transform duration-150 motion-safe:group-active:scale-[0.985]">
            <TaskRow failure={failure} status={status} title={title} />
          </div>
        ),
      })}
      {status === "failed" ? <TryTaskAgain taskId={taskId} /> : null}
    </DuetCard>
  );
}
