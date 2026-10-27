import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { DuetIcon } from "@/components/duet/icons";
import { ChannelTagOf } from "@/components/duet/channel-tag";
import { DuetCard, Tile } from "@/components/duet/kit";
import type { AgentProfile } from "@/lib/agents/queries";
import { cancelFollowUpMutationOptions } from "@/lib/bot-lifecycle/mutations";
import { botActivityQueryOptions } from "@/lib/bot-lifecycle/queries";
import { createChannelMutationOptions } from "@/lib/channels/mutations";
import { ONGOING_SEARCH_LIMIT, ongoingChannel } from "@/lib/channels/ongoing";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  changeProactiveSettingMutationOptions,
  type ProactiveSetting,
  type ProactiveSuggestion,
  personAsked,
  proactiveSettingsQueryOptions,
  proactiveSuggestionsQueryOptions,
  resolveSuggestionMutationOptions,
  turnOnResearchMutationOptions,
} from "@/lib/proactive";
import { DURATION, EASE_OUT } from "@/lib/motion";
import { useReducedMotionPreference } from "@/lib/reduced-motion";
import { matchesSearch, type SortOrder, sortByTime } from "@/lib/tasks/groups";
import { queryClient } from "@/query-client";
import {
  ActivityCard,
  type ActivityRow,
  RowButton,
  upcomingRow,
} from "./activity-screen";
import { type AnswerSuggestion, SmallPill } from "./suggestion-card";
import { SwipeToAnswer } from "./swipe-to-answer";

/**
 * What the product's own Bot looks for when the person turns research on from Tasks. OpenDuet works
 * in mail and calendar, so this names the things there that end up as tasks. The Bot reads it as
 * the person's own request, so it is written in their voice.
 */
export const RESEARCH_FOCUS =
  "Replies I owe, decisions waiting on me, payments due and deadlines coming up, in my mail and calendar.";

/** How often Up next reads again while Show me is looking. */
export const LOOKING_POLL_MS = 3_000;
/** How long Show me says "Looking…" before it gives up waiting on the check-in. */
export const LOOK_FOR_MS = 3 * 60_000;

/**
 * Tasks' Up next: what nobody has started yet. The suggestions OpenDuet's research and check-ins
 * left, and the tasks the person asked to add, from a conversation or from the + button. Each slides
 * off, right to start it as a task and left to hide it, or takes Start and Hide.
 *
 * Empty, it asks what it can take off the person's plate, and Show me looks now.
 *
 * A card that goes, by a swipe or a button, leaves its place to the cards under it: they slide up
 * into it (`layout`, which moves them by transform) rather than jumping on the frame the list is read
 * again. A swiped card has already flown off the screen, so its place closes as soon as it lands,
 * not a request later: the gap it left read as the list having stalled. If the answer then fails the
 * card comes back, with the reason on it. One answered by a button stays, busy, until the answer is
 * in, then fades as the cards under it close over it. Cards that arrive later, as Show me finds them,
 * fade in. With reduced motion nothing slides: the card fades and the rest take its place.
 */
export function UpNextView({
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
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const settings = useQuery(proactiveSettingsQueryOptions());
  const activity = useQuery({
    ...botActivityQueryOptions(bot?.id ?? ""),
    enabled: Boolean(bot),
  });
  const act = useMutation(resolveSuggestionMutationOptions(queryClient));
  const reduced = useReducedMotionPreference();
  const cancel = useMutation(cancelFollowUpMutationOptions(queryClient));
  // Who took the last started suggestion, said once it has gone from the list.
  const [started, setStarted] = useState<string | null>(null);
  // Cards a swipe sent off the screen, left out of the list while their answer is on its way.
  const [flown, setFlown] = useState<ReadonlySet<string>>(new Set());
  const land = (id: string, gone: boolean) =>
    setFlown((current) => {
      const next = new Set(current);
      if (gone) next.add(id);
      else next.delete(id);
      return next;
    });
  const setting = bot
    ? settings.data?.find((row) => row.agentId === bot.id)
    : undefined;
  const researchOff = Boolean(bot && settings.data && !setting?.enabled);
  const botName = (id: string) =>
    agents?.find((agent) => agent.id === id)?.name ?? "Your Bot";

  if (suggestions.isPending) return null;
  const open = suggestions.data ?? [];
  const shown = sortByTime(
    open
      .filter(
        (suggestion) =>
          !flown.has(suggestion.id) && matchesSearch(suggestion.title, query),
      )
      .map((suggestion) => ({ suggestion, at: suggestion.createdAt })),
    order,
  ).map(({ suggestion }) => suggestion);
  const upcoming: ActivityRow[] = bot
    ? (activity.data?.scheduled ?? []).map((item) => ({
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
      }))
    : [];
  const answer =
    (suggestion: ProactiveSuggestion): AnswerSuggestion =>
    (action, comeBack) => {
      setStarted(null);
      // Only a swipe hands over `comeBack`, and by then its card has left the screen.
      if (comeBack) land(suggestion.id, true);
      act.mutate(
        { id: suggestion.id, action },
        {
          onSuccess: () => {
            if (action === "start") setStarted(botName(suggestion.agentId));
            // The list has been read again by now, without it.
            land(suggestion.id, false);
          },
          onError: () => {
            land(suggestion.id, false);
            comeBack?.();
          },
        },
      );
    };

  return (
    <div className="flex flex-col gap-5">
      {suggestions.error ? (
        <p className="type-sub px-1 text-duet-red" role="alert">
          Couldn't load Up next. Reload the page.
        </p>
      ) : null}
      {open.length === 0 && !suggestions.error ? (
        bot ? (
          <TakeOffYourPlate bot={bot} />
        ) : null
      ) : shown.length === 0 && query.trim() ? (
        <p className="type-sub px-1 text-duet-ink-2" role="status">
          Nothing matches “{query.trim()}”.
        </p>
      ) : (
        <section aria-label="Up next">
          {/*
           * Positioned, so a card on its way out can be lifted out of the list's flow. Drawn afresh
           * for each search, so typing narrows the list at once rather than fading every card that
           * stopped matching.
           */}
          <ul className="relative">
            <AnimatePresence initial={false} key={query} mode="popLayout">
              {shown.map((suggestion) => (
                <motion.li
                  animate={{ opacity: 1 }}
                  data-up-next={suggestion.id}
                  exit={{ opacity: 0 }}
                  initial={{ opacity: 0 }}
                  key={suggestion.id}
                  layout={reduced ? false : "position"}
                  transition={{
                    duration: DURATION.swap,
                    ease: EASE_OUT,
                    layout: { duration: DURATION.enter, ease: EASE_OUT },
                  }}
                >
                  <UpNextCard
                    busy={act.isPending && act.variables?.id === suggestion.id}
                    error={
                      act.error && act.variables?.id === suggestion.id
                        ? act.error.message
                        : null
                    }
                    from={
                      suggestion.agentId === bot?.id
                        ? null
                        : botName(suggestion.agentId)
                    }
                    onAnswer={answer(suggestion)}
                    suggestion={suggestion}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </section>
      )}
      {started ? (
        <motion.p
          animate={{ opacity: 1, filter: "blur(0px)" }}
          className="type-sub px-1 text-duet-ink-2"
          initial={{ opacity: 0, filter: reduced ? "none" : "blur(2px)" }}
          role="status"
          transition={{ duration: DURATION.swap, ease: EASE_OUT }}
        >
          Started. {started} is on it.
        </motion.p>
      ) : null}
      {researchOff && bot && open.length > 0 ? (
        <DuetCard>
          <ResearchOptIn bot={bot} setting={setting} />
        </DuetCard>
      ) : null}
      {activity.error && bot ? (
        <p className="type-sub px-1 text-duet-red" role="alert">
          Couldn't load what {bot.name} has lined up. Reload the page.
        </p>
      ) : null}
      {cancel.error ? (
        <p className="type-sub px-1 text-duet-red" role="alert">
          {cancel.error.message}
        </p>
      ) : null}
      {upcoming.length ? (
        <ActivityCard rows={upcoming} showTime={false} title="Coming up" />
      ) : null}
    </div>
  );
}

/**
 * One thing not started: what to do, a line or two of why, who it is from, and Hide and Start.
 * A finger or a mouse slides it off, right to start it and left to hide it.
 */
function UpNextCard({
  suggestion,
  from,
  busy,
  error,
  onAnswer,
}: {
  suggestion: ProactiveSuggestion;
  /** The Bot's name, said only when it is not the product's own. */
  from: string | null;
  busy: boolean;
  error: string | null;
  onAnswer: AnswerSuggestion;
}) {
  const app =
    suggestion.sourceApp || suggestion.sourceLink
      ? `From ${suggestion.sourceApp ?? "a connected app"}`
      : null;
  const source = suggestion.sourceLink ? (
    <a
      className="underline decoration-duet-hair underline-offset-2 transition-colors hover:text-duet-ink"
      href={suggestion.sourceLink}
      rel="noreferrer"
      target="_blank"
    >
      {app}
    </a>
  ) : (
    app
  );
  const tag = [
    personAsked(suggestion) ? "You asked" : null,
    from,
    source,
  ].filter(Boolean);
  return (
    <SwipeToAnswer
      disabled={busy}
      onHide={(comeBack) => onAnswer("dismiss", comeBack)}
      onStart={(comeBack) => onAnswer("start", comeBack)}
    >
      <DuetCard className="px-4 py-3">
        <p className="type-row font-semibold text-duet-ink [overflow-wrap:anywhere]">
          {suggestion.title}
        </p>
        {suggestion.detail ? (
          <p className="type-sub line-clamp-2 text-duet-ink-2 [overflow-wrap:anywhere]">
            {suggestion.detail}
          </p>
        ) : null}
        {tag.length ? (
          <p className="type-label mt-1 font-medium text-duet-ink-3">
            {tag.map((part, index) => (
              <span key={typeof part === "string" ? part : "source"}>
                {index > 0 ? " · " : null}
                {part}
              </span>
            ))}
          </p>
        ) : null}
        <ChannelTagOf channelId={suggestion.fromChannelId} className="mt-1.5" />
        {error ? (
          <p className="type-label mt-1 text-duet-red" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-2.5 flex gap-2">
          <SmallPill
            aria-label={`Hide ${suggestion.title}`}
            disabled={busy}
            onClick={() => onAnswer("dismiss")}
          >
            Hide
          </SmallPill>
          <SmallPill
            aria-label={`Start ${suggestion.title}`}
            disabled={busy}
            onClick={() => onAnswer("start")}
            primary
          >
            Start
          </SmallPill>
        </div>
      </DuetCard>
    </SwipeToAnswer>
  );
}

/**
 * The person's conversation with the Bot, found the way Chat finds it, so research set up from
 * Tasks lands where they already talk to it. With none yet, one is started, as Chat's first message
 * would.
 */
function useChatChannel(bot: AgentProfile) {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const createChannel = useMutation(createChannelMutationOptions(queryClient));
  const find = async () => {
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
  return { find, pending: channels.isPending };
}

/** Where Show me stands: looking since a run, or done looking with what it found. */
type Look =
  | { kind: "looking"; lastRunAt: string | null; until: number }
  | { kind: "nothing" }
  | { kind: "failed" }
  | { kind: "slow" };

/**
 * Up next with nothing in it: what it can take off the person's plate, the apps it would look in,
 * and Show me. Show me asks the product's own Bot to check in now, or turns its research on when it
 * is off, then says "Looking…" until the check-in has run or new suggestions arrive. Arriving, they
 * take this card's place.
 */
function TakeOffYourPlate({ bot }: { bot: AgentProfile }) {
  const [look, setLook] = useState<Look | null>(null);
  const looking = look?.kind === "looking" ? look : null;
  const poll = looking ? { refetchInterval: LOOKING_POLL_MS } : {};
  const settings = useQuery({ ...proactiveSettingsQueryOptions(), ...poll });
  // Read as often while looking, so suggestions that arrive replace this card at once.
  useQuery({ ...proactiveSuggestionsQueryOptions(), ...poll });
  const turnOn = useMutation(turnOnResearchMutationOptions(queryClient));
  const change = useMutation(
    changeProactiveSettingMutationOptions(queryClient),
  );
  const chat = useChatChannel(bot);
  const setting = settings.data?.find((row) => row.agentId === bot.id);

  // The check-in started after Show me and has finished: say what came of it.
  if (
    looking &&
    setting &&
    setting.lastRunAt !== looking.lastRunAt &&
    (setting.lastStatus === "succeeded" || setting.lastStatus === "error")
  )
    setLook({ kind: setting.lastStatus === "error" ? "failed" : "nothing" });

  useEffect(() => {
    if (!looking) return;
    const timer = setTimeout(
      () => setLook({ kind: "slow" }),
      Math.max(0, looking.until - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [looking]);

  const busy =
    turnOn.isPending ||
    change.isPending ||
    settings.isPending ||
    (chat.pending && !setting);
  const error = turnOn.error ?? change.error;
  const showMe = () => {
    const from: Look = {
      kind: "looking",
      lastRunAt: setting?.lastRunAt ?? null,
      until: Date.now() + LOOK_FOR_MS,
    };
    const onSuccess = () => setLook(from);
    setLook(null);
    if (setting?.enabled)
      change.mutate({ setting, change: { kind: "run" } }, { onSuccess });
    else
      turnOn.mutate(
        {
          setting,
          agentId: bot.id,
          focus: RESEARCH_FOCUS,
          channelId: chat.find,
        },
        { onSuccess },
      );
  };

  return (
    <section
      aria-label="Up next"
      className="flex flex-col items-center px-6 pt-10 text-center"
    >
      <h2 className="type-title font-semibold text-duet-ink">
        What can I take off your plate?
      </h2>
      <p className="type-sub mt-1.5 text-duet-ink-2">
        I'll look through your mail and calendar for things I can handle.
      </p>
      <ul aria-label="What it checks" className="mt-5 flex gap-3">
        <AppMark icon="mail" name="Gmail" tone="red" />
        <AppMark icon="calendar" name="Calendar" tone="blue" />
      </ul>
      <div className="mt-6 flex min-h-[46px] flex-col items-center gap-2">
        {looking ? (
          <p
            className="type-row flex h-[46px] items-center font-semibold text-duet-ink-2"
            role="status"
          >
            <span className="tool-line-running">Looking…</span>
          </p>
        ) : (
          <button
            className="type-row inline-flex h-[46px] items-center gap-2 rounded-full bg-duet-black px-6 font-semibold text-duet-on-black transition-[filter,transform,opacity] hover:brightness-125 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-[0.98] disabled:opacity-50"
            disabled={busy}
            onClick={showMe}
            type="button"
          >
            Show me
            <DuetIcon name="arrowRight" size={18} stroke={2.4} />
          </button>
        )}
        {error ? (
          <p className="type-label text-duet-red" role="alert">
            {error.message}
          </p>
        ) : look?.kind === "nothing" ? (
          <p className="type-label text-duet-ink-2" role="status">
            Nothing new right now. I'll keep checking.
          </p>
        ) : look?.kind === "failed" ? (
          <p className="type-label text-duet-red" role="alert">
            Couldn't check just now. Try again.
          </p>
        ) : look?.kind === "slow" ? (
          <p className="type-label text-duet-ink-2" role="status">
            This is taking a while. New tasks show up here.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** A small app tile with its name under it: a plain glyph, never the app's own mark. */
function AppMark({
  icon,
  name,
  tone,
}: {
  icon: "mail" | "calendar";
  name: string;
  tone: "red" | "blue";
}) {
  return (
    <li className="flex flex-col items-center gap-1">
      <Tile icon={icon} size={44} tone={tone} />
      <span className="type-label font-medium text-duet-ink-3">{name}</span>
    </li>
  );
}

/**
 * The offer shown under Up next when research is off for the product's own Bot and there is
 * something listed: turn it on with a button. A setting the person turned off comes back on as they
 * left it.
 */
function ResearchOptIn({
  bot,
  setting,
}: {
  bot: AgentProfile;
  setting: ProactiveSetting | undefined;
}) {
  const chat = useChatChannel(bot);
  const turnOn = useMutation(turnOnResearchMutationOptions(queryClient));
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
            busy={turnOn.isPending || chat.pending}
            label="Turn on"
            onClick={() =>
              turnOn.mutate({
                setting,
                agentId: bot.id,
                focus: RESEARCH_FOCUS,
                channelId: chat.find,
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
