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
import { ChatSuggestionProvider } from "@/components/shell/chat-suggestion";
import { FIRST_DAY_REQUEST, FirstDay } from "@/components/shell/first-day";
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
  /*
   * A conversation that has never had a message still opens on the first-day offer: one made only to
   * hold the Bot's background research, say. The first message then goes into it rather than into a
   * second conversation.
   */
  if (channel && !started && channel.lastMessageAt === null)
    return <FirstMessage bot={bot} existing={channel} onStarted={setStarted} />;
  if (channel)
    return (
      <OngoingChat
        channel={channel}
        bot={bot}
        key={channel.id}
        topic={channels.data.find((row) => row.id === channel.id)?.summary}
      />
    );
  if (searching) return null;
  return <FirstMessage bot={bot} onStarted={setStarted} />;
}

function OngoingChat({
  channel,
  bot,
  topic,
}: {
  channel: AgentChannel;
  bot: AgentProfile;
  topic: string | null | undefined;
}) {
  // Open on screen is read, as it is on the conversation's own page.
  useMarkOpenChannelRead(channel.id);
  return (
    <ChatSuggestionProvider bot={{ id: bot.id, name: bot.name }}>
      <ChannelChat
        channel={channel}
        inShell
        runtimeAgentId={bot.id}
        topic={topic ?? null}
      />
    </ChatSuggestionProvider>
  );
}

/**
 * No conversation yet. The first message creates the channel, recorded as a choice of this Bot the
 * way picking it anywhere else is, and the chat takes over in place. Until then Chat offers to start
 * by getting to know the person, which sends that request as their first message.
 */
function FirstMessage({
  bot,
  existing,
  onStarted,
}: {
  bot: AgentProfile;
  /** A conversation with the Bot that has no messages yet, to start in instead of making one. */
  existing?: AgentChannel;
  onStarted: (channel: AgentChannel) => void;
}) {
  const queryClient = useQueryClient();
  const createChannel = useMutation(createChannelMutationOptions(queryClient));
  const [sent, setSent] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Sends the first message, from the composer or from "Get to know me". Throws when it fails. */
  const start = async (text: string) => {
    setError(null);
    setSent(seedMessage(text, newId()));
    try {
      await startWithChosen({
        agentId: bot.id,
        text,
        record: routeMessage,
        start: async (agentId, first) => {
          const channel =
            existing ?? (await createChannel.mutateAsync([agentId]));
          queryClient.setQueryData(channelKeys.detail(channel.id), channel);
          stashFirstMessage(channel.id, first);
          onStarted(channel);
        },
      });
    } catch (caught) {
      setSent(null);
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't start the conversation. Try again.",
      );
      throw caught;
    }
  };

  return (
    <ConversationView
      inShell
      lead={
        sent ? null : (
          <FirstDay
            busy={createChannel.isPending}
            name={bot.name}
            onStart={() => {
              // The notice above the composer says what went wrong; there is no draft to keep.
              start(FIRST_DAY_REQUEST).catch(() => {});
            }}
          />
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
      // The composer keeps the draft for another try when this throws.
      onSubmit={(draft) => start(draft.text)}
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
