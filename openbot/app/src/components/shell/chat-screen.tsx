import type { Message } from "@ag-ui/core";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  seedMessage,
  stashFirstMessage,
} from "@/components/channels/transcript-messages";
import { primaryBot } from "@/lib/agents/primary-bot";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { createChannelMutationOptions } from "@/lib/channels/mutations";
import { ONGOING_SEARCH_LIMIT, ongoingChannel } from "@/lib/channels/ongoing";
import {
  type AgentChannel,
  channelKeys,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { routeMessage } from "@/lib/channels/route";
import { startWithChosen } from "@/lib/channels/start";
import { newId } from "@/lib/new-id";

/**
 * The Chat tab: the person's one ongoing conversation with the product's own Bot.
 *
 * It is that Bot's most recent channel, drawn by the same chat every channel uses, so tool activity,
 * inline approvals, the password box and the Bot's computer all work here as they do anywhere. With
 * no channel yet, the first message makes one and the conversation carries on in place.
 */
export function ChatScreen() {
  const agents = useQuery(agentListQueryOptions());
  const bot = primaryBot(agents.data);
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [started, setStarted] = useState<AgentChannel | null>(null);
  const channel =
    started ?? (bot ? ongoingChannel(channels.data, bot.id) : undefined);
  const searching =
    !channel &&
    channels.hasNextPage &&
    !channels.isFetchNextPageError &&
    (channels.data?.length ?? 0) < ONGOING_SEARCH_LIMIT;
  const { fetchNextPage, isFetchingNextPage } = channels;

  // The roster is paged; a person with many other conversations may have this one further back.
  useEffect(() => {
    if (bot && searching && !isFetchingNextPage)
      void fetchNextPage({ cancelRefetch: false });
  }, [bot, searching, isFetchingNextPage, fetchNextPage]);

  // Nothing while the first answers load: a placeholder inside a local round trip is a flicker.
  if (agents.isPending || channels.isPending) return null;
  if (!agents.data)
    return (
      <ScreenNotice alert>
        Couldn't load your Bots. Reload the page.
      </ScreenNotice>
    );
  if (!bot) return <ScreenNotice>There are no Bots yet.</ScreenNotice>;
  if (!channels.data)
    return (
      <ScreenNotice alert>
        Couldn't load your conversation. Reload the page.
      </ScreenNotice>
    );
  if (channel)
    return (
      <OngoingChat
        channel={channel}
        botId={bot.id}
        key={channel.id}
        topic={channels.data.find((row) => row.id === channel.id)?.summary}
      />
    );
  if (searching) return null;
  return <FirstMessage bot={bot} onStarted={setStarted} />;
}

function OngoingChat({
  channel,
  botId,
  topic,
}: {
  channel: AgentChannel;
  botId: string;
  topic: string | null | undefined;
}) {
  // Open on screen is read, as it is on the conversation's own page.
  useMarkOpenChannelRead(channel.id);
  return (
    <ChannelChat
      channel={channel}
      inShell
      runtimeAgentId={botId}
      topic={topic ?? null}
    />
  );
}

/**
 * No conversation yet. The first message creates the channel, recorded as a choice of this Bot the
 * way picking it anywhere else is, and the chat takes over in place.
 */
function FirstMessage({
  bot,
  onStarted,
}: {
  bot: AgentProfile;
  onStarted: (channel: AgentChannel) => void;
}) {
  const queryClient = useQueryClient();
  const createChannel = useMutation(createChannelMutationOptions(queryClient));
  const [sent, setSent] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <ConversationView
      inShell
      lead={
        sent ? null : (
          <div className="px-1 pt-2">
            <h1 className="type-title font-semibold">{bot.name}</h1>
            <p className="type-sub mt-1 text-duet-ink-2">
              {bot.roleDescription}
            </p>
          </div>
        )
      }
      messages={sent ? [sent] : []}
      notice={
        error ? (
          <p className="type-label pb-2 text-duet-red" role="alert">
            {error}
          </p>
        ) : null
      }
      onSubmit={async (draft) => {
        setError(null);
        setSent(seedMessage(draft.text, newId()));
        try {
          await startWithChosen({
            agentId: bot.id,
            text: draft.text,
            record: routeMessage,
            start: async (agentId, text) => {
              const channel = await createChannel.mutateAsync([agentId]);
              queryClient.setQueryData(channelKeys.detail(channel.id), channel);
              stashFirstMessage(channel.id, text);
              onStarted(channel);
            },
          });
        } catch (caught) {
          // The composer keeps the draft for another try.
          setSent(null);
          setError(
            caught instanceof Error
              ? caught.message
              : "Couldn't start the conversation. Try again.",
          );
          throw caught;
        }
      }}
      pending={createChannel.isPending}
      placeholder={`Message ${bot.name}`}
    />
  );
}

/** A sentence in place of a screen that could not be drawn. */
export function ScreenNotice({
  children,
  alert = false,
}: {
  children: ReactNode;
  alert?: boolean;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 pt-[100px] text-center">
      <p
        className={
          alert ? "type-sub text-duet-red" : "type-sub text-duet-ink-2"
        }
        role={alert ? "alert" : undefined}
      >
        {children}
      </p>
    </div>
  );
}
