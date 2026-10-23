import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export {
  CHANNEL_COLOURS,
  CHANNEL_ICONS,
  type ChannelColour,
  type ChannelIcon,
  MAX_CHANNEL_NAME,
  MAX_CHANNEL_PURPOSE,
  NEW_CHANNEL_COLOUR,
  NEW_CHANNEL_ICON,
} from "@openbot/shared/channel-look";

import type { ChannelColour, ChannelIcon } from "@openbot/shared/channel-look";

/*
 * The person's channels, as the drawer lists them (server/src/openduet/channels.ts): named
 * workstreams, each a conversation with the Bot, with an icon on a disc in its colour and one line
 * of purpose. Everything, the one thread Chat shows, is named apart and never listed as a channel.
 */

export type DuetChannel = {
  id: string;
  name: string;
  /** The purpose line, or null for a conversation nobody gave one. */
  purpose: string | null;
  icon: ChannelIcon;
  colour: ChannelColour;
  /** Whether it has a look of its own. One that has none is kept as a channel when it is opened. */
  dressed: boolean;
  /** ISO-8601 when it was put away under Archived, or null. */
  archivedAt: string | null;
  agentIds: string[];
  lastMessageAt: string | null;
  createdAt: string;
  /**
   * For a conversation with no look of its own, listed under Archived as one of the "Earlier
   * conversations": its summary, the last thing said in it, and its thread, to read what the person
   * first asked (`conversationTitle`). Absent from a server that does not send them.
   */
  summary?: string | null;
  lastMessage?: string | null;
  threadId?: string;
};

export type DuetChannelList = {
  /** Everything's conversation, or null before the person has one. */
  everythingId: string | null;
  /** Every channel, newest activity first, archived ones included and marked. */
  channels: DuetChannel[];
};

export const duetChannelKeys = {
  all: ["duet-channels"] as const,
  list: (botId: string) => ["duet-channels", "list", { botId }] as const,
};

/** The person's channels, with Everything named for the Bot the tabs are about. */
export const duetChannelListQueryOptions = (botId: string) =>
  queryOptions({
    queryKey: duetChannelKeys.list(botId),
    queryFn: async (): Promise<DuetChannelList> =>
      (
        await client(
          `/api/openduet/channels?bot=${encodeURIComponent(botId)}`,
          { fallback: "Couldn't load your channels." },
        )
      ).json(),
  });
