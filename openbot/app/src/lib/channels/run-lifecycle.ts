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

type InterruptLike = { id: string; toolCallId?: string; metadata?: unknown };

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

/** The tool calls the inbox's waits hold: an approval interrupt names its call, or is keyed by it. */
export function waitingToolCalls(
  interrupts: readonly InterruptLike[],
): Set<string> {
  return new Set(
    interrupts
      .filter(isAnsweredByInbox)
      .map((interrupt) => interrupt.toolCallId ?? interrupt.id),
  );
}

/**
 * What a call still waiting in an approval card is said to have returned, for the model's history.
 *
 * Written for the model, not for a person. A call with no result cannot be sent to a provider, and
 * the generic repair (`repairUnansweredToolCalls`) answers it with "the surface was interrupted …
 * Do not assume it succeeded". For a card still waiting that is false: the action has not run, and
 * Allow once can still run it. Told it was interrupted, the Bot said the email was not sent, and
 * once drafted a second card for the same email, one tap from sending it twice.
 */
export const APPROVAL_WAITING_RESULT =
  "Waiting for the person's approval in the card; it has not run. Don't retry it or report it as sent or failed.";

/**
 * What that placeholder becomes once the card has been decided and the action's own result is not
 * in this tab's history: true without inventing an outcome, since the server's continuation says
 * what happened in the messages after it.
 */
export const APPROVAL_DECIDED_RESULT =
  "The person has decided in the card. What happened is in the messages after this.";

type ToolResultLike = {
  id: string;
  role: string;
  toolCallId?: string;
  content?: unknown;
};

/** Whether a tool result is the placeholder for a card still waiting, not the action's result. */
export function isApprovalWaitingResult(message: ToolResultLike): boolean {
  return message.role === "tool" && message.content === APPROVAL_WAITING_RESULT;
}

type CallLike = {
  id: string;
  role: string;
  toolCallId?: string;
  content?: unknown;
  toolCalls?: readonly { id: string }[];
};

/**
 * Whether the history holds a placeholder for a card that has since been decided, with no real
 * result for it yet: the case worth reading the store for before sending.
 */
export function staleApprovalWaits(
  messages: readonly ToolResultLike[],
  waiting: ReadonlySet<string>,
): boolean {
  const real = new Set(
    messages
      .filter(
        (message) =>
          message.role === "tool" &&
          message.toolCallId !== undefined &&
          !isApprovalWaitingResult(message),
      )
      .map((message) => message.toolCallId),
  );
  return messages.some(
    (message) =>
      isApprovalWaitingResult(message) &&
      message.toolCallId !== undefined &&
      !waiting.has(message.toolCallId) &&
      !real.has(message.toolCallId),
  );
}

/**
 * The history to send, with every call still waiting in a card answered by the placeholder above,
 * right after the message that made it, and every placeholder whose real result has since arrived
 * replaced by that result, in the placeholder's place. A placeholder whose card has been decided
 * and whose result is still not here says so instead ({@link APPROVAL_DECIDED_RESULT}).
 *
 * In place, because a provider matches a result to the call directly above it: a result that
 * arrived later, after other turns, is moved up rather than left where it would answer nothing.
 * The same array when nothing changed.
 */
export function withApprovalWaits<T extends CallLike>(
  messages: readonly T[],
  waiting: ReadonlySet<string>,
  mintId: () => string,
): readonly T[] {
  const real = new Map<string, T>();
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || message.toolCallId === undefined) continue;
    answered.add(message.toolCallId);
    if (!isApprovalWaitingResult(message))
      real.set(message.toolCallId, message);
  }
  const placeholders = messages.filter(
    (message) =>
      isApprovalWaitingResult(message) &&
      message.toolCallId !== undefined &&
      real.has(message.toolCallId),
  );
  const decided = messages.filter(
    (message) =>
      isApprovalWaitingResult(message) &&
      message.toolCallId !== undefined &&
      !real.has(message.toolCallId) &&
      !waiting.has(message.toolCallId),
  );
  const toAdd = messages.some(
    (message) =>
      message.role === "assistant" &&
      (message.toolCalls ?? []).some(
        (call) => waiting.has(call.id) && !answered.has(call.id),
      ),
  );
  if (!toAdd && placeholders.length === 0 && decided.length === 0)
    return messages;

  const moved = new Set(
    placeholders.map((placeholder) => real.get(placeholder.toolCallId ?? "")),
  );
  const result: T[] = [];
  for (const message of messages) {
    if (moved.has(message)) continue;
    if (
      isApprovalWaitingResult(message) &&
      message.toolCallId !== undefined &&
      real.has(message.toolCallId)
    ) {
      result.push(real.get(message.toolCallId) as T);
      continue;
    }
    if (decided.includes(message)) {
      result.push({ ...message, content: APPROVAL_DECIDED_RESULT });
      continue;
    }
    result.push(message);
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (!waiting.has(call.id) || answered.has(call.id)) continue;
      answered.add(call.id);
      result.push({
        id: mintId(),
        role: "tool",
        toolCallId: call.id,
        content: APPROVAL_WAITING_RESULT,
      } as unknown as T);
    }
  }
  return result;
}

/**
 * The messages with every tool call that has no result taken out, for drawing a transcript that is
 * only standing in: an assistant message left with no calls and no words goes too. The same array
 * when every call is answered.
 */
export function withoutUnansweredCalls<T extends CallLike>(
  messages: readonly T[],
): readonly T[] {
  const answered = new Set(
    messages
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId),
  );
  const unanswered = (message: T) =>
    message.role === "assistant" &&
    (message.toolCalls ?? []).some((call) => !answered.has(call.id));
  if (!messages.some(unanswered)) return messages;
  return messages.flatMap((message) => {
    if (!unanswered(message)) return [message];
    const toolCalls = (message.toolCalls ?? []).filter((call) =>
      answered.has(call.id),
    );
    const words =
      typeof message.content === "string"
        ? message.content.trim() !== ""
        : Array.isArray(message.content) && message.content.length > 0;
    if (toolCalls.length === 0 && !words) return [];
    return [{ ...message, toolCalls }];
  });
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
 * The plain sentences for a model or a network that failed, checked in this order because one raw
 * message can carry more than one signature: the AI SDK's retry wrapper ("Failed after 3 attempts.
 * Last error: Overloaded") names the attempts and then the cause, and the cause is what to say.
 */
const MODEL_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /rate.?limit|too many requests|\boverloaded\b|\b(429|529)\b/i,
    "The AI model is busy right now. Try again in a minute.",
  ],
  [
    /invalid x-api-key|incorrect api key|invalid_api_key|authentication_error|api key (is )?(invalid|not valid)/i,
    "The AI model didn't accept this install's key. An admin needs to update it.",
  ],
  [
    /\b(operation|request) (has )?timed out\b|\bETIMEDOUT\b|aborted due to timeout/i,
    "That took too long, so it was stopped. Try again.",
  ],
  [
    /Failed after \d+ attempts|Cannot connect to API/i,
    "Couldn't reach the AI model. Check your internet connection, then try again.",
  ],
];

/**
 * The sentence to show for a turn that ended badly, never a raw error.
 *
 * Most reasons are written for people: the stall guard's sentence, a Bot's refusal. Some are not: a
 * transport error with a status line and a JSON body, or the SDK naming a thread or a tool call by
 * id. Those say nothing a person can act on and leak ids, so they become one plain sentence.
 *
 * A MODEL THAT FAILED IS SAID AS ONE, IN THE PERSON'S TERMS. The AI SDK's own text reached the
 * screen as it was: "Failed after 3 attempts. Last error: Unable to connect. Is the computer able to
 * access the url?" ("the computer" is Bun's, and in this product it means a Bot's computer, which had
 * nothing to do with it), and "The operation timed out." Each is now matched by its signature and
 * becomes a line that says what happened and what to do (`MODEL_FAILURES`). A bare connection error
 * with no model signature is the Bot's own endpoint, and says so.
 */
export function sayableReason(reason: string): string {
  for (const [signature, sentence] of MODEL_FAILURES) {
    if (signature.test(reason)) return sentence;
  }
  const raw =
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(
      reason,
    ) ||
    /^(HTTP \d{3}|REST \w+ request failed|AGUIError|AgentThreadLockedError)/.test(
      reason,
    ) ||
    /pending interrupt|toolu_|\bThread\b.*\bis locked\b/i.test(reason) ||
    /^(TypeError: )?(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|network error)$/i.test(
      reason,
    ) ||
    /Is the computer able to access the url|\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN)\b|socket hang up|^fetch failed$/i.test(
      reason,
    );
  return raw ? "Couldn't reach the Bot. Try again." : reason;
}
