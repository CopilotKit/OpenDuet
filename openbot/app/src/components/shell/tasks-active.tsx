import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { ChannelTagOf } from "@/components/duet/channel-tag";
import { DuetIcon } from "@/components/duet/icons";
import type { TileTone } from "@/components/duet/kit";
import { SafeSvg } from "@/components/duet/page-rich-block";
import { TryTaskAgain } from "@/components/duet/task-card";
import type { AgentProfile } from "@/lib/agents/queries";
import { clockTime } from "@/lib/approval-view";
import {
  approvalInboxOptions,
  decideApprovalMutationOptions,
  type PersonQuestion,
  waitingOnYou,
} from "@/lib/approvals";
import { stopHandoffMutationOptions } from "@/lib/bot-lifecycle/mutations";
import { botActivityQueryOptions } from "@/lib/bot-lifecycle/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { agoShort } from "@/lib/relative-time";
import {
  type ActiveGroup,
  type ActiveItem,
  activeGroups,
  type ConversationFacts,
  type SortOrder,
} from "@/lib/tasks/groups";
import { resolveTaskMutationOptions } from "@/lib/tasks/mutations";
import {
  TASK_STATUS_LABEL,
  type TaskStatus,
  taskListQueryOptions,
} from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import {
  type ActivityRow,
  handledRows,
  RowButton,
  workingRow,
} from "./activity-screen";
import { useReportFinish } from "./chat-presence";

/** How long a checked task stays where it is before it moves to Resolved, so its check is seen. */
export const CHECK_HOLD_MS = 450;
/** How often "Updated 1 min ago" is worked out again with nothing else changing. */
const CLOCK_MS = 30_000;

/** The colour of each status's word on a row. */
const STATE_TONE: Record<TaskStatus, string> = {
  ready_for_review: "text-duet-green",
  needs_input: "text-duet-amber",
  working: "text-duet-blue",
  resolved: "text-duet-ink-3",
  failed: "text-duet-red",
};

const ICON_TONE: Record<TileTone, string> = {
  neutral: "text-duet-ink-3",
  green: "text-duet-green",
  violet: "text-duet-violet",
  red: "text-duet-red",
  blue: "text-duet-blue",
  amber: "text-duet-amber",
};

/** The time now, read again every `CLOCK_MS`, for the "Updated" words. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Tasks' Active list: what is under way and what needs the person, grouped by what each thing needs
 * (`activeGroups`). Ready for review, then Needs input, Working and Resolved, each headed with its
 * count in grey. A group with nothing in it is left out, and Resolved starts folded.
 *
 * Every task is a flat row on the page (parity-spec S3b): its check, its title, and where it stands
 * with the run's own next step. The row opens its page, and the check marks it done. A question not
 * in any task is a row too, which opens a page to answer it; an approval not in any task keeps its
 * card, with Allow once and Refuse on it. Other work under way keeps its Stop, and finished work is
 * read-only.
 */
export function ActiveView({
  agents,
  bot,
  order,
  query,
}: {
  agents: AgentProfile[] | undefined;
  bot: AgentProfile | undefined;
  order: SortOrder;
  query: string;
}) {
  const tasks = useQuery(taskListQueryOptions());
  const inbox = useQuery(approvalInboxOptions());
  const roster = useInfiniteQuery(channelListQueryOptions());
  const activity = useQuery({
    ...botActivityQueryOptions(bot?.id ?? ""),
    enabled: Boolean(bot),
  });
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const stop = useMutation(stopHandoffMutationOptions(queryClient));
  const resolve = useMutation(
    resolveTaskMutationOptions(queryClient, { holdMs: CHECK_HOLD_MS }),
  );
  const now = useNow();
  const [resolvedOpen, setResolvedOpen] = useState(false);

  // Nothing until both lists are read: every group draws from them, and a half list is a flicker.
  if (tasks.isPending || inbox.isPending) return null;

  const botName = (id: string) =>
    agents?.find((agent) => agent.id === id)?.name ?? id;
  const facts = new Map<string, ConversationFacts>(
    (roster.data ?? []).map((channel) => [
      channel.id,
      { busy: channel.busy ?? false, lastMessageAt: channel.lastMessageAt },
    ]),
  );
  const { requests, questions } = waitingOnYou(inbox.data);
  const working: ActivityRow[] = bot
    ? (activity.data?.inProgress ?? [])
        // Approvals and questions are listed from the inbox, under Needs input.
        .filter((item) => item.kind !== "approval" && item.kind !== "question")
        .map((item) => ({
          ...workingRow(item),
          control: item.stoppable ? (
            <RowButton
              busy={stop.isPending && stop.variables?.id === item.id}
              label={`Stop ${item.title}`}
              onClick={() => stop.mutate({ agentId: bot.id, id: item.id })}
            >
              Stop
            </RowButton>
          ) : undefined,
        }))
    : [];
  const handled =
    bot && activity.data ? handledRows(activity.data.completed) : [];
  const groups = activeGroups({
    tasks: tasks.data ?? [],
    conversation: (channelId) => facts.get(channelId),
    requests,
    questions,
    working,
    handled,
    now,
    order,
    query,
  });

  const problems = [
    tasks.error ? "Couldn't load your tasks. Reload the page." : null,
    inbox.error
      ? "Couldn't load what is waiting on you. Reload the page."
      : null,
    activity.error && bot
      ? `Couldn't load what ${bot.name} is working on. Reload the page.`
      : null,
    stop.error?.message ?? null,
    resolve.error?.message ?? null,
  ].filter((problem): problem is string => Boolean(problem));

  const drawItem = (item: ActiveItem<ActivityRow>): ReactNode => {
    switch (item.kind) {
      case "task":
        return (
          <TaskLine
            busy={resolve.isPending && resolve.variables?.id === item.task.id}
            item={item}
            onCheck={(done, failed) =>
              resolve.mutate(
                { id: item.task.id, done },
                { onError: () => failed() },
              )
            }
          />
        );
      case "request":
        return (
          <ApprovalCard
            botName={botName(item.request.action.botId)}
            busy={
              decision.isPending && decision.variables?.id === item.request.id
            }
            error={
              decision.variables?.id === item.request.id
                ? (decision.error?.message ?? null)
                : null
            }
            onDecide={(choice) =>
              decision.mutate({ id: item.request.id, choice })
            }
            request={item.request}
          />
        );
      case "question":
        return (
          <QuestionLine
            botName={botName(item.question.botId)}
            question={item.question}
          />
        );
      case "row":
        return <OtherLine row={item.row} />;
    }
  };

  return (
    <div className="flex flex-col gap-9">
      {problems.map((problem) => (
        <p className="type-sub px-1 text-duet-red" key={problem} role="alert">
          {problem}
        </p>
      ))}
      {groups.length === 0 ? (
        <EmptyActive query={query} />
      ) : (
        groups.map((group, index) => (
          <Group
            drawItem={drawItem}
            group={group}
            key={group.id}
            now={now}
            onToggle={() => setResolvedOpen((open) => !open)}
            open={group.id !== "resolved" || resolvedOpen}
            updated={index === 0}
          />
        ))
      )}
    </div>
  );
}

/** Nothing under way: say so, and where things come from. With a search, say nothing matched. */
function EmptyActive({ query }: { query: string }) {
  if (query.trim())
    return (
      <p className="type-sub px-1 text-duet-ink-2" role="status">
        Nothing matches “{query.trim()}”.
      </p>
    );
  return (
    <div className="px-1">
      <p className="type-row font-semibold">Nothing active right now.</p>
      <p className="type-sub mt-0.5 text-duet-ink-2">
        Add a task with +, or start one from Up next.
      </p>
    </div>
  );
}

/**
 * One group (parity-spec S3a): its name and how many, in regular grey so the rows lead, then its
 * rows straight on the page, with no card behind them. The first group also says, on the right,
 * when the list last changed. Resolved is folded: its heading alone, with no count and a chevron,
 * and pressing it shows its rows.
 */
function Group({
  group,
  now,
  open,
  updated,
  onToggle,
  drawItem,
}: {
  group: ActiveGroup<ActivityRow>;
  now: number;
  /** False for a folded Resolved. */
  open: boolean;
  /** Whether this heading carries the list's "Updated …". */
  updated: boolean;
  onToggle: () => void;
  drawItem: (item: ActiveItem<ActivityRow>) => ReactNode;
}) {
  const resolved = group.id === "resolved";
  const stamp = updated ? (
    <span className="type-sub ml-auto shrink-0 text-duet-ink-2">
      Updated {agoShort(group.updatedAt, now)}
    </span>
  ) : null;
  return (
    <section aria-label={group.label} className="flex flex-col gap-5">
      {/*
       * Wraps at large text: the heading keeps its words on one line, and "Updated …" drops under
       * it on the right, rather than squeezing "Needs input 1" into a column a word wide.
       */}
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="min-w-0 flex-[1_1_auto]">
          {resolved ? (
            <button
              aria-expanded={open}
              className="-my-2 flex min-h-11 w-full items-center justify-between gap-2 rounded-lg text-left text-duet-ink-2 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40"
              onClick={onToggle}
              type="button"
            >
              <span className="type-row font-normal">{group.label}</span>
              <DuetIcon
                className={cn(
                  "shrink-0 transition-transform motion-reduce:transition-none",
                  open ? "-rotate-90" : "rotate-90",
                )}
                name="chevronRight"
                size={18}
                stroke={2}
              />
            </button>
          ) : (
            <span className="type-row font-normal text-duet-ink-2">
              {group.label}{" "}
              <span className="tabular-nums">{group.items.length}</span>
            </span>
          )}
        </h2>
        {stamp}
      </div>
      {open ? (
        <ul className="flex flex-col gap-6">
          {group.items.map((item) => (
            <li key={item.key}>{drawItem(item)}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const ROW_LINK =
  "-my-1 block min-w-0 flex-1 rounded-[12px] py-1 outline-none transition-opacity focus-visible:ring-3 focus-visible:ring-duet-violet/25";

/** The title of a row: bold, at most two lines. */
function RowTitle({ children }: { children: ReactNode }) {
  return (
    <p className="type-row line-clamp-2 font-semibold text-duet-ink [overflow-wrap:anywhere]">
      {children}
    </p>
  );
}

/**
 * The one line under a row's title: the status word in its colour, then the next step in grey, cut
 * with an ellipsis rather than wrapped (parity-spec S3b).
 */
function StatusLine({
  status,
  children,
}: {
  status: TaskStatus;
  children: ReactNode;
}) {
  return (
    <p
      className="type-sub mt-1.5 truncate text-duet-ink-2"
      data-status={status}
    >
      <span
        className={cn(
          STATE_TONE[status],
          status === "working" && "tool-line-running",
        )}
      >
        {TASK_STATUS_LABEL[status]}
      </span>
      {" · "}
      {children}
    </p>
  );
}

/**
 * A task as a flat row (parity-spec S3b): the check, the title, and where it stands with the run's
 * own next step. The row opens the task; the check marks it done, or, on a done one, reopens it.
 */
function TaskLine({
  item,
  busy,
  onCheck,
}: {
  item: Extract<ActiveItem<ActivityRow>, { kind: "task" }>;
  busy: boolean;
  /** `failed` empties the check if marking it done did not work. */
  onCheck: (done: boolean, failed: () => void) => void;
}) {
  const { task, status } = item;
  return (
    <>
      <div className="flex items-start gap-3">
        <CheckBox
          busy={busy}
          done={status === "resolved"}
          onCheck={onCheck}
          title={task.title}
        />
        <Link
          className={cn(ROW_LINK, "hover:opacity-80")}
          params={{ taskId: task.id }}
          to="/tasks/$taskId"
        >
          <div className="flex items-center gap-2">
            <SafeSvg
              className="h-10 w-16 shrink-0 overflow-hidden rounded-lg"
              svg={task.thumbnail}
            />
            <RowTitle>{task.title}</RowTitle>
          </div>
          <StatusLine status={status}>{item.need}</StatusLine>
          <ChannelTagOf channelId={task.fromChannelId} className="mt-2" />
        </Link>
      </div>
      {/* Outside the link, so pressing it never opens the task. */}
      {status === "failed" ? (
        <TryTaskAgain className="pt-3 pl-[34px]" taskId={task.id} />
      ) : null}
    </>
  );
}

/**
 * The check on a task's row: a 22px rounded square on a hairline, in a 44px target. Pressed, a check
 * fills it, the header's orb plays its finish, and the task is marked done; the list holds it in
 * place for `CHECK_HOLD_MS` first, so the check is seen before the row moves to Resolved. On a done
 * task it is filled, and pressing it reopens the task.
 */
function CheckBox({
  title,
  done,
  busy,
  onCheck,
}: {
  title: string;
  done: boolean;
  busy: boolean;
  onCheck: (done: boolean, failed: () => void) => void;
}) {
  const [landing, setLanding] = useState(false);
  const reportFinish = useReportFinish();
  const filled = done || landing;
  return (
    <button
      aria-label={done ? `Reopen ${title}` : `Mark ${title} done`}
      aria-pressed={filled}
      className="-m-[11px] grid size-11 shrink-0 place-items-center rounded-[10px] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40"
      disabled={busy || landing}
      onClick={() => {
        if (done) {
          onCheck(false, () => {});
          return;
        }
        setLanding(true);
        reportFinish();
        onCheck(true, () => setLanding(false));
      }}
      type="button"
    >
      <span
        aria-hidden
        className={cn(
          "grid size-[22px] place-items-center rounded-[6px] transition-[background-color,box-shadow] duration-[var(--duet-dur-swap)] motion-reduce:transition-none",
          filled
            ? "bg-duet-ink text-duet-surface"
            : "bg-duet-card shadow-[inset_0_0_0_1.5px_var(--duet-hair)]",
        )}
        data-check
      >
        {filled ? (
          <span className={landing ? "duet-check-land" : undefined}>
            <DuetIcon name="check" size={14} stroke={3} />
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * A question a Bot asked outside any task, as a row: who asks, then "Needs input" and the question.
 * It opens a page of its own to answer (`/tasks/questions/<id>`).
 */
function QuestionLine({
  question,
  botName,
}: {
  question: PersonQuestion;
  botName: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden
        className="grid size-[22px] shrink-0 place-items-center text-duet-amber"
      >
        <DuetIcon name="question" size={20} stroke={2} />
      </span>
      <Link
        className={cn(ROW_LINK, "hover:opacity-80")}
        params={{ questionId: question.id }}
        to="/tasks/questions/$questionId"
      >
        <RowTitle>{botName} asks</RowTitle>
        <StatusLine status="needs_input">{question.question}</StatusLine>
      </Link>
    </div>
  );
}

/**
 * Work that is not a task: a delegated job, routine or follow-up under way, with its Stop, or
 * finished work, read-only. It opens its conversation, or the task it was.
 */
function OtherLine({ row }: { row: ActivityRow }) {
  const body = (
    <>
      <RowTitle>{row.title}</RowTitle>
      <p className="type-sub mt-1.5 truncate text-duet-ink-2">
        {row.detail} · {clockTime(row.at)}
      </p>
    </>
  );
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden
        className={cn(
          "grid size-[22px] shrink-0 place-items-center",
          ICON_TONE[row.tone],
        )}
      >
        <DuetIcon name={row.icon} size={19} stroke={2.2} />
      </span>
      {row.taskId ? (
        <Link
          className={ROW_LINK}
          params={{ taskId: row.taskId }}
          to="/tasks/$taskId"
        >
          {body}
        </Link>
      ) : row.channelId ? (
        <Link
          className={ROW_LINK}
          params={{ channelId: row.channelId }}
          to="/channel/$channelId"
        >
          {body}
        </Link>
      ) : (
        <div className="min-w-0 flex-1">{body}</div>
      )}
      {row.control ? <div className="shrink-0">{row.control}</div> : null}
    </div>
  );
}
