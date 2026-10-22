/**
 * The sentences that tell the Bot a turn is its first day with the person, declared once and read
 * from both sides.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `routine-firing.ts` gives. Chat sends this
 * text as the first message of a person's first conversation, so it lands in the transcript, and two
 * readers have to recognise it again: the transcript, to draw the Bot's greeting where the person's
 * bubble would be, and the titler, to name the conversation from the request rather than from the
 * frame. Two copies of a sentence is a contract with two authors, and the first rewording breaks the
 * renderer silently.
 */
export const FIRST_DAY_FRAME = [
  "This is your first conversation with this person: they have just opened the app for the first time and have not written anything yet, so the request below was sent for them.",
  "The app has already welcomed them in your voice and said you are reading their mail and calendar, so do not greet them or introduce yourself again: carry out the request in this turn and open with what you found.",
] as const;

/** The frame and the blank line under it, which is what `readFirstDay` strips. */
const PREFIX = [...FIRST_DAY_FRAME, "", ""].join("\n");

/**
 * The request, wrapped in the sentences that tell the turn it is the first one.
 *
 * Chat starts the first conversation itself, so nobody typed the request, and a model reading it bare
 * answers it as though the person had asked, with a reply that says "as you asked". The frame says
 * what the request cannot say about itself. It also says the welcome is already on screen: the
 * transcript draws it in place of this message, and a model told only "introduce yourself" opened
 * its answer with a second hello under the first. It is presentation, as the firing frame
 * is: the request stays the plain sentence in `first-day.tsx`, and this is how it is put to the
 * model.
 */
export function frameFirstDay(request: string): string {
  return [...FIRST_DAY_FRAME, "", request].join("\n");
}

/**
 * The request back out of a framed message, or null if this was not one.
 *
 * Null means "not a first-day message" and nothing else, the contract `readFiring` keeps: the
 * transcript falls through to drawing the text as the person's own message, and the titler to the
 * raw text. A frame around a blank request is still a first-day message, so it returns the blank
 * request rather than null.
 *
 * A prefix match on the whole frame, not on its first sentence, so a person quoting one of the lines
 * back into Chat still sees their own message drawn as theirs.
 *
 * Returned untrimmed, exactly as `frameFirstDay` was given it.
 */
export function readFirstDay(text: string): string | null {
  if (!text.startsWith(PREFIX)) return null;
  return text.slice(PREFIX.length);
}
