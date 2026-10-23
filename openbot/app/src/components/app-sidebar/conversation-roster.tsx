import { useInfiniteQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type RefObject, useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { relativeTime } from "@/lib/relative-time";
import {
  type MessageListEmphasis,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { DuetIcon } from "@/components/duet/icons";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Channel } from "./channel";
import { ChannelPagination } from "./channel-pagination";

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

/**
 * The roster, narrowed to what the person typed.
 *
 * Matches the channel's name, its summary, and the last message, because those are the things the
 * row can actually show — searching against something invisible returns results a person cannot
 * account for. The last message is included because it is still what the second line draws until the
 * conversation has been named. Message history beyond that line is not here to search: it lives in
 * the thread store, and reaching for it is a server endpoint rather than a filter.
 *
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 */
export function matchingChannels(
  channels: ChannelSummary[] | undefined,
  query: string,
): ChannelSummary[] {
  if (!channels) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return channels;
  }
  return channels.filter((channel) =>
    [channel.name, channel.summary, channel.lastMessage].some((field) =>
      field?.toLowerCase().includes(needle),
    ),
  );
}

/**
 * The roster without the conversations tasks work in. Each task has one of its own with the Bot, and
 * they live in Tasks; listed here, a handful of tasks would bury every conversation the person had.
 * Returns the input unchanged when it holds none, for the identity reason `matchingChannels` gives.
 */
export function withoutTasks(
  channels: ChannelSummary[] | undefined,
): ChannelSummary[] {
  if (!channels) return [];
  return channels.some((channel) => channel.taskId)
    ? channels.filter((channel) => !channel.taskId)
    : channels;
}

/**
 * Pinned channels first, everything else after, newest activity first within each group.
 *
 * The mirror of a server rule, not the rule itself: the roster query orders pinned-first and its
 * cursor carries the pin, so a pinned channel arrives on page one however long ago it was last
 * spoken in. Sorting here as well is for what happens between refetches — the socket patches a pin
 * onto a loaded row without moving it, and re-sorts a page by recency alone — which is the same
 * reason `byRecency` in use-channel-events.ts mirrors the recency rule. A stable partition, so the
 * recency order inside each group is whatever arrived.
 */
export function pinnedFirst(channels: ChannelSummary[]): ChannelSummary[] {
  return [...channels].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/**
 * Whether a Bot has said something this member has not had on screen yet.
 *
 * A Bot's message, and only a Bot's: your own message carries a null agent id and reading your own
 * words needs no marker. ISO-8601 strings compare correctly as strings, which is the same bet the
 * server's recency sort already makes.
 */
export function hasUnseenActivity(channel: ChannelSummary): boolean {
  if (channel.lastMessageAgentId === null || channel.lastMessageAt === null) {
    return false;
  }
  return (
    channel.lastReadAt === null || channel.lastMessageAt > channel.lastReadAt
  );
}

/** Unseen activity somewhere you are not looking. The open channel never shows the dot. */
export function isUnread(
  channel: ChannelSummary,
  openChannelId: string | undefined,
): boolean {
  return channel.id !== openChannelId && hasUnseenActivity(channel);
}

/**
 * A roster row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a roster that reacts to being read is a roster that
 * moves under the cursor.
 */
function ChannelRow({
  channel,
  animateOrder,
  emphasis,
}: {
  channel: ChannelSummary;
  animateOrder: boolean;
  emphasis: MessageListEmphasis;
}) {
  const shouldReduceMotion = useReducedMotion();
  // Whether this row is unread, as a boolean, for the same reason `Channel` computes `isOpen`
  // that way: navigating re-renders the rows whose answer changed, not the whole roster.
  const unread = useParams({
    strict: false,
    select: (params) =>
      isUnread(channel, (params as { channelId?: string }).channelId),
  });
  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      initial={{
        opacity: 0,
        transform: shouldReduceMotion ? "none" : "translateY(-8px)",
      }}
      exit={{ opacity: 0 }}
      layout={animateOrder && !shouldReduceMotion ? "position" : false}
      transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
    >
      <Channel
        emphasis={emphasis}
        channelId={channel.id}
        participantIds={channel.agentIds}
        name={channel.name}
        summary={channel.summary ?? undefined}
        lastMessage={channel.lastMessage ?? undefined}
        threadId={channel.threadId}
        said={channel.lastMessageAt !== null}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTime(channel.lastMessageAt)
            : undefined
        }
        pinned={channel.pinned}
        unread={unread}
        busy={channel.busy ?? false}
      />
    </motion.div>
  );
}

/**
 * Every conversation this person has, searchable, newest first, paged in as they scroll. It was
 * the app sidebar's body; it now lives in the shell's menu, under Earlier conversations, so the
 * conversations other than the one on the Chat tab stay a tap away. Tasks' own conversations are
 * left out; they open from Tasks.
 *
 * `scrollRoot` is the element that scrolls the list, which the pager watches to fetch older pages.
 */
export function ConversationRoster({
  scrollRoot,
}: {
  scrollRoot: RefObject<HTMLDivElement | null>;
}) {
  const emphasis = useMessageListEmphasis();
  const channels = useInfiniteQuery(channelListQueryOptions());
  const conversations = withoutTasks(channels.data);
  const [search, setSearch] = useState("");
  const searching = search.trim().length > 0;
  const visibleChannels = pinnedFirst(matchingChannels(conversations, search));
  /*
   * FILTERING DOES NOT ANIMATE. Rows exit and relayout on every keystroke otherwise, which is a
   * list thrashing under somebody who is still typing. Order animation is for a channel that was
   * just spoken in, which is occasional; this is not.
   */
  const animateOrder = !searching && conversations.length <= MAX_ANIMATED_ROWS;

  return (
    <div className="flex flex-col gap-px">
      {/* The menu scrolls the roster by itself, and the search stays above the rows it filters. */}
      <div className="sticky top-0 z-10 bg-duet-surface pb-2">
        <InputGroup className="h-11 rounded-full bg-background type-sub">
          <InputGroupInput
            aria-label="Search conversations"
            className="h-11"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search…"
            value={search}
          />
          <InputGroupAddon>
            <DuetIcon name="search" size={18} />
          </InputGroupAddon>
        </InputGroup>
      </div>
      {/*
       * TWO DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody has
       * used yet needs telling how to start. A roster that simply does not match what is in
       * the box has to say so and quote it back — told "you don't have channels yet" while
       * holding a typo, a person reads their conversations as gone.
       */}
      {searching && visibleChannels.length === 0 ? (
        <div className="py-4">
          <Empty className="border border-dashed min-h-40">
            <EmptyHeader>
              <EmptyTitle>
                {channels.hasNextPage
                  ? "No loaded conversations match your search"
                  : "No conversations match your search"}
              </EmptyTitle>
              <EmptyDescription className="text-pretty">
                {channels.hasNextPage
                  ? "Load older conversations to search more of your history."
                  : `No conversation has “${search.trim()}” in its name or latest message.`}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : null}
      {!searching &&
      channels.data &&
      conversations.length === 0 &&
      !channels.hasNextPage ? (
        <div className="py-4">
          <Empty className="border border-dashed min-h-40">
            <EmptyHeader>
              <EmptyTitle>No conversations yet</EmptyTitle>
              <EmptyDescription className="text-pretty">
                Start a conversation with a Bot and it shows up here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : null}
      <AnimatePresence initial={false}>
        {visibleChannels.map((channel) => (
          <ChannelRow
            animateOrder={animateOrder}
            channel={channel}
            emphasis={emphasis}
            key={channel.id}
          />
        ))}
      </AnimatePresence>
      <ChannelPagination
        query={channels}
        scrollRoot={scrollRoot}
        searching={searching}
      />
    </div>
  );
}
