import type { ReactNode } from "react";
import { TASK_STATUS_LABEL, type TaskStatus } from "@/lib/tasks/queries";
import { DuetIcon, type DuetIconName } from "./icons";
import { CardRow, DuetCard, OutcomePill, type PillTone } from "./kit";

/*
 * A task OpenDuet is working on, as one compact row: what it is, where it stands, and a chevron that
 * opens it. It sits under the Bot's "On it" in Chat; Tasks draws its own rows (tasks-active.tsx).
 * The caller supplies the link.
 */

const PILL: Record<TaskStatus, { tone: PillTone; icon: DuetIconName | null }> =
  {
    working: { tone: "blue", icon: "clock" },
    needs_input: { tone: "amber", icon: "inbox" },
    ready_for_review: { tone: "green", icon: "checkCircle" },
    resolved: { tone: "neutral", icon: "check" },
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
  channel,
}: {
  title: string;
  /** Null while the task has not been read yet: the row draws without a pill rather than a guess. */
  status: TaskStatus | null;
  /** The tag of the channel it was asked for in, beside the pill. */
  channel?: ReactNode;
}) {
  return (
    <CardRow
      detail={
        status || channel ? (
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {status ? <TaskStatusPill status={status} /> : null}
            {channel}
          </span>
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

/** The card Chat draws under the Bot's "On it": the row on a card of its own. */
export function TaskCard({
  title,
  status,
  channel,
  link,
}: {
  title: string;
  status: TaskStatus | null;
  /** The tag of the channel it was asked for in. */
  channel?: ReactNode;
  /** Wraps the card in whatever opens the task: a router link, given the card's content and class. */
  link: (props: { className: string; children: ReactNode }) => ReactNode;
}) {
  return link({
    className:
      "group block w-full rounded-[22px] outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40",
    children: (
      <DuetCard className="transition-transform duration-150 motion-safe:group-active:scale-[0.985]">
        <TaskRow channel={channel} status={status} title={title} />
      </DuetCard>
    ),
  });
}
