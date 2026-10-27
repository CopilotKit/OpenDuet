import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { tryTaskAgainMutationOptions } from "@/lib/tasks/mutations";
import {
  couldNotFinish,
  TASK_STATUS_LABEL,
  type TaskStatus,
} from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { DuetIcon, type DuetIconName } from "./icons";
import { CardRow, DuetCard, OutcomePill, type PillTone } from "./kit";
import { SafeSvg } from "./page-rich-block";

/*
 * A task OpenDuet is working on, as one compact row: what it is, where it stands, and a chevron that
 * opens it. It sits under the Bot's "On it" in Chat; Tasks draws its own rows (tasks-active.tsx).
 * The caller supplies the link.
 *
 * A task that couldn't finish says so on its status line, "Failed · Couldn't finish: <reason>.", and
 * has Try again under the row. The button sits outside the link, so pressing it never opens the task.
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
  thumbnail,
  status,
  failure = null,
  channel,
}: {
  title: string;
  thumbnail?: string | null | undefined;
  /** Null while the task has not been read yet: the row draws without a pill rather than a guess. */
  status: TaskStatus | null;
  /** Why it couldn't finish, said under the pill while it is failed. */
  failure?: string | null;
  /** The tag of the channel it was asked for in, beside the pill. */
  channel?: ReactNode;
}) {
  return (
    <CardRow
      detail={
        status === "failed" ? (
          <span className="mt-1 line-clamp-2 block" data-failure>
            <span className="text-duet-red" data-status="failed">
              {TASK_STATUS_LABEL.failed}
            </span>
            {` · ${couldNotFinish(failure)}`}
          </span>
        ) : status || channel ? (
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {status ? <TaskStatusPill status={status} /> : null}
            {channel}
          </span>
        ) : undefined
      }
      icon="tasks"
      title={
        <span className="flex items-center gap-2">
          <SafeSvg
            className="h-10 w-16 shrink-0 overflow-hidden rounded-lg"
            svg={thumbnail}
          />
          <span className="line-clamp-2">{title}</span>
        </span>
      }
      trailing={
        <span aria-hidden className="shrink-0 text-duet-ink-3">
          <DuetIcon name="chevronRight" size={18} stroke={2.2} />
        </span>
      }
    />
  );
}

/**
 * A task's own button: Try again, Mark done, Reopen. A full 44px target, which is what a finger
 * needs, so it is drawn here rather than as the 32px row button lists use.
 */
export function TaskButton({
  children,
  label,
  busy,
  onClick,
  primary = false,
}: {
  children: ReactNode;
  label: string;
  busy: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        "type-label min-h-[44px] max-w-full shrink-0 rounded-full px-4 py-2 font-semibold outline-none transition-[filter,background-color] focus-visible:ring-3 focus-visible:ring-duet-violet/40 disabled:opacity-50",
        primary
          ? "bg-duet-black text-duet-on-black hover:brightness-125"
          : "text-duet-ink shadow-[inset_0_0_0_1px_var(--duet-hair)] hover:bg-duet-tile",
      )}
      disabled={busy}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * Try again, under a failed task's row: its turn runs once more in its own conversation, and the
 * row reads Working until that run ends.
 */
export function TryTaskAgain({
  taskId,
  className = "pr-4 pb-3 pl-[69px]",
}: {
  taskId: string;
  /** Its inset, lined up with the title of whatever row it sits under. */
  className?: string;
}) {
  const again = useMutation(tryTaskAgainMutationOptions(queryClient));
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", className)}
    >
      <TaskButton
        busy={again.isPending}
        label="Try this task again"
        onClick={() => again.mutate({ id: taskId })}
        primary
      >
        Try again
      </TaskButton>
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
  thumbnail,
  status,
  failure = null,
  channel,
  link,
}: {
  taskId: string;
  title: string;
  thumbnail?: string | null | undefined;
  status: TaskStatus | null;
  failure?: string | null;
  /** The tag of the channel it was asked for in. */
  channel?: ReactNode;
  /** Wraps the row in whatever opens the task: a router link, given the row and its class. */
  link: (props: { className: string; children: ReactNode }) => ReactNode;
}) {
  return (
    <DuetCard>
      {link({
        className:
          "group block w-full rounded-[22px] outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 focus-visible:ring-inset",
        children: (
          <div className="transition-transform motion-safe:group-active:scale-[0.985]">
            <TaskRow
              channel={channel}
              failure={failure}
              status={status}
              title={title}
              thumbnail={thumbnail}
            />
          </div>
        ),
      })}
      {status === "failed" ? <TryTaskAgain taskId={taskId} /> : null}
    </DuetCard>
  );
}

/**
 * A task's glyph on its link in Chat (parity-spec S5): a spinning ring while it works, an amber dot
 * while it needs the person, a green check once it is ready for review, a grey check once done, and
 * a red cross when it couldn't finish. Nothing until it has been read, rather than a guess.
 */
export function TaskGlyph({ status }: { status: TaskStatus | null }) {
  if (status === null || status === "working")
    return (
      <span
        aria-hidden
        className="block size-[14px] animate-spin rounded-full border-[1.75px] border-duet-blue/25 border-t-duet-blue motion-reduce:animate-none"
        data-glyph="working"
      />
    );
  if (status === "needs_input")
    return (
      <span
        aria-hidden
        className="grid size-[14px] place-items-center"
        data-glyph="needs_input"
      >
        <span className="block size-2 rounded-full bg-duet-amber" />
      </span>
    );
  const tone =
    status === "ready_for_review"
      ? "text-duet-green"
      : status === "failed"
        ? "text-duet-red"
        : "text-duet-ink-3";
  return (
    <span aria-hidden className={tone} data-glyph={status}>
      <DuetIcon
        name={status === "failed" ? "x" : "check"}
        size={14}
        stroke={2.6}
      />
    </span>
  );
}

/**
 * The line Chat draws under the Bot's "On it" (parity-spec Chat 5, S5): the transcript's hook, the
 * task's live glyph and its title on one line, cut with an ellipsis. Not a card: no tile, no pill,
 * no chevron. It opens the task's page; the caller supplies the link.
 */
export function TaskLink({
  title,
  thumbnail,
  status,
  link,
}: {
  title: string;
  thumbnail?: string | null | undefined;
  status: TaskStatus | null;
  /** Wraps the line in whatever opens the task: a router link, given its class and contents. */
  link: (props: { className: string; children: ReactNode }) => ReactNode;
}) {
  return link({
    className:
      "duet-face flex min-h-11 max-w-full items-center gap-[7px] rounded-xl pl-1 outline-none transition-opacity focus-visible:ring-3 focus-visible:ring-duet-violet/40 hover:opacity-80",
    children: (
      <>
        <svg
          aria-hidden
          className="mb-[9px] shrink-0 text-duet-ink-3"
          height={14}
          viewBox="0 0 14 14"
          width={14}
        >
          <path
            d="M1 1v6a6 6 0 0 0 6 6h6"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth={1.2}
          />
        </svg>
        <span className="grid shrink-0 place-items-center">
          <TaskGlyph status={status} />
        </span>
        <SafeSvg
          className="h-9 w-14 shrink-0 overflow-hidden rounded-lg"
          svg={thumbnail}
        />
        <span className="type-sub min-w-0 truncate text-duet-ink-2">
          {title}
        </span>
        {status ? (
          <span className="sr-only" data-status={status}>
            {TASK_STATUS_LABEL[status]}
          </span>
        ) : null}
      </>
    ),
  });
}
