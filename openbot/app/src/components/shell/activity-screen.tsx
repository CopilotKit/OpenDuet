import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import type { DuetIconName } from "@/components/duet/icons";
import { CardRow, DuetCard, Rule, type TileTone } from "@/components/duet/kit";
import { primaryBot } from "@/lib/agents/primary-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  clockTime,
  decisionReceipt,
  describeApproval,
} from "@/lib/approval-view";
import { approvalInboxOptions } from "@/lib/approvals";
import {
  cancelFollowUpMutationOptions,
  stopHandoffMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type ActivityItem,
  type ActivityKind,
  botActivityQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { queryClient } from "@/query-client";
import { ScreenNotice } from "./chat-screen";
import { ScreenScroll, ScreenTitle } from "./screen";

/** One line of the Activity tab, from whichever ledger it came from. */
export type ActivityRow = {
  id: string;
  icon: DuetIconName;
  tone: TileTone;
  title: string;
  detail: string;
  at: string;
  channelId: string | null;
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

/**
 * The Activity tab: what the product's own Bot did for the person, in plain words. Read from the
 * ledgers OpenBot already keeps (routine and responsibility runs, delegated tasks, follow-ups) and
 * from the actions the person answered in the Inbox. Nothing here is written for the screen.
 */
export function ActivityScreen() {
  const agents = useQuery(agentListQueryOptions());
  const bot = primaryBot(agents.data);
  const activity = useQuery({
    ...botActivityQueryOptions(bot?.id ?? ""),
    enabled: Boolean(bot),
  });
  const inbox = useQuery(approvalInboxOptions());
  const stop = useMutation(stopHandoffMutationOptions(queryClient));
  const cancel = useMutation(cancelFollowUpMutationOptions(queryClient));

  if (agents.isPending) return null;
  if (!agents.data)
    return (
      <ScreenNotice alert>
        Couldn't load your Bots. Reload the page.
      </ScreenNotice>
    );
  if (!bot) return <ScreenNotice>There are no Bots yet.</ScreenNotice>;
  const botId = bot.id;

  // The actions this Bot paused for an answer, once answered: what the person allowed or refused.
  const answered: ActivityRow[] = (inbox.data?.requests ?? [])
    .filter(
      (request) =>
        request.action.botId === botId &&
        request.status !== "pending" &&
        request.action.policy &&
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
          request.action.scope,
        ]
          .filter(Boolean)
          .join(" · "),
        at: request.completedAt ?? request.decidedAt ?? request.createdAt,
        channelId: null,
      } satisfies ActivityRow;
    });

  const data = activity.data;
  const working: ActivityRow[] = (data?.inProgress ?? []).map((item) => ({
    id: item.id,
    icon: item.needsYou ? "inbox" : KIND_ICON[item.kind],
    tone: item.needsYou ? "violet" : "blue",
    title: item.title,
    detail: [KIND_WORD[item.kind], statusWord(item.status), item.detail]
      .filter(Boolean)
      .join(" · "),
    at: item.at,
    channelId: item.channelId,
    control: item.stoppable ? (
      <RowButton
        busy={stop.isPending && stop.variables?.id === item.id}
        label={`Stop ${item.title}`}
        onClick={() => stop.mutate({ agentId: botId, id: item.id })}
      >
        Stop
      </RowButton>
    ) : undefined,
  }));
  const handled = [...(data?.completed ?? []).map(completedRow), ...answered]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 25);
  const upcoming: ActivityRow[] = (data?.scheduled ?? []).map((item) => ({
    id: item.id,
    icon: KIND_ICON[item.kind],
    tone: "neutral",
    title: item.title,
    detail: [KIND_WORD[item.kind], item.detail].filter(Boolean).join(" · "),
    at: item.at,
    channelId: item.channelId,
    control: item.cancellable ? (
      <RowButton
        busy={cancel.isPending && cancel.variables?.id === item.id}
        label={`Cancel ${item.title}`}
        onClick={() => cancel.mutate({ agentId: botId, id: item.id })}
      >
        Cancel
      </RowButton>
    ) : undefined,
  }));
  const problem = activity.error ?? stop.error ?? cancel.error;

  return (
    <ScreenScroll>
      <ScreenTitle title="Activity">
        What {bot.name} did for you, and what it does next.
      </ScreenTitle>
      {problem ? (
        <p className="type-sub mb-3 px-1 text-duet-red" role="alert">
          {activity.error
            ? `Couldn't load what ${bot.name} did. Reload the page.`
            : problem.message}
        </p>
      ) : null}
      {activity.isPending ? null : working.length +
          handled.length +
          upcoming.length ===
        0 ? (
        <DuetCard className="px-4 py-4">
          <p className="type-row font-semibold">Nothing yet.</p>
          <p className="type-sub mt-0.5 text-duet-ink-2">
            What {bot.name} does for you shows up here: routines it runs,
            follow-ups it keeps, and the actions you allowed.
          </p>
        </DuetCard>
      ) : (
        <div className="flex flex-col gap-5">
          {working.length ? (
            <ActivityCard rows={working} title="Working on" />
          ) : null}
          {handled.length ? (
            <ActivityCard rows={handled} title="Handled for you" />
          ) : null}
          {upcoming.length ? (
            <ActivityCard rows={upcoming} showTime={false} title="Coming up" />
          ) : null}
        </div>
      )}
    </ScreenScroll>
  );
}

/**
 * The film's "Handled for you" card: a heading, then one row per thing, hairlines between. Each row
 * carries its own time, since the things in one card did not all happen at once.
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
  const line = (
    <CardRow
      detail={row.detail}
      icon={row.icon}
      title={row.title}
      tone={row.tone}
      trailing={
        row.control ??
        (when ? (
          <span className="type-label shrink-0 self-start pt-0.5 font-medium text-duet-ink-3">
            {when}
          </span>
        ) : undefined)
      }
    />
  );
  // A row with a control stays unlinked, so the button is not nested inside a link.
  if (row.control || !row.channelId) return line;
  return (
    <Link
      className="block rounded-[14px] outline-none hover:bg-duet-tile/60 focus-visible:ring-3 focus-visible:ring-duet-violet/25"
      params={{ channelId: row.channelId }}
      to="/channel/$channelId"
    >
      {line}
    </Link>
  );
}

function RowButton({
  children,
  label,
  busy,
  onClick,
}: {
  children: ReactNode;
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="type-label h-8 shrink-0 rounded-full px-3 font-semibold text-duet-ink shadow-[inset_0_0_0_1px_var(--duet-hair)] hover:bg-duet-tile disabled:opacity-50"
      disabled={busy}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
