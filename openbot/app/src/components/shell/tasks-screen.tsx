import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { ApprovalCard, PillButton } from "@/components/approvals/approval-card";
import { DuetIcon } from "@/components/duet/icons";
import { DuetCard, Rule, Tile } from "@/components/duet/kit";
import { primaryBot } from "@/lib/agents/primary-bot";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { clockTime, describeApproval } from "@/lib/approval-view";
import {
  type ApprovalInboxData,
  type ApprovalRequest,
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
  RESOLVED_PAGE,
  resolveStartedMutationOptions,
  resolveSuggestionMutationOptions,
  retryStartedMutationOptions,
  type StartedState,
  type StartedSuggestion,
  startedSections,
  startedSuggestionsQueryOptions,
  turnOnResearchMutationOptions,
} from "@/lib/proactive";
import {
  focusMessageState,
  startedTaskMessageId,
} from "@/lib/tasks/focus-message";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import {
  ActivityCard,
  ActivityLine,
  type ActivityRow,
  handledRows,
  RowButton,
  SectionHeading,
  TaskSection,
  upcomingRow,
  workingRow,
} from "./activity-screen";
import { STARTED_MS, StartedLine } from "./chat-suggestion";
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

/** How long a checked box shows its check before the row moves to Resolved, in ms. */
const CHECK_SETTLE_MS = 400;

/** How long a just-started task's row stays highlighted once it is scrolled into view, in ms. */
const REVEAL_MS = 1_600;

/**
 * The Tasks tab: the person's to-do list, grouped by where each thing stands. Top to bottom: what
 * they started that is ready for review; what needs their input, answered right here; what is
 * working, with what the product's own Bot has lined up; what their Bots suggest; and, folded at
 * the foot, what is resolved. A section with nothing in it is left out, except Suggested, which is
 * also where background research is turned on.
 *
 * Starting a suggestion says so above the tab bar for a moment, where Chat says it above its
 * composer, and the new row under Working is scrolled into view and lit up.
 */
export function TasksScreen() {
  const agents = useQuery(agentListQueryOptions());
  const bot = primaryBot(agents.data);
  const [resolvedLimit, setResolvedLimit] = useState(RESOLVED_PAGE);
  const started = useQuery(startedSuggestionsQueryOptions(resolvedLimit));
  const inbox = useQuery(approvalInboxOptions());
  // Who took the last suggestion started here. A new object each time, so a second start restarts it.
  const [startedBy, setStartedBy] = useState<{ botName: string } | null>(null);
  useEffect(() => {
    if (!startedBy) return;
    const timer = setTimeout(() => setStartedBy(null), STARTED_MS);
    return () => clearTimeout(timer);
  }, [startedBy]);
  const sections = startedSections(started.data?.started ?? []);
  const revealed = useRevealStarted(sections.working);
  // A task can be waiting on a request before the inbox has read it: read the inbox again, so the
  // card is drawn under its row now rather than at the inbox's next poll.
  const missing = sections.needsInput
    .flatMap((item) => (item.waitingOn ? [item.waitingOn.id] : []))
    .filter(
      (id) =>
        inbox.data &&
        !inbox.data.requests.some((request) => request.id === id) &&
        !inbox.data.questions.some((question) => question.id === id),
    )
    .join(" ");
  useEffect(() => {
    if (missing)
      void queryClient.invalidateQueries({
        queryKey: approvalInboxOptions().queryKey,
      });
  }, [missing]);
  // Nothing while the Bots load: every section names one, and a placeholder here is a flicker.
  if (agents.isPending) return null;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
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
        {started.error || inbox.error ? (
          <p className="type-sub mb-3 px-1 text-duet-red" role="alert">
            Couldn't load your tasks.{" "}
            <button
              className="underline underline-offset-2"
              onClick={() => {
                void started.refetch();
                void inbox.refetch();
              }}
              type="button"
            >
              Try again
            </button>
          </p>
        ) : null}
        <div className="relative flex flex-col gap-6">
          {started.dataUpdatedAt ? (
            // Once, on the first heading's line: how fresh the whole list is.
            <span className="pointer-events-none absolute top-0 right-1 flex min-h-6 items-center text-[15px] text-duet-ink-2 leading-5">
              {updatedAgo(started.dataUpdatedAt)}
            </span>
          ) : null}
          {sections.ready.length ? (
            <TaskSection
              items={sections.ready.map((item) => ({
                key: item.id,
                node: <StartedRow item={item} />,
              }))}
              title="Ready for review"
            />
          ) : null}
          {/* Waits for both reads, so a request a task is waiting on is never drawn twice. */}
          {started.isPending || !inbox.data ? null : (
            <NeedsInput
              agents={agents.data}
              inbox={inbox.data}
              items={sections.needsInput}
            />
          )}
          {bot ? (
            <BotWork bot={bot} revealed={revealed} started={sections.working} />
          ) : null}
          <Suggested
            agents={agents.data}
            bot={bot}
            onStarted={(botName) => setStartedBy({ botName })}
          />
          {bot && !started.isPending ? (
            <Resolved
              bot={bot}
              items={sections.resolved}
              olderResolved={started.data?.olderResolved ?? 0}
              onMore={() => setResolvedLimit((limit) => limit + RESOLVED_PAGE)}
            />
          ) : null}
        </div>
      </ScreenScroll>
      {startedBy ? (
        // Docked over the list, just above the frosted tab bar, as Chat docks it above the composer.
        <div
          className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--duet-tab-space,0px)+10px)] px-4"
          data-dock
        >
          <StartedLine botName={startedBy.botName} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Bring a just-started task into view: one started moments ago, whether here or in Chat before
 * Tasks opened. Its row under Working is scrolled to the middle of the screen and lit up briefly,
 * so the person sees where the work went. Returns the id lit up, or null.
 */
function useRevealStarted(working: readonly StartedSuggestion[]) {
  const seen = useRef(new Set<string>());
  const openedAt = useRef(Date.now());
  const latest = useRef(working);
  latest.current = working;
  const [revealed, setRevealed] = useState<string | null>(null);
  // Keyed on which rows there are, so lighting one up doesn't cancel its own scroll.
  const rows = working.map((item) => item.id).join(" ");
  useEffect(() => {
    if (!rows) return;
    const fresh = latest.current.find(
      (item) =>
        !seen.current.has(item.id) &&
        Date.parse(item.startedAt) > openedAt.current - 20_000,
    );
    for (const item of latest.current) seen.current.add(item.id);
    if (!fresh) return;
    setRevealed(fresh.id);
    const frame = requestAnimationFrame(() =>
      document
        .querySelector(`[data-started-row="${CSS.escape(fresh.id)}"]`)
        ?.scrollIntoView({
          block: "center",
          behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
        }),
    );
    const timer = setTimeout(() => setRevealed(null), REVEAL_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [rows]);
  return revealed;
}

/** "Updated just now", "Updated 1 min. ago": how long since the list was last read. */
function updatedAgo(at: number) {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  return minutes < 1 ? "Updated just now" : `Updated ${minutes} min. ago`;
}

/** Each state's word and its colour, as the status line draws them. */
const STATUS: Record<StartedState, { word: string; tone: string }> = {
  working: { word: "Working", tone: "text-duet-blue" },
  needs_input: { word: "Needs input", tone: "text-duet-amber" },
  ready_for_review: { word: "Ready for review", tone: "text-duet-green" },
  failed: { word: "Failed", tone: "text-duet-red" },
};

/** What a task waiting on an approval needs, from the request itself. */
function approvalAsk(request: ApprovalRequest | undefined): string | null {
  return request
    ? `Allow it to ${describeApproval(request).title.toLowerCase()}?`
    : null;
}

/**
 * One task the person started: a box to check it off, its title, and one status line, the state in
 * its colour, then the next step in the Bot's own words. The row opens the conversation it ran in
 * at its own message. A failed one offers Try again.
 */
function StartedRow({
  item,
  request,
  highlight = false,
}: {
  item: StartedSuggestion;
  /** The approval it is waiting on, when it stopped on one. */
  request?: ApprovalRequest;
  highlight?: boolean;
}) {
  const resolved = Boolean(item.resolvedAt);
  const [filled, setFilled] = useState(resolved);
  useEffect(() => setFilled(resolved), [resolved]);
  const check = useMutation(resolveStartedMutationOptions(queryClient));
  const retry = useMutation(retryStartedMutationOptions(queryClient));
  const status = STATUS[item.state];
  const next =
    item.state === "failed"
      ? `Couldn't finish: ${item.next ?? "something went wrong"}.`
      : item.waitingOn?.kind === "approval" && !item.next
        ? approvalAsk(request)
        : item.next;
  const toggle = () => {
    setFilled(!resolved);
    // The check is seen before the row moves, and the box empties again if the change fails.
    setTimeout(
      () =>
        check.mutate(
          { id: item.id, resolved: !resolved },
          { onError: () => setFilled(resolved) },
        ),
      CHECK_SETTLE_MS,
    );
  };
  const problem = check.error ?? retry.error;
  return (
    <div
      className={cn(
        "transition-colors duration-700 motion-reduce:transition-none",
        highlight && "bg-duet-blue-soft",
      )}
      data-started-row={item.id}
    >
      <div className="flex items-start gap-[13px] px-4 py-3">
        {/* A 22px box in a 44px target. Pixels, not rem: the root font is 15px here. */}
        <label className="-m-[11px] grid size-[44px] shrink-0 cursor-pointer place-items-center rounded-full has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-duet-violet/25">
          <input
            aria-label={item.title}
            checked={filled}
            className="sr-only"
            disabled={check.isPending}
            onChange={toggle}
            type="checkbox"
          />
          <span
            aria-hidden
            className={cn(
              "grid size-[22px] place-items-center rounded-[6px] transition-colors",
              filled
                ? "bg-duet-ink text-duet-surface"
                : // Duet's 1.5px hairline and fill, light and dark (spec S0). A ring, not a border:
                  // Chrome rounds a 1.5px border down to 1px.
                  "bg-white shadow-[inset_0_0_0_1.5px_#D4D4D2] dark:bg-[#171717] dark:shadow-[inset_0_0_0_1.5px_#3C3C3C]",
            )}
          >
            {filled ? <DuetIcon name="check" size={14} stroke={2.6} /> : null}
          </span>
        </label>
        <div className="min-w-0 flex-1">
          <Link
            className="block rounded-[10px] outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/25"
            params={{ channelId: item.channelId }}
            state={focusMessageState(startedTaskMessageId(item.id))}
            to="/channel/$channelId"
          >
            <span
              className={cn(
                "type-row line-clamp-2 font-semibold [overflow-wrap:anywhere]",
                resolved ? "text-duet-ink-2" : "text-duet-ink",
              )}
            >
              {item.title}
            </span>
            {/* Checked off, it is done whatever it last was: only what it last said. */}
            {resolved ? (
              next ? (
                <span className="type-sub mt-1 block truncate text-duet-ink-3">
                  {next}
                </span>
              ) : null
            ) : (
              <span className="type-sub mt-1 block truncate text-duet-ink-2">
                <span className={status.tone}>{status.word}</span>
                {next ? ` · ${next}` : null}
              </span>
            )}
          </Link>
          {/* Under the status line, never beside it, so the reason it failed is read in full. */}
          {item.state === "failed" && item.canRetry && !resolved ? (
            <div className="mt-2 flex">
              <RowButton
                busy={retry.isPending}
                label={`Try again: ${item.title}`}
                onClick={() => retry.mutate(item.id)}
              >
                Try again
              </RowButton>
            </div>
          ) : null}
        </div>
      </div>
      {problem ? (
        <p className="type-label px-4 pb-2 text-duet-red" role="alert">
          {problem.message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What needs the person's input, answered right here. The tasks they started that ended on
 * something only they can give, or failed, each with the approval or question it is waiting on
 * right under it; then the approvals and questions no started task is waiting on. Newest first.
 * The heading's count is the tab's badge: each thing once.
 */
function NeedsInput({
  agents,
  inbox,
  items,
}: {
  agents: AgentProfile[] | undefined;
  inbox: ApprovalInboxData;
  items: StartedSuggestion[];
}) {
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const botName = (id: string) =>
    agents?.find((agent) => agent.id === id)?.name ?? id;
  const { requests, questions } = waitingOnYou(inbox);
  const approvalCard = (request: ApprovalRequest) => (
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
  );
  const questionCard = (question: PersonQuestion) => (
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
  );
  const claimed = new Set(items.flatMap((item) => item.waitingOn?.id ?? []));
  const blocks: { at: string; key: string; node: ReactNode }[] = [
    ...items.map((item) => {
      const request = requests.find((entry) => entry.id === item.waitingOn?.id);
      const question = questions.find(
        (entry) => entry.id === item.waitingOn?.id,
      );
      return {
        at: item.at,
        key: `started:${item.id}`,
        node: (
          <div className="flex flex-col gap-2">
            <DuetCard>
              <StartedRow item={item} request={request} />
            </DuetCard>
            {request
              ? approvalCard(request)
              : question
                ? questionCard(question)
                : null}
          </div>
        ),
      };
    }),
    ...requests
      .filter((request) => !claimed.has(request.id))
      .map((request) => ({
        at: request.createdAt,
        key: `request:${request.id}`,
        node: approvalCard(request),
      })),
    ...questions
      .filter((question) => !claimed.has(question.id))
      .map((question) => ({
        at: question.createdAt,
        key: `question:${question.id}`,
        node: questionCard(question),
      })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (blocks.length === 0) return null;
  return (
    <section aria-label="Needs input" className="flex flex-col gap-2">
      <SectionHeading count={blocks.length} title="Needs input" />
      <ul className="flex flex-col gap-3">
        {blocks.map((block) => (
          <li key={block.key}>{block.node}</li>
        ))}
      </ul>
    </section>
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
  onStarted,
}: {
  agents: AgentProfile[] | undefined;
  bot: AgentProfile | undefined;
  /** Told whose Bot took a suggestion once it is started, so the screen can say so. */
  onStarted: (botName: string) => void;
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
  const resolve = (
    suggestion: ProactiveSuggestion,
    action: "start" | "dismiss",
  ) =>
    act.mutate(
      { id: suggestion.id, action },
      {
        onSuccess: () => {
          if (action === "start") onStarted(botName(suggestion.agentId));
        },
      },
    );
  return (
    <section aria-label="Suggested" className="flex flex-col gap-2">
      <SectionHeading count={shown.length || undefined} title="Suggested" />
      <DuetCard>
        {suggestions.error ? (
          <p className="type-sub px-4 py-4 text-duet-red" role="alert">
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
          <div className="p-4">
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
          <p className="type-sub px-4 py-3 text-duet-red" role="alert">
            {act.error.message}
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
 * What is working, and what is lined up. First what the person started, until its turn ends, newest
 * first, then what the product's own Bot is doing from the ledgers Activity reads, with the same rows
 * and controls Activity had. The approvals and questions among its open work are left out of
 * Working: Needs input lists every one of them, and answers them in place.
 */
function BotWork({
  bot,
  started,
  revealed,
}: {
  bot: AgentProfile;
  started: StartedSuggestion[];
  /** The just-started task to light up, if any. */
  revealed: string | null;
}) {
  const activity = useQuery(botActivityQueryOptions(bot.id));
  const stop = useMutation(stopHandoffMutationOptions(queryClient));
  const cancel = useMutation(cancelFollowUpMutationOptions(queryClient));
  const botWork: ActivityRow[] = (activity.data?.inProgress ?? [])
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
  const working = [
    ...started.map((item) => ({
      key: `started:${item.id}`,
      node: <StartedRow highlight={revealed === item.id} item={item} />,
    })),
    ...botWork.map((row) => ({
      key: row.id,
      node: <ActivityLine row={row} showTime />,
    })),
  ];
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
      {working.length ? <TaskSection items={working} title="Working" /> : null}
      {upcoming.length ? (
        <ActivityCard rows={upcoming} showTime={false} title="Coming up" />
      ) : null}
    </>
  );
}

/**
 * What is resolved, folded at the foot of the list: the tasks the person checked off, newest
 * first, then the product's own Bot's finished routines, follow-ups and delegated work. Tapping
 * the heading unfolds it, and a checked box there puts a task back. Older checked-off tasks are
 * paged in with Show more, never dropped. An action the person allowed or refused is not a task:
 * its conversation shows the action that ran. Left out until something is resolved.
 */
function Resolved({
  bot,
  items,
  olderResolved,
  onMore,
}: {
  bot: AgentProfile;
  items: StartedSuggestion[];
  olderResolved: number;
  onMore: () => void;
}) {
  const activity = useQuery(botActivityQueryOptions(bot.id));
  const [open, setOpen] = useState(false);
  if (activity.isPending) return null;
  const finished = handledRows(activity.data?.completed ?? []);
  if (!items.length && !finished.length && !olderResolved) return null;
  const rows = [
    ...items.map((item) => ({
      key: `started:${item.id}`,
      node: <StartedRow item={item} />,
    })),
    ...finished.map((row) => ({
      key: row.id,
      node: <ActivityLine row={row} showTime />,
    })),
  ];
  return (
    <section aria-label="Resolved" className="flex flex-col gap-2">
      <button
        aria-expanded={open}
        className="flex min-h-11 items-center justify-between gap-2 rounded-[10px] px-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/25"
        onClick={() => setOpen((was) => !was)}
        type="button"
      >
        <h2 className="font-normal text-[15px] text-duet-ink-2 leading-5">
          Resolved
        </h2>
        <span
          className={cn(
            "text-duet-ink-2 transition-transform duration-200 motion-reduce:transition-none",
            open ? "-rotate-90" : "rotate-90",
          )}
        >
          <DuetIcon name="chevronRight" size={16} stroke={2} />
        </span>
      </button>
      {open ? (
        <DuetCard>
          <ul>
            {rows.map((row, index) => (
              <li key={row.key}>
                {index > 0 ? <Rule inset /> : null}
                {row.node}
              </li>
            ))}
          </ul>
          {olderResolved ? (
            <div className="px-4 py-3">
              <RowButton
                busy={false}
                label={`Show ${Math.min(olderResolved, RESOLVED_PAGE)} more resolved tasks`}
                onClick={onMore}
              >
                Show {Math.min(olderResolved, RESOLVED_PAGE)} more
              </RowButton>
            </div>
          ) : null}
        </DuetCard>
      ) : null}
    </section>
  );
}
