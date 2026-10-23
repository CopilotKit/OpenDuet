/**
 * The sentences that tell the Bot a turn is the hello in a channel the person just made, declared
 * once and read from both sides.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `routine-firing.ts` gives. Creating a channel
 * starts this turn in its new conversation (server/src/openduet/channels.ts), so the framed text
 * lands in the transcript as a `user` message nobody typed. Two readers have to recognise it again:
 * the transcript, to draw nothing where the person's bubble would be, since the Bot speaks first,
 * and the titler, to name the conversation from the channel rather than from the frame.
 *
 * The channel rides under the frame as JSON, as a check-in's suggestions do: the model reads it well,
 * and a name or purpose with a newline or a quote in it cannot break a hand-rolled line.
 */

/** The question the hello ends on, and the replies offered under it. */
export const CHANNEL_HELLO_QUESTION = "Want me to suggest tasks I can do here?";
export const CHANNEL_HELLO_REPLIES = ["Yes", "No", "Not now"] as const;

/** What the Bot says before it lists what it could start on, and the question after the list. */
export const CHANNEL_HELLO_OFFER = "Here are three things I could start on:";
export const CHANNEL_HELLO_PICK = "Which of these do you want first?";

export const CHANNEL_HELLO_FRAME = [
  "This is a new channel the person just made, and this is its first turn. Nobody has written yet: the app opened it for them, and you speak first.",
  `First call suggest_replies once, with ${CHANNEL_HELLO_REPLIES.map((reply) => `"${reply}"`).join(", ")}. Then, in one short message in the first person, say hello in a line that shows you read what the channel below is for, without repeating its purpose word for word, and ask "${CHANNEL_HELLO_QUESTION}" Write nothing else, and do nothing else this turn.`,
  `If they answer Yes, choose three things you could start on, each drawn from this channel's purpose or from what you can read in their apps, never a generic idea. First call suggest_replies once, with a label of one to three words for each. Then write "${CHANNEL_HELLO_OFFER}", three short bullets, and "${CHANNEL_HELLO_PICK}", in one message, and nothing after it. If nothing you can read would ground three things, say in one line what you would need connected instead, with no buttons. When they pick one, start it with start_task and reply only "On it." If they answer No, say that is fine in one short line, offer no buttons, and do not offer tasks again in this channel. If they answer Not now, say that is fine in a few words.`,
] as const;

/** The frame and the blank line under it, which is what `readChannelHello` strips. */
const PREFIX = [...CHANNEL_HELLO_FRAME, "", ""].join("\n");

export type ChannelHello = { name: string; purpose: string };

/** The hello's message: the frame, then the channel, as JSON. */
export function frameChannelHello(channel: ChannelHello): string {
  const body = JSON.stringify(
    { channel: channel.name, purpose: channel.purpose },
    null,
    2,
  );
  return [...CHANNEL_HELLO_FRAME, "", body].join("\n");
}

/**
 * The channel a framed message names, or null if this was not a channel's hello.
 *
 * Null means "not a hello" and nothing else, the contract `readFiring` keeps: the transcript falls
 * through to drawing the text as the person's own message, and the titler to the raw text. A frame
 * whose body cannot be read is still a hello, so it comes back with empty fields rather than null.
 *
 * A prefix match on the whole frame, not on its first sentence, so a person quoting one of the lines
 * back still sees their own message drawn as theirs.
 */
export function readChannelHello(text: string): ChannelHello | null {
  if (!text.startsWith(PREFIX)) return null;
  let body: unknown;
  try {
    body = JSON.parse(text.slice(PREFIX.length));
  } catch {
    return { name: "", purpose: "" };
  }
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    name: typeof record.channel === "string" ? record.channel : "",
    purpose: typeof record.purpose === "string" ? record.purpose : "",
  };
}

/** A hello in one line, for a reader that names the conversation from its opening. */
export function describeChannelHello(hello: ChannelHello): string {
  return hello.name ? `New channel: ${hello.name}` : "New channel";
}
