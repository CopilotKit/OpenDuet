import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { DuetCard } from "@/components/duet/kit";
import {
  proactiveSuggestionsQueryOptions,
  resolveSuggestionMutationOptions,
} from "@/lib/proactive";
import { cn } from "@/lib/utils";
import { SwipeToAnswer } from "./swipe-to-answer";

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

const ChatBotContext = createContext<ChatBot | null>(null);

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
  return (
    <ChatBotContext.Provider value={bot}>{children}</ChatBotContext.Provider>
  );
}

/**
 * The newest step Chat's Bot suggested from its background research, with Start and Hide, just
 * above the composer. Start runs it as a task the person asked for, in the conversation the
 * research belongs to; Hide dismisses it. Both are the same actions Tasks offers, so a suggestion
 * answered here is answered there too. On a touch screen the card also slides off: right to start
 * it, left to hide it. Nothing is drawn outside Chat, or when there is nothing new.
 */
export function ChatSuggestionCard() {
  const bot = useContext(ChatBotContext);
  // Split so that a conversation outside Chat never asks for suggestions at all.
  return bot ? <SuggestionFor bot={bot} /> : null;
}

function SuggestionFor({ bot }: { bot: ChatBot }) {
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
  const suggestion = suggestions.data?.find((item) => item.agentId === bot.id);
  if (!suggestion) return null;
  const busy = act.isPending && act.variables?.id === suggestion.id;
  // One path for the buttons and the drag. `comeBack` puts a card the drag sent off back in place
  // when the answer fails, so the error below is there to read.
  const answer = (action: "start" | "dismiss", comeBack?: () => void) =>
    act.mutate(
      { id: suggestion.id, action },
      {
        onSuccess: () => {
          if (action === "start") setStarted(true);
        },
        onError: () => comeBack?.(),
      },
    );
  return (
    // Keyed so that the next suggestion arrives at rest, not where the last one was sent.
    <SwipeToAnswer
      disabled={busy}
      key={suggestion.id}
      onHide={(comeBack) => answer("dismiss", comeBack)}
      onStart={(comeBack) => answer("start", comeBack)}
    >
      <DuetCard
        aria-label={`${bot.name} could take this on`}
        // Capped so large text never lets the card cover the thread above it: it scrolls inside.
        className="max-h-[30dvh] overflow-y-auto overscroll-contain px-4 py-3"
        glass
        role="region"
      >
        <p className="type-label font-semibold text-duet-violet">
          {bot.name} could take this on
        </p>
        <p className="type-row mt-0.5 line-clamp-3 font-semibold [overflow-wrap:anywhere]">
          {suggestion.title}
        </p>
        {suggestion.detail ? (
          <p className="type-sub line-clamp-2 text-duet-ink-2 [overflow-wrap:anywhere]">
            {suggestion.detail}
          </p>
        ) : null}
        {suggestion.sourceApp ? (
          <p className="type-label mt-0.5 text-duet-ink-3">
            From {suggestion.sourceApp}
          </p>
        ) : null}
        {act.error && act.variables?.id === suggestion.id ? (
          <p className="type-label mt-1 text-duet-red" role="alert">
            {act.error.message}
          </p>
        ) : null}
        <div className="mt-2.5 flex gap-2">
          <SmallPill disabled={busy} onClick={() => answer("dismiss")}>
            Hide
          </SmallPill>
          <SmallPill disabled={busy} onClick={() => answer("start")} primary>
            Start
          </SmallPill>
        </div>
      </DuetCard>
    </SwipeToAnswer>
  );
}

function SmallPill({
  primary = false,
  ...props
}: ComponentProps<"button"> & { primary?: boolean }) {
  return (
    <button
      className={cn(
        "type-label h-9 flex-1 rounded-full font-semibold transition-[filter,transform,opacity] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-[0.98] disabled:opacity-50",
        primary
          ? "bg-duet-black text-duet-on-black hover:brightness-125"
          : "text-duet-ink shadow-[inset_0_0_0_1px_var(--duet-hair)] hover:bg-duet-tile",
      )}
      type="button"
      {...props}
    />
  );
}
