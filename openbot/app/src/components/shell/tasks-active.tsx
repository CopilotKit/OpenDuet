import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { ApprovalCard, PillButton } from "@/components/approvals/approval-card";
import { DuetIcon } from "@/components/duet/icons";
import { DuetCard, Rule, Tile, type TileTone } from "@/components/duet/kit";
import { TryTaskAgain } from "@/components/duet/task-card";
import type { AgentProfile } from "@/lib/agents/queries";
import { clockTime } from "@/lib/approval-view";
import {
  answerPersonQuestionMutationOptions,
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

/** How many things Resolved shows before "Show all". */
export const RESOLVED_SHOWN = 5;
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
 * count and when it last changed. A group with nothing in it is left out.
 *
 * A task's row opens its page, and its check circle marks it done. The approvals and questions that
 * are not in any task are answered right here. Other work under way keeps its Stop, and finished
 * work is read-only.
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
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const stop = useMutation(stopHandoffMutationOptions(queryClient));
  const resolve = useMutation(
    resolveTaskMutationOptions(queryClient, { holdMs: CHECK_HOLD_MS }),
  );
  const now = useNow();
  const [allResolved, setAllResolved] = useState(false);

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
          <QuestionCard
            botName={botName(item.question.botId)}
            busy={answer.isPending && answer.variables?.id === item.question.id}
            error={
              answer.variables?.id === item.question.id
                ? (answer.error?.message ?? null)
                : null
            }
            onAnswer={(response) =>
              answer.mutate({ id: item.question.id, response })
            }
            question={item.question}
          />
        );
      case "row":
        return <OtherLine row={item.row} />;
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {problems.map((problem) => (
        <p className="type-sub px-1 text-duet-red" key={problem} role="alert">
          {problem}
        </p>
      ))}
      {groups.length === 0 ? (
        <EmptyActive query={query} />
      ) : (
        groups.map((group) => (
          <Group
            collapsed={group.id === "resolved" && !allResolved}
            drawItem={drawItem}
            group={group}
            key={group.id}
            now={now}
            onToggle={() => setAllResolved((all) => !all)}
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
 * One group: its name, how many, and when it last changed, then its things. Rows share a card;
 * an approval or a question is a card of its own, as it carries its own answers. Resolved can fold
 * after its first few.
 */
function Group({
  group,
  now,
  collapsed,
  onToggle,
  drawItem,
}: {
  group: ActiveGroup<ActivityRow>;
  now: number;
  /** Fold after `RESOLVED_SHOWN`, with a Show all. */
  collapsed: boolean;
  onToggle: () => void;
  drawItem: (item: ActiveItem<ActivityRow>) => ReactNode;
}) {
  const foldable =
    group.id === "resolved" && group.items.length > RESOLVED_SHOWN;
  const shown =
    foldable && collapsed ? group.items.slice(0, RESOLVED_SHOWN) : group.items;
  return (
    <section aria-label={group.label} className="flex flex-col gap-2">
      <h2 className="px-1">
        <span className="type-row font-semibold text-duet-ink">
          {group.label}
        </span>{" "}
        <span className="type-row font-semibold text-duet-ink-3 tabular-nums">
          {group.items.length}
        </span>{" "}
        <span className="type-label font-medium text-duet-ink-3">
          · Updated {agoShort(group.updatedAt, now)}
        </span>
      </h2>
      {chunks(shown).map((chunk) =>
        chunk.kind === "rows" ? (
          <DuetCard key={chunk.items[0]?.key}>
            <ul>
              {chunk.items.map((item, index) => (
                <Fragment key={item.key}>
                  {index > 0 ? <Rule inset /> : null}
                  <li>{drawItem(item)}</li>
                </Fragment>
              ))}
            </ul>
          </DuetCard>
        ) : (
          <div key={chunk.item.key}>{drawItem(chunk.item)}</div>
        ),
      )}
      {foldable ? (
        <button
          className="type-label self-start rounded-full px-3 py-1.5 font-semibold text-duet-ink-2 hover:bg-duet-tile focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40"
          onClick={onToggle}
          type="button"
        >
          {collapsed ? `Show all ${group.items.length}` : "Show fewer"}
        </button>
      ) : null}
    </section>
  );
}

type Chunk =
  | { kind: "rows"; items: ActiveItem<ActivityRow>[] }
  | { kind: "card"; item: ActiveItem<ActivityRow> };

/** Runs of rows go on one card; an approval or a question stands alone. */
function chunks(items: readonly ActiveItem<ActivityRow>[]): Chunk[] {
  const out: Chunk[] = [];
  for (const item of items) {
    if (item.kind === "request" || item.kind === "question") {
      out.push({ kind: "card", item });
      continue;
    }
    const last = out.at(-1);
    if (last?.kind === "rows") last.items.push(item);
    else out.push({ kind: "rows", items: [item] });
  }
  return out;
}

const ROW_LINK =
  "-my-1 block min-w-0 flex-1 rounded-[12px] py-1 outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/25";

/**
 * A task: the check circle, the title, where it stands with the word in its colour and what it
 * needs next, and who asked for it. The row opens the task; the circle marks it done, or, on a done
 * one, reopens it.
 */
function TaskLine({
  item,
  busy,
  onCheck,
}: {
  item: Extract<ActiveItem<ActivityRow>, { kind: "task" }>;
  busy: boolean;
  /** `failed` puts the circle back if marking it done did not work. */
  onCheck: (done: boolean, failed: () => void) => void;
}) {
  const { task, status } = item;
  return (
    <>
      <div className="flex items-start gap-3 px-4 py-3">
        <CheckCircle
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
          <p className="type-row line-clamp-2 font-semibold text-duet-ink [overflow-wrap:anywhere]">
            {task.title}
          </p>
          <p className="type-sub mt-0.5 text-duet-ink-2" data-status={status}>
            <span className={cn("font-semibold", STATE_TONE[status])}>
              {TASK_STATUS_LABEL[status]}
            </span>{" "}
            · {item.need}
          </p>
          <p className="type-label mt-1 font-medium text-duet-ink-3">
            {item.tag}
          </p>
        </Link>
      </div>
      {/* Outside the link, so pressing it never opens the task. */}
      {status === "failed" ? <TryTaskAgain taskId={task.id} /> : null}
    </>
  );
}

/**
 * The round check on a task's row. Pressed, a check pops into it, the header's orb plays its
 * finish, and the task is marked done; the list holds it in place for `CHECK_HOLD_MS` first, so the
 * check is seen before the row moves to Resolved. On a done task it is filled, and pressing it
 * reopens the task.
 */
function CheckCircle({
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
      className={cn(
        "mt-0.5 grid size-[26px] shrink-0 place-items-center rounded-full transition-[background-color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 motion-reduce:transition-none",
        filled
          ? "bg-duet-green text-duet-card"
          : "shadow-[inset_0_0_0_2px_var(--duet-ink-3)] hover:shadow-[inset_0_0_0_2px_var(--duet-ink-2)]",
      )}
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
      {filled ? (
        <span className={landing ? "duet-check-land" : undefined}>
          <DuetIcon name="check" size={15} stroke={3.2} />
        </span>
      ) : null}
    </button>
  );
}

/**
 * Work that is not a task: a delegated job, routine or follow-up under way, with its Stop, or
 * finished work, read-only. It opens its conversation, or the task it was.
 */
function OtherLine({ row }: { row: ActivityRow }) {
  const body = (
    <>
      <p className="type-row line-clamp-2 font-semibold text-duet-ink [overflow-wrap:anywhere]">
        {row.title}
      </p>
      <p className="type-sub mt-0.5 text-duet-ink-2 [overflow-wrap:anywhere]">
        {row.detail}
      </p>
      <p className="type-label mt-1 font-medium text-duet-ink-3">
        {clockTime(row.at)}
      </p>
    </>
  );
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-[26px] shrink-0 place-items-center",
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

/** A question a Bot asked mid-run. The run resumes with the answer. */
function QuestionCard({
  question,
  botName,
  busy,
  error,
  onAnswer,
}: {
  question: PersonQuestion;
  botName: string;
  busy: boolean;
  error: string | null;
  onAnswer: (response: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <DuetCard raised>
      <div className="flex min-h-[54px] items-center gap-2.5 px-4 py-2.5">
        <Tile icon="question" size={32} />
        <p className="type-row min-w-0 flex-1 font-semibold">{botName} asks</p>
        <span className="type-label shrink-0 font-medium text-duet-ink-3">
          {clockTime(question.createdAt)}
        </span>
      </div>
      <Rule />
      <p className="type-row whitespace-pre-wrap px-4 pt-3 leading-6 [overflow-wrap:anywhere]">
        {question.question}
      </p>
      {question.why ? (
        <p className="type-label px-4 pt-1 text-duet-ink-2">{question.why}</p>
      ) : null}
      <form
        className="flex flex-col gap-2 px-4 pt-3 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) onAnswer(draft);
        }}
      >
        <textarea
          aria-label="Your answer"
          className="type-sub min-h-20 w-full resize-none rounded-2xl bg-duet-tile px-3 py-2.5 text-duet-ink outline-none placeholder:text-duet-ink-3 focus-visible:ring-3 focus-visible:ring-duet-violet/25"
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Your answer"
          value={draft}
        />
        {error ? (
          <p className="type-label text-duet-red" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex">
          <PillButton disabled={busy || !draft.trim()} primary type="submit">
            Send answer
          </PillButton>
        </div>
      </form>
    </DuetCard>
  );
}
