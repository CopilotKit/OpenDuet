import { createContext, useContext } from "react";

/*
 * Whether a card at the end of the turn should wait for the Bot's words to finish.
 *
 * A page is made before the line about it is written, so drawn the moment the tool answered, the
 * card landed first and the words streamed in above it, pushing it down as they grew. The
 * transcript says, per row, that its turn is still being written; a card that reads this keeps its
 * place with a quiet line until the turn ends, then enters.
 */
const ReplyHold = createContext(false);

export const ReplyHoldProvider = ReplyHold.Provider;

/** True while this row's turn is still being written. False outside a transcript. */
export function useReplyHold(): boolean {
  return useContext(ReplyHold);
}
