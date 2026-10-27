import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import type { DuetIconName } from "@/components/duet/icons";
import { CardRow, DuetCard, Rule, type TileTone } from "@/components/duet/kit";
import { clockTime } from "@/lib/approval-view";
import type { ActivityItem, ActivityKind } from "@/lib/bot-lifecycle/queries";
import { cn } from "@/lib/utils";

/*
 * The rows Tasks draws for the product's own Bot's work: what is under Working and Resolved on
 * Active, and Coming up on Up next, read from the ledgers OpenBot already keeps. This was the
 * Activity tab; its "Handled for you" list is part of Resolved now, and the tab is Pages.
 */

/** One line of Working, Resolved or Coming up on Tasks, from whichever ledger it came from. */
export type ActivityRow = {
  id: string;
  icon: DuetIconName;
  tone: TileTone;
  title: string;
  detail: string;
  at: string;
  channelId: string | null;
  /** A task's row opens the task, over Tasks, rather than a conversation. */
  taskId?: string;
  control?: ReactNode;
};

const KIND_WORD: Record<ActivityKind, string> = {
  routine: "Routine",
  responsibility: "Responsibility",
  handoff: "Delegated task",
  approval: "Approval",
  question: "Question",
  follow_up: "Follow-up",
};

const KIND_ICON: Record<ActivityKind, DuetIconName> = {
  routine: "clock",
  responsibility: "shieldCheck",
  handoff: "chat",
  approval: "shield",
  question: "question",
  follow_up: "clock",
};

/** The ledgers' states, in the words a person uses. Unknown states are shown as they are. */
const STATUS_WORDS: Record<string, string> = {
  succeeded: "Done",
  success: "Done",
  completed: "Done",
  done: "Done",
  delivered: "Delivered",
  failed: "Didn't finish",
  error: "Didn't finish",
  stopped: "Stopped",
  cancelled: "Cancelled",
  running: "Working on it",
  retrying: "Trying again",
  queued: "Queued",
  scheduled: "Scheduled",
  active: "Active",
  waiting: "Waiting for you",
  "waiting for you": "Waiting for you",
};

const statusWord = (status: string) =>
  STATUS_WORDS[status.toLowerCase()] ??
  status.charAt(0).toUpperCase() + status.slice(1);

const FAILED = /fail|error|gave up|stopped|cancel/i;

/** A finished item: green when it worked, amber when it did not. */
export function completedRow(item: ActivityItem): ActivityRow {
  const failed = FAILED.test(item.status);
  return {
    id: item.id,
    icon: failed ? "x" : "check",
    tone: failed ? "amber" : "green",
    title: item.title,
    detail: [KIND_WORD[item.kind], statusWord(item.status), item.detail]
      .filter(Boolean)
      .join(" · "),
    at: item.at,
    channelId: item.channelId,
  };
}

/** Something under way: violet when it is waiting on the person, blue while the Bot works. */
export function workingRow(item: ActivityItem): ActivityRow {
  return {
    id: item.id,
    icon: item.needsYou ? "inbox" : KIND_ICON[item.kind],
    tone: item.needsYou ? "violet" : "blue",
    title: item.title,
    detail: [KIND_WORD[item.kind], statusWord(item.status), item.detail]
      .filter(Boolean)
      .join(" · "),
    at: item.at,
    channelId: item.channelId,
  };
}

/** Something lined up for later. Grey, since nothing has happened yet. */
export function upcomingRow(item: ActivityItem): ActivityRow {
  return {
    id: item.id,
    icon: KIND_ICON[item.kind],
    tone: "neutral",
    title: item.title,
    detail: [KIND_WORD[item.kind], item.detail].filter(Boolean).join(" · "),
    at: item.at,
    channelId: item.channelId,
  };
}

/**
 * What the product's own Bot finished for the person, newest first: its routines, follow-ups and
 * delegated work from the ledgers OpenBot keeps. Tasks lists them under Resolved. The actions the
 * person answered are not among them: a receipt is not finished work, and the conversation shows
 * the action that ran.
 */
export function handledRows(
  completed: readonly ActivityItem[],
  limit = 25,
): ActivityRow[] {
  return completed
    .map(completedRow)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/**
 * A Tasks section's heading: its name and how many are in it, separated by one space, in quiet grey
 * so the rows lead. `children` sits at the heading's right.
 */
export function SectionHeading({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-2 px-1">
      <h2 className="font-normal text-[15px] text-duet-ink-2 leading-5">
        {title}
        {count === undefined ? null : ` ${count}`}
      </h2>
      {children}
    </div>
  );
}

/** A section of Tasks: its heading and count, then its rows in one card, hairlines between. */
export function TaskSection({
  title,
  items,
}: {
  title: string;
  items: { key: string; node: ReactNode }[];
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <SectionHeading count={items.length} title={title} />
      <DuetCard>
        <ul>
          {items.map((item, index) => (
            <Fragment key={item.key}>
              {index > 0 ? <Rule inset /> : null}
              <li>{item.node}</li>
            </Fragment>
          ))}
        </ul>
      </DuetCard>
    </section>
  );
}

/**
 * A section of the product's own Bot's work, from its ledgers: one row per thing, each with its own
 * time, since the things in one section did not all happen at once.
 */
export function ActivityCard({
  title,
  rows,
  showTime = true,
}: {
  title: string;
  rows: ActivityRow[];
  showTime?: boolean;
}) {
  return (
    <TaskSection
      items={rows.map((row) => ({
        key: row.id,
        node: <ActivityLine row={row} showTime={showTime} />,
      }))}
      title={title}
    />
  );
}

/** One ledger row, opening its conversation when it has one, with its control or its time. */
export function ActivityLine({
  row,
  showTime,
}: {
  row: ActivityRow;
  showTime: boolean;
}) {
  const when = showTime ? clockTime(row.at) : "";
  const time = when ? (
    <span className="type-label shrink-0 self-start pt-0.5 font-medium text-duet-ink-3">
      {when}
    </span>
  ) : undefined;
  const line = (trailing: ReactNode) => (
    <CardRow
      detail={row.detail}
      icon={row.icon}
      title={row.title}
      tone={row.tone}
      trailing={trailing}
    />
  );
  const linkClass =
    "block min-w-0 flex-1 rounded-[14px] outline-none transition-colors hover:bg-duet-tile/60 focus-visible:ring-3 focus-visible:ring-duet-violet/25";
  const link = row.taskId ? (
    <Link
      className={linkClass}
      params={{ taskId: row.taskId }}
      to="/tasks/$taskId"
    >
      {line(row.control ? undefined : time)}
    </Link>
  ) : row.channelId ? (
    <Link
      className={linkClass}
      params={{ channelId: row.channelId }}
      to="/channel/$channelId"
    >
      {line(row.control ? undefined : time)}
    </Link>
  ) : null;
  if (!link) return line(row.control ?? time);
  if (!row.control) return link;
  // The control sits beside the link rather than inside it, so a button is never nested in a link
  // and the rest of the row still opens the conversation.
  return (
    <div className="flex items-center">
      {link}
      <div className="shrink-0 pr-4">{row.control}</div>
    </div>
  );
}

/** A small pill on a row: Stop, Cancel, Hide, or Start in black as the one to press. */
export function RowButton({
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
        "type-label h-8 shrink-0 rounded-full px-3 font-semibold transition-[filter,background-color] disabled:opacity-50",
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
