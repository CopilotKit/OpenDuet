import type { Message } from "@ag-ui/core";
import { readFirstDay } from "./first-day";

/**
 * The rules a conversation's turns live by, as plain functions: when a send met a turn already
 * going, which waits the browser may forget, what a person may be told, and which seeds have gone.
 *
 * `channel-chat.tsx` is where they are applied. They live here so each one can be proven without a
 * runtime, a socket and a model between the test and the rule.
 */

/**
 * The words a send could not run yet, because the conversation already had a turn going.
 *
 * Thrown so a caller can tell "not yet" from "failed". The queue in `conversation-view.tsx` parks
 * the words as Queued and runs them when that turn ends; nothing restores them to the composer,
 * which would draw the same words twice. Its message is the sentence the parity spec gives for this,
 * so a caller that only shows `error.message` still says the right thing.
 */
export class ThreadBusyError extends Error {
  constructor() {
    super("OpenDuet is still finishing something. I'll send this next.");
    this.name = "ThreadBusyError";
  }
}

export function isThreadBusyError(error: unknown): error is ThreadBusyError {
  return error instanceof Error && error.name === "ThreadBusyError";
}

/**
 * Whether a failed run failed only because another run holds the thread.
 *
 * Three spellings of one refusal. The realtime runtime throws `AgentThreadLockedError` ("Thread
 * <uuid> is locked") on the server's 409; the plain HTTP transport throws an `Error` carrying
 * `status: 409`; and the server's own body says "Thread lock denied". None of them is a failure the
 * person should read: the turn they wanted is waiting behind one that is already going.
 */
export function isThreadLocked(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AgentThreadLockedError") return true;
  if ((error as { status?: unknown }).status === 409) return true;
  return /thread lock denied|\bthread\b.*\bis locked\b/i.test(error.message);
}

type InterruptLike = { id: string; metadata?: unknown };

/**
 * A wait this deployment answers itself: an approval the person decides in its card or on Tasks.
 *
 * The runtime ends a turn that needs approval with an interrupt carrying `openbotWaiting`. The
 * browser never answers it with `resume`: the decision goes to the approvals inbox, and the server
 * carries out the action and continues the conversation on its own. The SDK does not know that. It
 * keeps the interrupt and refuses every later run until one answers it, before any request is made.
 * That refusal never reached `onRunFailed`, so the composer cleared, the bubble stayed, and the
 * message was never sent: the lost message after Allow once.
 */
export function isAnsweredByInbox(interrupt: InterruptLike): boolean {
  const metadata = interrupt.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "openbotWaiting" in metadata
  );
}

/**
 * The interrupts the browser still has to answer, with the inbox's own waits taken out.
 *
 * The same array when there was nothing to take out, so a caller can skip the write.
 */
export function interruptsToAnswer<T extends InterruptLike>(
  interrupts: readonly T[],
): readonly T[] {
  const kept = interrupts.filter((interrupt) => !isAnsweredByInbox(interrupt));
  return kept.length === interrupts.length ? interrupts : kept;
}

/**
 * The messages with `ids` taken out, or the same array when none of them was there.
 *
 * For a turn that never reached the server: what it added locally was never stored, and leaving it
 * drawn says it was sent.
 */
export function withoutMessages<T extends { id: string }>(
  messages: readonly T[],
  ids: ReadonlySet<string>,
): readonly T[] {
  if (!messages.some((message) => ids.has(message.id))) return messages;
  return messages.filter((message) => !ids.has(message.id));
}

/** The text of a user turn, or null for anything else. */
function userText(message: Message): string | null {
  if (message.role !== "user") return null;
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** Whether this thread has already been asked for its first day, by this device or another. */
export function firstDayAsked(messages: readonly Message[]): boolean {
  return messages.some((message) => {
    const text = userText(message);
    return text !== null && readFirstDay(text) !== null;
  });
}

/**
 * Whether a seed that met a busy thread should still be sent once that turn is over.
 *
 * A person's own first message always is: it is theirs, and it was not sent. The first-day request
 * is not when the thread already holds one: the turn it waited behind was the greeting, started by
 * another device or tab on the same first day, and sending it again is the second welcome.
 */
export function seedStillNeeded(
  text: string,
  messages: readonly Message[],
): boolean {
  return readFirstDay(text) === null || !firstDayAsked(messages);
}

/**
 * The channels whose creating message this page has sent, so it goes once.
 *
 * Module-level, the way `heldHere` is in `first-day-claim.ts`, because what it guards against is the
 * component itself: StrictMode running the send-on-mount effect twice, and the screen remounting the
 * conversation before the roster has caught up. A ref dies with the instance; this does not.
 * `takeFirstMessage` is destructive too, but it guards one stash, and a greeting started twice
 * stashes twice.
 */
const seededHere = new Set<string>();

/** Claim the channel's creating message. True only for the first claim in this page. */
export function claimSeed(channelId: string): boolean {
  if (seededHere.has(channelId)) return false;
  seededHere.add(channelId);
  return true;
}

/** For tests: forget every claim. */
export function forgetSeedClaims(): void {
  seededHere.clear();
}

/**
 * The sentence to show for a turn that ended badly, never a raw error.
 *
 * Most reasons are written for people: the stall guard's sentence, a Bot's refusal. Some are not: a
 * transport error with a status line and a JSON body, or the SDK naming a thread or a tool call by
 * id. Those say nothing a person can act on and leak ids, so they become one plain sentence.
 */
export function sayableReason(reason: string): string {
  const raw =
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(
      reason,
    ) ||
    /^(HTTP \d{3}|REST \w+ request failed|AGUIError|AgentThreadLockedError)/.test(
      reason,
    ) ||
    /pending interrupt|toolu_|\bThread\b.*\bis locked\b/i.test(reason);
  return raw ? "Couldn't reach the Bot. Try again." : reason;
}
