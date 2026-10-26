import { type RefObject, useEffect, useRef } from "react";
import {
  useChatDrafting,
  useChatWorking,
} from "@/components/shell/chat-presence";
import { claimMorningBrief } from "@/lib/channels/morning-brief-claim";

/**
 * What Chat asks for the first time it opens on a day that is not the first. It goes out wrapped in
 * the morning-brief frame (`shared/morning-brief.ts`), which tells the model nobody typed it, to call
 * `morning_brief`, and to say at most one sentence after it; the transcript draws nothing where it
 * sits, so the Bot's reply and the brief's card are what the person finds.
 *
 * Plain, because the frame says everything about how to answer. The brief itself is the tool's,
 * sorted on the server the way evals/triage measures, and the card is the app's.
 */
export const MORNING_BRIEF_REQUEST = "Give me my morning brief.";

/**
 * On a day that is not the first, the Bot speaks first: Chat opened on the person's ongoing
 * conversation asks the server for the day's brief, once, instead of waiting to be asked.
 *
 * The same shape as `useFirstDayGreeting`, and for the same reasons. `claimKey` names whose brief,
 * with which Bot, on which local date; null while that is not known yet, or while it is not a day
 * for one, which waits. `clear` is read at the last moment, after the claim is held and in the same
 * tick as the ask, so a message the person sent or started typing in the meantime wins and nothing
 * goes. `ask` posts it to the server, which claims the day and runs the turn; when it throws, the
 * claim is given back and a later open of Chat asks again.
 */
export function useMorningBrief({
  claimKey,
  clear,
  ask,
}: {
  claimKey: string | null;
  clear: () => boolean;
  ask: () => Promise<void>;
}) {
  const latest = useRef({ clear, ask });
  latest.current = { clear, ask };

  useEffect(() => {
    if (claimKey === null) return;
    // No cancellation on cleanup, for the reason `useFirstDayGreeting` gives: StrictMode.
    claimMorningBrief(claimKey, async () => {
      if (!latest.current.clear()) return false;
      await latest.current.ask();
      return true;
    }).catch(() => {});
  }, [claimKey]);
}

/**
 * Keeps `into` true once the person has typed into Chat's composer or started a turn of their own.
 *
 * `DraftWatch` (first-day.tsx) watches typing alone, because on the first day the screen itself
 * knows when a message went. Here the composer and its sends belong to the conversation, so a turn
 * running on this screen is read as the person having spoken: a typed message, a reply chip, a
 * Start on a card. A leaf that draws nothing, for the reason `DraftWatch` gives, and it latches the
 * same way.
 */
export function PersonWatch({ into }: { into: RefObject<boolean> }) {
  const drafting = useChatDrafting();
  const working = useChatWorking();
  useEffect(() => {
    if (drafting || working) into.current = true;
  }, [drafting, working, into]);
  return null;
}
