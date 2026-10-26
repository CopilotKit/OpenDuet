import type { Message } from "@ag-ui/core";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ConversationView } from "@/components/channels/conversation-view";
import { useCheckInNotifications } from "@/components/shell/check-in-notifier";
import { ChatSuggestionProvider } from "@/components/shell/chat-suggestion";
import { DraftWatch, useFirstDayGreeting } from "@/components/shell/first-day";
import { PersonWatch, useMorningBrief } from "@/components/shell/morning-brief";
import {
  seedMessage,
  stashFirstMessage,
} from "@/components/channels/transcript-messages";
import { primaryBot } from "@/lib/agents/primary-bot";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { botAppQueryOptions } from "@/lib/app-access/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { CheckInArrivalContext } from "@/lib/channels/check-in";
import {
  type FirstDayGreeting,
  firstDayGreeting,
} from "@/lib/channels/first-day";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { localDateOf } from "@/lib/channels/morning-brief";
import { client } from "@/lib/client";
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
  const { fetchNextPage, isFetching } = channels;

  // The roster is paged; a person with many other conversations may have this one further back.
  // A socket recovery can replace a page request with a refresh; resume once either finishes.
  useEffect(() => {
    if (bot && searching && !isFetching)
      void fetchNextPage({ cancelRefetch: false });
  }, [bot, searching, isFetching, fetchNextPage]);

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
   * A conversation that has never had a message is still the first day: one made only to hold the
   * Bot's background research, say. The greeting then goes into it rather than into a second
   * conversation.
   */
  if (channel && !started && channel.lastMessageAt === null)
    return <FirstMessage bot={bot} onStarted={setStarted} />;
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
  // A check-in that arrives while the person is elsewhere is worth a notification, unless muted.
  const attention = useQuery(botAttentionQueryOptions());
  const checkInArrived = useCheckInNotifications({
    name: bot.name,
    muted:
      attention.data?.find((row) => row.agentId === bot.id)?.notify === "none",
  });
  const chatBot = useMemo(
    () => ({ id: bot.id, name: bot.name }),
    [bot.id, bot.name],
  );

  /*
   * THE MORNING BRIEF, POSTED BEFORE ANYONE ASKS. The first open of Chat on a day that is not the
   * first asks the server for it; the server claims the day once for this person and Bot, and runs
   * the turn in this conversation, which picks up the reply as it does any turn the server runs.
   *
   * The date is the one Chat opened on, fixed for this mount: opening is what the brief answers,
   * and a screen left open past midnight is not a second opening. Nothing is asked while nothing has
   * been said here, which is the first day: the conversation the first day just started arrives
   * with no message yet, and that day is the greeting's. A failed ask says nothing, because the
   * person asked for nothing, and the claim is given back for the next open to try.
   */
  const me = useQuery(currentUserQueryOptions());
  const [today] = useState(() => localDateOf(new Date()));
  /** The person has typed, or started a turn, since Chat opened. */
  const spoke = useRef(false);
  useMorningBrief({
    claimKey:
      me.isPending || channel.lastMessageAt === null
        ? null
        : `${me.data?.id ?? "unknown"}:${bot.id}:${today}`,
    clear: () => !spoke.current,
    ask: async () => {
      await client<{ claimed: boolean }>(
        "/api/channels/morning-brief",
        "brief",
        {
          method: "POST",
          // No text: the server writes the brief's message itself (`morningBriefMessage`).
          body: { agentId: bot.id, date: today },
          fallback: "Couldn't ask for the morning brief.",
        },
      );
    },
  });

  return (
    <ChatSuggestionProvider bot={chatBot}>
      <CheckInArrivalContext.Provider value={checkInArrived}>
        <PersonWatch into={spoke} />
        <ChannelChat
          channel={channel}
          inShell
          runtimeAgentId={bot.id}
          topic={topic ?? null}
        />
      </CheckInArrivalContext.Provider>
    </ChatSuggestionProvider>
  );
}

/**
 * No conversation yet, or one that has never had a message: the first day. The first message creates
 * the channel, recorded as a choice of this Bot the way picking it anywhere else is, and the chat
 * takes over in place.
 *
 * The Bot speaks first. Chat sends the first-day request itself, framed so the model knows nobody
 * typed it, and the transcript draws the Bot's greeting where it sits. A message the person sends,
 * or starts typing, before the greeting goes wins, and no greeting is sent. Once either starts,
 * Send waits for routing, channel creation and the handoff to the ongoing conversation.
 *
 * WHAT IT ASKS FOR DEPENDS ON WHAT THE BOT CAN READ. The greeting waits for the app-access state of
 * Gmail and Calendar on this Bot, the answer the checklist and the chat card draw. Only `ready` sends
 * the request that reads mail and calendar. Anything else, including a state that could not be read,
 * sends the one that says what it can do now and offers the Connect card, and the plan bubble over
 * it promises no mail (see `firstDayPlan`).
 */
function FirstMessage({
  bot,
  onStarted,
}: {
  bot: AgentProfile;
  onStarted: (channel: AgentChannel) => void;
}) {
  const queryClient = useQueryClient();
  const createChannel = useMutation({
    mutationFn: (input: {
      agentId: string;
      greeting?: FirstDayGreeting;
      date: string;
    }) =>
      client<{ channel: AgentChannel; claimed: boolean }>(
        "/api/channels/first-day",
        "start",
        {
          method: "POST",
          body: input,
          fallback: "Couldn't start the conversation. Try again.",
        },
      ),
  });
  const me = useQuery(currentUserQueryOptions());
  const [sent, setSent] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** Held before the first await, including until the handoff unmounts this composer. */
  const startingRef = useRef(false);
  /** A first message has gone from this screen: the greeting, or the person's own. */
  const begun = useRef(false);
  /** The person has typed into the composer. */
  const typed = useRef(false);

  /**
   * Sends the first message, from the composer or as the greeting, which names which first day it
   * is. The server writes the greeting's message from that alone (`firstDayGreeting`); `text` is
   * the same message, drawn here until the conversation takes over. Throws when it fails.
   */
  const start = async (text: string, greeting?: FirstDayGreeting) => {
    if (startingRef.current)
      throw new Error(
        "The conversation is still starting. Try again in a moment.",
      );
    startingRef.current = true;
    setStarting(true);
    begun.current = true;
    setError(null);
    setSent(seedMessage(text, newId()));
    try {
      await startWithChosen({
        agentId: bot.id,
        text,
        record: routeMessage,
        start: async (agentId, first) => {
          const result = await createChannel.mutateAsync({
            agentId,
            ...(greeting ? { greeting } : {}),
            // The first day takes its own date's morning brief, so none is posted under the
            // greeting when Chat is opened again later today (`morningBrief` on the server).
            date: localDateOf(new Date()),
          });
          const channel = result.channel;
          if (greeting) {
            setSent(null);
            queryClient.setQueryData(channelKeys.detail(channel.id), channel);
            onStarted(channel);
            return;
          }
          queryClient.setQueryData(channelKeys.detail(channel.id), channel);
          stashFirstMessage(channel.id, first);
          onStarted(channel);
        },
      });
    } catch (caught) {
      startingRef.current = false;
      setStarting(false);
      setSent(null);
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't start the conversation. Try again.",
      );
      throw caught;
    }
  };

  const gmail = useQuery(botAppQueryOptions(bot.id, GOOGLE_WORKSPACE));
  const canReadMail = gmail.data?.state === "ready";

  useFirstDayGreeting({
    // Whose first day, with which Bot. Waits for the account and for whether the Bot can read their
    // mail; an account that failed to load still greets, and a state that failed reads as no mail.
    claimKey:
      me.isPending || gmail.isPending
        ? null
        : `${me.data?.id ?? "unknown"}:${bot.id}`,
    clear: () => !begun.current && !typed.current,
    greet: () => {
      const which = canReadMail ? "with_mail" : "without_mail";
      return start(firstDayGreeting(which), which);
    },
  });

  return (
    <>
      <DraftWatch into={typed} />
      <ConversationView
        inShell
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
        pending={starting}
        placeholder={`Message ${bot.name}`}
      />
    </>
  );
}

/** The app the first day reads: Gmail and Google Calendar, one connection for both. */
const GOOGLE_WORKSPACE = "google-workspace";

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
