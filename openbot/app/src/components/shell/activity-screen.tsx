import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import type { DuetIconName } from "@/components/duet/icons";
import { CardRow, DuetCard, Rule, type TileTone } from "@/components/duet/kit";
import {
  approvalPlace,
  clockTime,
  decisionReceipt,
  describeApproval,
  personWasAsked,
} from "@/lib/approval-view";
import type { ApprovalRequest } from "@/lib/approvals";
import type { ActivityItem, ActivityKind } from "@/lib/bot-lifecycle/queries";
import { cn } from "@/lib/utils";

/*
 * The rows Tasks draws for the product's own Bot's work: Working on, Coming up and Done, read from
 * the ledgers OpenBot already keeps. This was the Activity tab; its "Handled for you" list is Done
 * at the foot of Tasks now, and the tab is Pages.
 */

/** One line of Working on, Coming up or Done on Tasks, from whichever ledger it came from. */
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
 * What a Bot did that the person allowed or refused: the actions it paused for an answer, once
 * answered. Green when it went, red when they refused, amber when it was allowed and did not work.
 */
export function answeredRows(
  requests: readonly ApprovalRequest[],
  botId: string,
): ActivityRow[] {
  return requests
    .filter(
      (request) =>
        request.action.botId === botId &&
        request.status !== "pending" &&
        // A send to other people is always put to the person, by the share check rather than a
        // policy verdict, so it counts as asked too.
        personWasAsked(request) &&
        request.decision,
    )
    .map((request) => {
      const refused = request.decision === "deny";
      const failed = Boolean(request.result?.error);
      return {
        id: `approval:${request.id}`,
        icon: refused || failed ? "x" : "check",
        tone: refused ? "red" : failed ? "amber" : "green",
        title: describeApproval(request).title,
        detail: [
          decisionReceipt(request),
          failed ? "Didn't work" : null,
          approvalPlace(request),
        ]
          .filter(Boolean)
          .join(" · "),
        at: request.completedAt ?? request.decidedAt ?? request.createdAt,
        channelId: null,
      } satisfies ActivityRow;
    });
}

/**
 * What the product's own Bot finished for the person, newest first: its routines, follow-ups and
 * delegated work from the ledgers OpenBot keeps, and the actions the person answered. Tasks lists
 * them under Done.
 */
export function handledRows(
  completed: readonly ActivityItem[],
  requests: readonly ApprovalRequest[],
  botId: string,
  limit = 25,
): ActivityRow[] {
  return [...completed.map(completedRow), ...answeredRows(requests, botId)]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/**
 * The film's "Handled for you" card, which Tasks uses for Working on, Coming up and Done: a heading,
 * then one row per thing, hairlines between. Each row carries its own time, since the things in one
 * card did not all happen at once.
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
    <section aria-label={title}>
      <DuetCard>
        <div className="flex h-[54px] items-center gap-2 px-4">
          <h2 className="type-row font-semibold">{title}</h2>
        </div>
        <ul>
          {rows.map((row, index) => (
            <Fragment key={row.id}>
              {index > 0 ? <Rule inset /> : null}
              <li>
                <ActivityLine row={row} showTime={showTime} />
              </li>
            </Fragment>
          ))}
        </ul>
      </DuetCard>
    </section>
  );
}

function ActivityLine({
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
    "block min-w-0 flex-1 rounded-[14px] outline-none hover:bg-duet-tile/60 focus-visible:ring-3 focus-visible:ring-duet-violet/25";
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
        "type-label h-8 shrink-0 rounded-full px-3 font-semibold disabled:opacity-50",
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
