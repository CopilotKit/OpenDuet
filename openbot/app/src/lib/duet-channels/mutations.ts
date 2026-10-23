import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";
import {
  type ChannelColour,
  type ChannelIcon,
  type DuetChannel,
  duetChannelKeys,
} from "./queries";

/** What the New channel sheet sends: the Bot, then the channel's name, purpose and look. */
export type DuetChannelInput = {
  botId: string;
  name: string;
  purpose: string;
  icon: ChannelIcon;
  colour: ChannelColour;
};

export type DuetChannelPatch = Partial<Omit<DuetChannelInput, "botId">>;

const FALLBACK = "Couldn't save this channel. Try again.";

/** The channel list and the conversation roster both say what a channel is, so both are read again. */
const invalidateChannels = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: duetChannelKeys.all }),
    queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  ]);

/** Make a channel: a new conversation with the Bot, which opens with the Bot's hello. */
export const createDuetChannelMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (input: DuetChannelInput): Promise<DuetChannel> =>
      client("/api/openduet/channels", "channel", {
        method: "POST",
        body: input,
        fallback: "Couldn't make this channel. Try again.",
      }),
    onSuccess: () => invalidateChannels(queryClient),
  });

/** Change a channel's name, purpose or look. */
export const updateDuetChannelMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: DuetChannelPatch;
    }): Promise<DuetChannel> =>
      client(`/api/openduet/channels/${encodeURIComponent(id)}`, "channel", {
        method: "PATCH",
        body: patch,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateChannels(queryClient),
  });

/** Put a channel away under Archived, or bring it back. */
export const archiveDuetChannelMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      id,
      archived,
    }: {
      id: string;
      archived: boolean;
    }): Promise<DuetChannel> =>
      client(
        `/api/openduet/channels/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`,
        "channel",
        {
          method: "POST",
          fallback: archived
            ? "Couldn't archive this channel. Try again."
            : "Couldn't bring this channel back. Try again.",
        },
      ),
    onSuccess: () => invalidateChannels(queryClient),
  });

/**
 * Opened from the drawer, a conversation nobody dressed keeps the look it was drawn with, so talking
 * in it never turns it into Everything. Nothing on screen changes.
 */
export const keepDuetChannelMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string): Promise<DuetChannel> =>
      client(
        `/api/openduet/channels/${encodeURIComponent(id)}/keep`,
        "channel",
        {
          method: "POST",
          fallback: FALLBACK,
        },
      ),
    onSuccess: () => invalidateChannels(queryClient),
  });
