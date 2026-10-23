import { type HistoryState, useRouter } from "@tanstack/react-router";
import { type RefObject, useEffect } from "react";

/**
 * Opening a conversation at one message, not at its end.
 *
 * Tasks lists each started task's results, and several started tasks share one conversation, so a
 * link to the conversation alone lands every one of them on the newest reply. The link carries the
 * message to open at in the router's history state: not a search parameter, so the conversation's
 * own URL is unchanged, and Back and Forward land on the same message again.
 *
 * The id is the one the transcript already renders as `data-message-id`. A started task's own
 * message, the person bubble Start posts, has the id `suggestion-<suggestion id>`.
 */
const KEY = "focusMessage";

/**
 * For a `Link`'s `state`: open the conversation at this message. The router declares its history
 * state as an empty interface, and widening it means augmenting `@tanstack/history`, which this app
 * does not depend on, so the one value is cast here and read back by `useFocusMessage` alone.
 */
export function focusMessageState(messageId: string): HistoryState {
  return { [KEY]: messageId } as HistoryState;
}

/** The message id a started task's turn posted its request under. */
export const startedTaskMessageId = (suggestionId: string) =>
  `suggestion-${suggestionId}`;

/** How long to keep the message in view while the transcript fills in and settles, in ms. */
const SETTLE_MS = 2_000;
const STEP_MS = 120;

/**
 * Scroll the conversation under `root` to the message the navigation asked for, once it renders.
 *
 * The transcript arrives over a replay and its scroller follows the bottom as it grows, so one
 * scroll on mount is undone a moment later. This puts the message at the top each time it moves
 * away while the transcript settles, then stops. It stops at once when the person scrolls, taps or
 * types, so it never fights them.
 */
export function useFocusMessage(root: RefObject<HTMLElement | null>) {
  // Read from the router when there is one. A conversation drawn on its own, outside the app's
  // routes, has no navigation to read and opens where it always did.
  const router = useRouter({ warn: false }) as {
    state: { location: { state: unknown } };
  } | null;
  const value = (
    router?.state.location.state as Record<string, unknown> | undefined
  )?.[KEY];
  const target = typeof value === "string" ? value : null;
  useEffect(() => {
    const frame = root.current;
    if (!target || !frame) return;
    let foundAt: number | null = null;
    const startedAt = Date.now();
    const stop = () => window.clearInterval(timer);
    const timer = window.setInterval(() => {
      const message = frame.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(target)}"]`,
      );
      if (message) {
        foundAt ??= Date.now();
        const top = message.getBoundingClientRect().top;
        const area = frame.getBoundingClientRect().top;
        if (Math.abs(top - area) > 140)
          message.scrollIntoView({ block: "start" });
      }
      const now = Date.now();
      if (
        (foundAt !== null && now - foundAt > SETTLE_MS) ||
        now - startedAt > SETTLE_MS * 4
      )
        stop();
    }, STEP_MS);
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const name of events)
      frame.addEventListener(name, stop, { once: true, passive: true });
    return () => {
      stop();
      for (const name of events) frame.removeEventListener(name, stop);
    };
  }, [target, root]);
}
