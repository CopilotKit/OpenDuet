/**
 * Why a conversation's last turn failed, kept in this tab so a reload still says it.
 *
 * The sentence under a failed turn was React state, so a reload dropped it, and the person was left
 * looking at their own message with nothing under it, as if the Bot were still thinking or had
 * ignored them. It is now written here when the turn fails and read back when the conversation is
 * drawn again.
 *
 * ONLY WHILE IT IS STILL TRUE. The note is kept with the id of the last message on screen when the
 * turn failed, and it is shown again only while that is still the conversation's last message. A
 * reply that arrived since, from this tab or another device, or a new message sent, makes it old
 * news, and it is not shown. A new turn forgets it.
 *
 * SESSION STORAGE, AND ONLY THE SENTENCE ALREADY SHOWN. It is per tab and gone when the tab closes,
 * and what is kept is the plain line `sayableReason` produced, never the raw error. Storage that
 * refuses (a private window, a full quota) just means no note after a reload, never a failure.
 */

const KEY_PREFIX = "openduet.run-error.";

type Kept = { said: string; after: string | null };

/** Keep the sentence for this conversation, with the last message it was about. */
export function rememberRunError(
  channelId: string,
  said: string,
  after: string | null,
): void {
  try {
    window.sessionStorage.setItem(
      KEY_PREFIX + channelId,
      JSON.stringify({ said, after } satisfies Kept),
    );
  } catch {
    // Refused storage: the note still shows until a reload, it just isn't kept past one.
  }
}

/** Forget it, because a new turn has started. */
export function forgetRunError(channelId: string): void {
  try {
    window.sessionStorage.removeItem(KEY_PREFIX + channelId);
  } catch {
    // Nothing kept, so nothing to forget.
  }
}

/** The kept sentence, if the conversation's last message is still the one it was about. */
export function recalledRunError(
  channelId: string,
  lastMessageId: string | null,
): string | null {
  let kept: unknown;
  try {
    const raw = window.sessionStorage.getItem(KEY_PREFIX + channelId);
    if (!raw) return null;
    kept = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !kept ||
    typeof kept !== "object" ||
    typeof (kept as Kept).said !== "string" ||
    (kept as Kept).said === ""
  ) {
    return null;
  }
  const { said, after } = kept as Kept;
  return after === lastMessageId ? said : null;
}
