import { type RefObject, useEffect, useRef } from "react";
import { useChatDrafting } from "@/components/shell/chat-presence";
import { claimFirstDay } from "@/lib/channels/first-day-claim";

/**
 * What Chat asks for on the person's first day, declared in `shared/first-day.ts` (with why it reads
 * as it does) because the server builds the message from it and the browser only says which.
 */
export { FIRST_DAY_REQUEST } from "@openbot/shared/first-day";

/** The sentence the first day's answer ends on, as the request asks for it. */
export const FIRST_DAY_CLOSE =
  "If any of these sound off, just let me know and I'll learn.";

/**
 * On the first day the Bot speaks first: Chat opened on nothing sends the greeting itself, once,
 * instead of waiting for the person to press anything.
 *
 * `claimKey` names whose first day it is, with which Bot; null while that is not known yet, which
 * waits. `clear` is read at the last moment, after the claim is held and in the same tick as the
 * send, so a message the person sent or started typing in the meantime wins and nothing goes.
 * `greet` sends it through the same start the composer uses; when it throws, the screen has
 * already said what went wrong, so the throw stops here.
 */
export function useFirstDayGreeting({
  claimKey,
  clear,
  greet,
}: {
  claimKey: string | null;
  clear: () => boolean;
  greet: () => Promise<void>;
}) {
  const latest = useRef({ clear, greet });
  latest.current = { clear, greet };

  useEffect(() => {
    if (claimKey === null) return;
    /*
     * No cancellation on cleanup, on purpose. StrictMode runs this, cleans it up and runs it again
     * on the same component; the claim turns the second run away, so a first run that cancelled
     * itself would leave nothing sent at all.
     */
    claimFirstDay(claimKey, async () => {
      if (!latest.current.clear()) return false;
      await latest.current.greet();
      return true;
    }).catch(() => {});
  }, [claimKey]);
}

/**
 * Keeps `into` true once the person has typed into Chat's composer.
 *
 * A leaf that draws nothing, because the draft it reads changes on every keystroke and only this
 * should re-render for it. It latches: somebody who typed and cleared the box has still started
 * the conversation themselves.
 */
export function DraftWatch({ into }: { into: RefObject<boolean> }) {
  const drafting = useChatDrafting();
  useEffect(() => {
    if (drafting) into.current = true;
  }, [drafting, into]);
  return null;
}
