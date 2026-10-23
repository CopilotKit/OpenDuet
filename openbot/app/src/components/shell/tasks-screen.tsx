import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode, useRef, useState } from "react";
import { ApprovalCard, PillButton } from "@/components/approvals/approval-card";
import { DuetIcon } from "@/components/duet/icons";
import { DuetCard, Rule, SectionLabel, Tile } from "@/components/duet/kit";
import { TaskRow, TryTaskAgain } from "@/components/duet/task-card";
import { primaryBot } from "@/lib/agents/primary-bot";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { clockTime } from "@/lib/approval-view";
import {
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
  decideApprovalMutationOptions,
  type PersonQuestion,
  waitingOnYou,
} from "@/lib/approvals";
import {
  cancelFollowUpMutationOptions,
  stopHandoffMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import { botActivityQueryOptions } from "@/lib/bot-lifecycle/queries";
import { createChannelMutationOptions } from "@/lib/channels/mutations";
import { ONGOING_SEARCH_LIMIT, ongoingChannel } from "@/lib/channels/ongoing";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  type ProactiveSetting,
  type ProactiveSuggestion,
  proactiveSettingsQueryOptions,
  proactiveSuggestionsQueryOptions,
  resolveSuggestionMutationOptions,
  turnOnResearchMutationOptions,
} from "@/lib/proactive";
import {
  liveStatus,
  type TaskRecord,
  taskListQueryOptions,
} from "@/lib/tasks/queries";
import { useConversationBusy } from "@/lib/tasks/use-task";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import {
  ActivityCard,
  type ActivityRow,
  handledRows,
  RowButton,
  upcomingRow,
  workingRow,
} from "./activity-screen";
import { ScreenScroll, ScreenTitle } from "./screen";

/**
 * What the product's own Bot looks for when the person turns research on from Tasks. OpenDuet works
 * in mail and calendar, so this names the things there that end up as tasks. The Bot reads it as
 * the person's own request, so it is written in their voice.
 */
const RESEARCH_FOCUS =
  "Replies I owe, decisions waiting on me, payments due and deadlines coming up, in my mail and calendar.";

/** How far right a finger has to drag a suggestion before letting go starts it, in pixels. */
const SWIPE_TO_START = 96;

/**
 * The Tasks tab: the person's to-do list, grouped by what each thing needs. Top to bottom, what
 * waits on the person, their tasks, what their Bots suggest, what the product's own Bot is working
 * on, what it has lined up, and what it has done. A section with nothing in it is left out, except
 * Suggested, which is also where background research is turned on.
 */
export function TasksScreen() {
  const agents = useQuery(agentListQueryOptions());
  const bot = primaryBot(agents.data);
  // Nothing while the Bots load: every section names one, and a placeholder here is a flicker.
  if (agents.isPending) return null;
  return (
    <ScreenScroll>
      <ScreenTitle title="Tasks">
        {bot
          ? `What needs you, what ${bot.name} suggests, and what it's working on.`
          : "What needs you, and what your Bots suggest."}
      </ScreenTitle>
      {agents.data ? null : (
        <p className="type-sub mb-3 px-1 text-duet-red" role="alert">
          Couldn't load your Bots. Reload the page.
        </p>
      )}
      <div className="flex flex-col gap-5">
        <NeedsYou agents={agents.data} />
        <YourTasks />
        <Suggested agents={agents.data} bot={bot} />
        {bot ? <BotWork bot={bot} /> : null}
        {bot ? <Done bot={bot} /> : null}
      </div>
    </ScreenScroll>
  );
}

/**
 * What is waiting on the person: the actions a Bot paused for an answer and the questions it asked,
 * newest first, each answered right here. The same requests the conversation draws inline, so a
 * decision made in either place is the one decision. The tab's badge counts the same list.
 */
function NeedsYou({ agents }: { agents: AgentProfile[] | undefined }) {
  const inbox = useQuery(approvalInboxOptions());
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const botName = (id: string) =>
    agents?.find((agent) => agent.id === id)?.name ?? id;
  const { requests, questions, count } = waitingOnYou(inbox.data);
  if (inbox.isPending) return null;
  if (!inbox.data)
    return (
      <p className="type-sub px-1 text-duet-red" role="alert">
        Couldn't load what is waiting on you. Reload the page.
      </p>
    );
  if (count === 0) return null;
  const items = [
    ...requests.map((request) => ({
      at: request.createdAt,
      key: `request:${request.id}`,
      node: (
        <ApprovalCard
          botName={botName(request.action.botId)}
          busy={decision.isPending && decision.variables?.id === request.id}
          error={
            decision.variables?.id === request.id
              ? (decision.error?.message ?? null)
              : null
          }
          onDecide={(choice) => decision.mutate({ id: request.id, choice })}
          request={request}
        />
      ),
    })),
    ...questions.map((question) => ({
      at: question.createdAt,
      key: `question:${question.id}`,
      node: (
        <QuestionCard
          botName={botName(question.botId)}
          busy={answer.isPending && answer.variables?.id === question.id}
          error={
            answer.variables?.id === question.id
              ? (answer.error?.message ?? null)
              : null
          }
          onAnswer={(response) => answer.mutate({ id: question.id, response })}
          question={question}
        />
      ),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <section aria-label="Needs you" className="flex flex-col gap-2">
      <SectionLabel tone="accent">Needs you</SectionLabel>
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.key}>{item.node}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The person's tasks that are not done yet, newest first: work started from Chat or from a
 * suggestion, each running in a conversation of its own. A row says where the task stands and opens
 * it. Marked done, a task moves to Done at the foot.
 *
 * Kept to a list for now. A later pass groups the whole tab by where things stand.
 */
function YourTasks() {
  const tasks = useQuery(taskListQueryOptions());
  if (tasks.isPending) return null;
  if (tasks.error)
    return (
      <p className="type-sub px-1 text-duet-red" role="alert">
        Couldn't load your tasks. Reload the page.
      </p>
    );
  const open = tasks.data.filter((task) => task.resolvedAt === null);
  if (open.length === 0) return null;
  return (
    <section aria-label="Your tasks">
      <DuetCard>
        <div className="flex h-[54px] items-center gap-2 px-4">
          <h2 className="type-row font-semibold">Your tasks</h2>
        </div>
        <ul>
          {open.map((task, index) => (
            <Fragment key={task.id}>
              {index > 0 ? <Rule inset /> : null}
              <li>
                <TaskLine task={task} />
              </li>
            </Fragment>
          ))}
        </ul>
      </DuetCard>
    </section>
  );
}

/**
 * One task: a row that opens it, its pill kept live with its conversation's working dot. One that
 * couldn't finish says why, with Try again under it.
 */
function TaskLine({ task }: { task: TaskRecord }) {
  const busy = useConversationBusy(task.channelId);
  const status = liveStatus(task.status, busy);
  return (
    <>
      <Link
        className="block rounded-[14px] outline-none hover:bg-duet-tile/60 focus-visible:ring-3 focus-visible:ring-duet-violet/25"
        params={{ taskId: task.id }}
        to="/tasks/$taskId"
      >
        <TaskRow failure={task.failure} status={status} title={task.title} />
      </Link>
      {status === "failed" ? <TryTaskAgain taskId={task.id} /> : null}
    </>
  );
}

/** A task the person marked done, as a row of Done. */
function resolvedTaskRow(task: TaskRecord): ActivityRow {
  return {
    id: `task:${task.id}`,
    icon: "check",
    tone: "green",
    title: task.title,
    detail: "Task · Done",
    at: task.resolvedAt ?? task.updatedAt,
    channelId: null,
    taskId: task.id,
  };
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

/**
 * What the person's Bots suggest doing next, from the background research each runs on the apps it
 * can read (`lib/proactive.ts`), newest first. Start hands one to its Bot as a message in that Bot's
 * conversation, as if the person had typed it, and Hide dismisses it.
 *
 * When research is off for the product's own Bot, the card offers to turn it on. Without that, an
 * empty list would read as nothing to do, when nothing is looking.
 */
function Suggested({
  agents,
  bot,
}: {
  agents: AgentProfile[] | undefined;
  bot: AgentProfile | undefined;
}) {
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const settings = useQuery(proactiveSettingsQueryOptions());
  const act = useMutation(resolveSuggestionMutationOptions(queryClient));
  const setting = bot
    ? settings.data?.find((row) => row.agentId === bot.id)
    : undefined;
  const researchOff = Boolean(bot && settings.data && !setting?.enabled);
  const shown = [...(suggestions.data ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const botName = (id: string) =>
    agents?.find((agent) => agent.id === id)?.name ?? "Your Bot";
  // Who took the last started suggestion, said once it has gone from the list.
  const [started, setStarted] = useState<string | null>(null);
  const resolve = (
    suggestion: ProactiveSuggestion,
    action: "start" | "dismiss",
  ) => {
    setStarted(null);
    act.mutate(
      { id: suggestion.id, action },
      {
        onSuccess: () => {
          if (action === "start") setStarted(botName(suggestion.agentId));
        },
      },
    );
  };
  return (
    <section aria-label="Suggested">
      <DuetCard>
        <div className="flex h-[54px] items-center gap-2 px-4">
          <h2 className="type-row font-semibold">Suggested</h2>
        </div>
        {suggestions.error ? (
          <p className="type-sub px-4 pb-4 text-duet-red" role="alert">
            Couldn't load suggestions. Reload the page.
          </p>
        ) : null}
        {shown.length ? (
          <ul>
            {shown.map((suggestion, index) => (
              <Fragment key={suggestion.id}>
                {index > 0 ? <Rule inset /> : null}
                <li>
                  <SuggestionRow
                    busy={act.isPending && act.variables?.id === suggestion.id}
                    from={
                      suggestion.agentId === bot?.id
                        ? null
                        : botName(suggestion.agentId)
                    }
                    onHide={() => resolve(suggestion, "dismiss")}
                    onStart={() => resolve(suggestion, "start")}
                    suggestion={suggestion}
                  />
                </li>
              </Fragment>
            ))}
          </ul>
        ) : null}
        {researchOff && bot ? (
          <>
            {shown.length ? <Rule /> : null}
            <ResearchOptIn bot={bot} setting={setting} />
          </>
        ) : !shown.length &&
          !suggestions.isPending &&
          !suggestions.error &&
          !settings.isPending ? (
          <div className="px-4 pb-4">
            <p className="type-row font-semibold">
              Nothing to suggest right now.
            </p>
            <p className="type-sub mt-0.5 text-duet-ink-2">
              When {bot ? bot.name : "a Bot"} finds something in your apps, it
              shows up here.
            </p>
          </div>
        ) : null}
        {act.error ? (
          <p className="type-sub px-4 pb-4 text-duet-red" role="alert">
            {act.error.message}
          </p>
        ) : started ? (
          <p className="type-sub px-4 pb-4 text-duet-ink-2" role="status">
            Started. {started} is on it.
          </p>
        ) : null}
      </DuetCard>
    </section>
  );
}

/**
 * One suggestion: what to do, a line or two of why, where it was read, and the two answers. On a
 * touch screen a swipe to the right starts it, handing the task to the Bot in one gesture. The
 * buttons do the same for everyone else.
 */
function SuggestionRow({
  suggestion,
  from,
  busy,
  onStart,
  onHide,
}: {
  suggestion: ProactiveSuggestion;
  /** The Bot's name, said only when it is not the product's own. */
  from: string | null;
  busy: boolean;
  onStart: () => void;
  onHide: () => void;
}) {
  const app =
    suggestion.sourceApp || suggestion.sourceLink
      ? `From ${suggestion.sourceApp ?? "a connected app"}`
      : null;
  const source = suggestion.sourceLink ? (
    <a
      className="underline decoration-duet-hair underline-offset-2 hover:text-duet-ink"
      href={suggestion.sourceLink}
      rel="noreferrer"
      target="_blank"
    >
      {app}
    </a>
  ) : (
    app
  );
  return (
    <SwipeToStart disabled={busy} onStart={onStart}>
      <div className="flex gap-[13px] px-4 py-3">
        <Tile icon="bulb" />
        <div className="min-w-0 flex-1">
          <p className="type-row font-semibold text-duet-ink [overflow-wrap:anywhere]">
            {suggestion.title}
          </p>
          <p className="type-sub line-clamp-2 text-duet-ink-2 [overflow-wrap:anywhere]">
            {suggestion.detail}
          </p>
          {from || source ? (
            <p className="type-label mt-0.5 text-duet-ink-3">
              {from}
              {from && source ? " · " : null}
              {source}
            </p>
          ) : null}
          <div className="mt-2.5 flex gap-2">
            <RowButton
              busy={busy}
              label={`Start ${suggestion.title}`}
              onClick={onStart}
              primary
            >
              Start
            </RowButton>
            <RowButton
              busy={busy}
              label={`Hide ${suggestion.title}`}
              onClick={onHide}
            >
              Hide
            </RowButton>
          </div>
        </div>
      </div>
    </SwipeToStart>
  );
}

/**
 * A row a finger can drag to the right, uncovering "Start"; let go far enough along and it starts.
 *
 * Only touch drags it: a mouse has the buttons, and a mouse drag is how text gets selected. The row
 * lets the browser keep vertical panning (`touch-pan-y`), so scrolling the list never moves a row,
 * and a drag that begins on a button or a link is left to that control.
 */
function SwipeToStart({
  children,
  disabled,
  onStart,
}: {
  children: ReactNode;
  disabled: boolean;
  onStart: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const drag = useRef<{ pointerId: number; x: number } | null>(null);
  const settle = () => {
    drag.current = null;
    setOffset(0);
  };
  return (
    <div className="relative overflow-hidden">
      <div
        aria-hidden
        className={cn(
          "type-row absolute inset-0 flex items-center gap-2 bg-duet-violet px-5 font-semibold text-white",
          offset > 0 ? "opacity-100" : "opacity-0",
        )}
      >
        <DuetIcon name="arrowRight" size={18} stroke={2.4} />
        Start
      </div>
      <div
        className={cn(
          "relative touch-pan-y bg-duet-card",
          offset === 0 &&
            "transition-transform duration-200 motion-reduce:transition-none",
        )}
        onPointerCancel={settle}
        onPointerDown={(event) => {
          if (
            disabled ||
            event.pointerType !== "touch" ||
            (event.target as Element).closest("a, button")
          )
            return;
          drag.current = { pointerId: event.pointerId, x: event.clientX };
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          setOffset(Math.max(0, event.clientX - drag.current.x));
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          const far = event.clientX - drag.current.x >= SWIPE_TO_START;
          settle();
          if (far) onStart();
        }}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The one offer shown when research is off for the product's own Bot: turn it on with a button.
 *
 * A setting the person turned off comes back on as they left it. Otherwise it is made in Chat's
 * conversation with the Bot, found the way Chat finds it, so suggestions land where the person
 * already talks to it and a started one carries on there. With no conversation yet, one is started,
 * as Chat's first message would.
 */
function ResearchOptIn({
  bot,
  setting,
}: {
  bot: AgentProfile;
  setting: ProactiveSetting | undefined;
}) {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const createChannel = useMutation(createChannelMutationOptions(queryClient));
  const turnOn = useMutation(turnOnResearchMutationOptions(queryClient));
  const chatChannel = async () => {
    let roster = channels;
    let found = ongoingChannel(roster.data, bot.id);
    // The roster is paged; the conversation may be further back than the first page.
    while (
      !found &&
      roster.hasNextPage &&
      !roster.isFetchNextPageError &&
      (roster.data?.length ?? 0) < ONGOING_SEARCH_LIMIT
    ) {
      roster = await roster.fetchNextPage();
      found = ongoingChannel(roster.data, bot.id);
    }
    if (found) return found.id;
    // Starting a second conversation would take Chat's place, so only start one knowing there is none.
    if (!roster.data || roster.isFetchNextPageError)
      throw new Error("Couldn't load your conversations. Reload the page.");
    return (await createChannel.mutateAsync([bot.id])).id;
  };
  return (
    <div className="flex gap-[13px] px-4 py-3">
      <Tile icon="bulb" tone="violet" />
      <div className="min-w-0 flex-1">
        <p className="type-row font-semibold text-duet-ink">
          Let {bot.name} suggest tasks
        </p>
        <p className="type-sub text-duet-ink-2">
          It checks your connected apps every hour and writes to you when
          something needs you. It can only read.
        </p>
        {turnOn.error ? (
          <p className="type-label mt-1 text-duet-red" role="alert">
            {turnOn.error.message}
          </p>
        ) : null}
        <div className="mt-2.5 flex">
          <RowButton
            busy={turnOn.isPending || channels.isPending}
            label="Turn on"
            onClick={() =>
              turnOn.mutate({
                setting,
                agentId: bot.id,
                focus: RESEARCH_FOCUS,
                channelId: chatChannel,
              })
            }
            primary
          >
            Turn on
          </RowButton>
        </div>
      </div>
    </div>
  );
}

/**
 * What the product's own Bot is doing and has lined up, from the ledgers Activity reads, with the
 * same rows and controls Activity had. The approvals and questions among its open work are left out
 * of Working on: Needs you lists every one of them, and answers them in place.
 */
function BotWork({ bot }: { bot: AgentProfile }) {
  const activity = useQuery(botActivityQueryOptions(bot.id));
  const stop = useMutation(stopHandoffMutationOptions(queryClient));
  const cancel = useMutation(cancelFollowUpMutationOptions(queryClient));
  const working: ActivityRow[] = (activity.data?.inProgress ?? [])
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
    }));
  const upcoming: ActivityRow[] = (activity.data?.scheduled ?? []).map(
    (item) => ({
      ...upcomingRow(item),
      control: item.cancellable ? (
        <RowButton
          busy={cancel.isPending && cancel.variables?.id === item.id}
          label={`Cancel ${item.title}`}
          onClick={() => cancel.mutate({ agentId: bot.id, id: item.id })}
        >
          Cancel
        </RowButton>
      ) : undefined,
    }),
  );
  const problem = activity.error ?? stop.error ?? cancel.error;
  return (
    <>
      {problem ? (
        <p className="type-sub px-1 text-duet-red" role="alert">
          {activity.error
            ? `Couldn't load what ${bot.name} is working on. Reload the page.`
            : problem.message}
        </p>
      ) : null}
      {working.length ? (
        <ActivityCard rows={working} title="Working on" />
      ) : null}
      {upcoming.length ? (
        <ActivityCard rows={upcoming} showTime={false} title="Coming up" />
      ) : null}
    </>
  );
}

/** How many finished things Done shows, as Activity's "Handled for you" did. */
const DONE_LIMIT = 25;

/**
 * What the product's own Bot finished, at the foot of the list: its routines, follow-ups and
 * delegated work, the actions the person allowed or refused, and the tasks they marked done, newest
 * first. The rows Activity's "Handled for you" had, read-only, and a done task's row opens it. Left
 * out until there is something in it; a failure to load is said once, by Working on.
 */
function Done({ bot }: { bot: AgentProfile }) {
  const activity = useQuery(botActivityQueryOptions(bot.id));
  const tasks = useQuery(taskListQueryOptions());
  if (activity.isPending || !activity.data) return null;
  const rows = [
    ...handledRows(activity.data.completed),
    ...(tasks.data ?? [])
      .filter((task) => task.resolvedAt !== null)
      .map(resolvedTaskRow),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, DONE_LIMIT);
  return rows.length ? <ActivityCard rows={rows} title="Done" /> : null;
}
