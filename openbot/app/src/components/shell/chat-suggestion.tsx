import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  proactiveSuggestionsQueryOptions,
  resolveSuggestionMutationOptions,
} from "@/lib/proactive";
import { cn } from "@/lib/utils";
import { SuggestionCard } from "./suggestion-card";

/** How long "Started" stays above the composer, or Tasks' tab bar, before it goes. */
export const STARTED_MS = 4000;

/**
 * "Started. <Bot> is on it.", said for a moment after a suggestion is started. A pill of the dock's
 * glass, like the status under the header's orb, so it reads over whatever scrolls under it. Chat
 * shows it above the composer and Tasks above the tab bar: where the eye already is, never at the
 * foot of a list.
 */
export function StartedLine({
  botName,
  className,
}: {
  botName: string;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "duet-glass flex min-h-7 w-fit max-w-full items-center rounded-full px-3 py-1 font-semibold text-[13px] text-duet-green leading-4 shadow-duet-glass",
        className,
      )}
      role="status"
    >
      Started. {botName} is on it.
    </p>
  );
}

type ChatBot = { id: string; name: string };

type ChatSuggestions = {
  bot: ChatBot;
  /** Suggestions a check-in already put in the thread as cards, so the dock does not draw them twice. */
  inThread: ReadonlySet<string>;
  /** A card in the thread says which suggestion it shows; the returned function takes it back. */
  showInThread: (id: string) => () => void;
};

const ChatSuggestionsContext = createContext<ChatSuggestions | null>(null);

/**
 * Chat's Bot, for the card above its composer. Only Chat provides it: a suggestion is that Bot's
 * own next step for its person, and any other conversation is about something else.
 */
export function ChatSuggestionProvider({
  bot,
  children,
}: {
  bot: ChatBot;
  children: ReactNode;
}) {
  const [inThread, setInThread] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const showInThread = useCallback((id: string) => {
    setInThread((shown) => new Set(shown).add(id));
    return () =>
      setInThread((shown) => {
        const next = new Set(shown);
        next.delete(id);
        return next;
      });
  }, []);
  const value = useMemo(
    () => ({ bot, inThread, showInThread }),
    [bot, inThread, showInThread],
  );
  return (
    <ChatSuggestionsContext.Provider value={value}>
      {children}
    </ChatSuggestionsContext.Provider>
  );
}

/** Chat's Bot, or null in any other conversation. */
export function useChatBot(): ChatBot | null {
  return useContext(ChatSuggestionsContext)?.bot ?? null;
}

/**
 * Say, for as long as it is drawn, that a card in the thread shows this suggestion, so the card
 * above the composer moves on to another. Does nothing outside Chat.
 */
export function useShownInThread(id: string) {
  const showInThread = useContext(ChatSuggestionsContext)?.showInThread;
  useEffect(() => showInThread?.(id), [showInThread, id]);
}

/**
 * The newest step Chat's Bot suggested from its background research, with Start and Hide, just
 * above the composer. Start runs it as a task the person asked for, in the conversation the
 * research belongs to; Hide dismisses it. Both are the same actions Tasks offers, so a suggestion
 * answered here is answered there too. On a touch screen the card also slides off: right to start
 * it, left to hide it. Nothing is drawn outside Chat, or when there is nothing new, or for a
 * suggestion a check-in already put in the thread above.
 */
export function ChatSuggestionCard() {
  const chat = useContext(ChatSuggestionsContext);
  // Split so that a conversation outside Chat never asks for suggestions at all.
  return chat ? (
    <SuggestionFor bot={chat.bot} inThread={chat.inThread} />
  ) : null;
}

function SuggestionFor({
  bot,
  inThread,
}: {
  bot: ChatBot;
  inThread: ReadonlySet<string>;
}) {
  const queryClient = useQueryClient();
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const act = useMutation(resolveSuggestionMutationOptions(queryClient));
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!started) return;
    const timer = setTimeout(() => setStarted(false), STARTED_MS);
    return () => clearTimeout(timer);
  }, [started]);

  if (started) return <StartedLine botName={bot.name} className="mb-2.5" />;
  const suggestion = suggestions.data?.find(
    (item) => item.agentId === bot.id && !inThread.has(item.id),
  );
  if (!suggestion) return null;
  const mine = act.variables?.id === suggestion.id;
  return (
    // Keyed so that the next suggestion arrives at rest, not where the last one was sent.
    <SuggestionCard
      busy={act.isPending && mine}
      error={act.error && mine ? act.error.message : null}
      glass
      heading={`${bot.name} could take this on`}
      key={suggestion.id}
      onAnswer={(action, comeBack) =>
        act.mutate(
          { id: suggestion.id, action },
          {
            onSuccess: () => {
              if (action === "start") setStarted(true);
            },
            onError: () => comeBack?.(),
          },
        )
      }
      suggestion={suggestion}
    />
  );
}
