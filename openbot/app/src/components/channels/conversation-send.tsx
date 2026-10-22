import type { Message } from "@ag-ui/core";
import { createContext, useContext } from "react";

/**
 * Something inside a conversation answering for the person: a reply chip under a Bot's question, a
 * Start button on a card. Provided by `ConversationView`, which owns the composer's submit, so a
 * tap goes out exactly as typed words would: sent now when the conversation is free, parked behind
 * the turn in flight where the conversation queues, and in the same order as everything else.
 */
export type ConversationSend = {
  /**
   * Send `text` as the person's own message. Returns whether it went or was parked; false when the
   * conversation can't take a message now (it is read-only, or busy and does not queue). A failed
   * turn is reported by the conversation's own notice, as one typed in the composer is.
   */
  send: (text: string) => boolean;
  /**
   * Whether a tool call belongs to the Bot's latest turn: nothing the person sent or parked comes
   * after it. A control drawn in an earlier turn answers a question nobody is asking any more.
   */
  isLatestTurn: (toolCallId: string) => boolean;
};

export const ConversationSendContext = createContext<ConversationSend | null>(
  null,
);

/**
 * The conversation this is drawn in, or null outside one. Null is an answer, not an error: a card
 * drawn where there is nowhere to send, such as CopilotKit's own chat, draws nothing to press.
 */
export function useConversationSend(): ConversationSend | null {
  return useContext(ConversationSendContext);
}

/**
 * The tool calls the Bot has made since the person last spoke, read back from the end of the
 * conversation. A routine firing arrives as `role: "user"` and ends a turn too, which is right: the
 * Bot's next answer is to the firing, not to whatever it asked before.
 */
export function latestTurnToolCalls(messages: readonly Message[]): string[] {
  const ids: string[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role === "user") break;
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? []) ids.push(call.id);
  }
  return ids;
}
