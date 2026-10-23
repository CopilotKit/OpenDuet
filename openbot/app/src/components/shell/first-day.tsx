import { type RefObject, useEffect, useRef } from "react";
import { useChatDrafting } from "@/components/shell/chat-presence";
import { claimFirstDay } from "@/lib/channels/first-day-claim";

/**
 * What Chat asks for on the person's first day. It goes out wrapped in the first-day frame
 * (`shared/first-day.ts`), which tells the model nobody typed it and the welcome is already on
 * screen, and the transcript draws the Bot's greeting in its place. The `first-day` skill in the
 * tenant package names the mail and calendar tools it needs, and asks for the same shape.
 *
 * THREE PARTS, BECAUSE THE TRANSCRIPT DRAWS THEM AS THREE BUBBLES. Asked only to "tell me what you
 * think I do", the answer came back as one bubble of 1,400 to 1,900 characters with bold labels and
 * three numbered paragraphs, two or three screens at phone width. So the request names the parts,
 * their lengths and the closing sentence, and asks for a blank line between them: the transcript
 * splits the first day's answer at those lines (`firstDayParts` in chat-transcript.tsx).
 *
 * NOTHING HERE ABOUT REPLY BUTTONS. Asking for the answer "before any replies to tap" made the model
 * reach for `suggest_replies` at once and end on the closing question, five runs of five. The frame
 * keeps the model's buttons out of the first day (`NO_BUTTONS`), and the app draws "Sounds right"
 * and "Something's off" under the answer itself.
 */
export const FIRST_DAY_REQUEST = [
  "Get to know me. Look through my recent mail and this week's calendar, then answer in three parts, with a blank line between them.",
  "First, in plain sentences with no bold or headings, say who you think I am and what I do, in at most 450 characters.",
  'Second, write "How I\'ll help:" and then three bullets, one line each and under 60 characters, each tied to something you saw.',
  'Third, end with this sentence on its own: "If any of these sound off, just let me know and I\'ll learn."',
].join(" ");

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
