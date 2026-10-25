import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { client } from "../client";

/**
 * A channel as the browser sees it.
 *
 * `threadId` is what makes two channels with the same coworker independent conversations, and
 * `active` is false once a linked coworker has been deleted: the transcript stays readable, but
 * nothing more can be said in it.
 */
export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
  /**
   * ISO-8601 when something was last said here, or null for a conversation nobody has used.
   *
   * The conversation screen needs this to tell two silences apart: a new conversation with no
   * history, and one whose history this deployment cannot reach. See `channel-chat.tsx`.
   */
  lastMessageAt: string | null;
};

/** A channel plus what the roster renders about it. */
export type ChannelSummary = AgentChannel & {
  /** A few words about the conversation, or null. The roster falls back to `name`. */
  summary: string | null;
  lastMessage: string | null;
  lastMessageAgentId: string | null;
  /** ISO-8601. Ordering falls back to this, so a channel just created sorts to the top. */
  createdAt: string;
  /** Whether this member pinned the channel. Pinned channels sort first in the roster. */
  pinned: boolean;
  /** ISO-8601 when this member last had the channel open, or null for never. The caller's, only. */
  lastReadAt: string | null;
  /**
   * The OpenDuet task this conversation is the work of, or null for an ordinary one. A task works in
   * a conversation of its own; Chat and the menu leave those out, and Tasks lists them. Absent on a
   * row this browser made itself, which is never a task's.
   */
  taskId?: string | null;
  /**
   * Whether this conversation is one of the person's OpenDuet channels, with a look of its own. The
   * drawer lists those; Chat, which is Everything, leaves them out. Absent on a row this browser made
   * itself, which is never one.
   */
  openduetChannel?: boolean;
  /**
   * Whether a turn is running in this channel right now.
   *
   * Returned by roster reads and patched by run/expiry events, including for headless turns that
   * this browser never streamed. Absent on a row the browser optimistically created itself.
   */
  busy?: boolean;
};

export const channelKeys = {
  all: ["channels"] as const,
  list: () => ["channels", "list"] as const,
  detail: (channelId: string) => ["channels", "detail", channelId] as const,
};

/** One page of channels, and where the next one starts. */
export type ChannelPage = {
  channels: ChannelSummary[];
  nextCursor: string | null;
};

/**
 * The sidebar's channels, a page at a time.
 *
 * It used to ask for every channel this person has, one row per channel-agent pair, on every render.
 * Nothing removes a channel, so somebody who talks to their Bot daily accumulates thousands and the
 * query grows monotonically for as long as they use the product.
 *
 * The pages are flattened for the caller, so the sidebar and the socket that patches it both see one
 * array in recency order and neither has to know this is paged.
 */
export function channelListQueryOptions() {
  return infiniteQueryOptions({
    queryKey: channelKeys.list(),
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }): Promise<ChannelPage> => {
      const suffix = pageParam
        ? `?cursor=${encodeURIComponent(pageParam as string)}`
        : "";
      const response = await client(`/api/channels${suffix}`, {
        fallback: "Couldn't load your conversations.",
        signal,
      });
      return (await response.json()) as ChannelPage;
    },
    getNextPageParam: (page: ChannelPage) => page.nextCursor ?? undefined,
    select: (data): ChannelSummary[] =>
      data.pages.flatMap((page) => page.channels),
  });
}

export function channelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.detail(channelId),
    queryFn: async (): Promise<AgentChannel> => {
      return client(`/api/channels/${channelId}`, "channel", {
        fallback: "Couldn't load this conversation.",
      });
    },
  });
}
