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
/**
 * The one sentence both frames end on: no reply buttons from the model this turn, and the answer in
 * the shape the request asks for.
 *
 * A model offered `suggest_replies` on the first day called it in its first step, beside the mail
 * and calendar reads and before it had written anything, and then wrote only the closing question:
 * the whole "what you do, and how I can help" was never sent. Three of six runs collapsed that way;
 * a request that asked for the answer before any buttons made it five of five, because naming the
 * buttons is what made the model reach for them. So the model offers none on the first day, and the
 * app draws the first day's replies itself under the answer (`FirstDayReplies` in
 * chat-transcript.tsx).
 */
const NO_BUTTONS =
  "Do not call suggest_replies in this turn: write the whole answer, in the shape the request asks for.";

export const FIRST_DAY_FRAME = [
  "This is your first conversation with this person: they have just opened the app for the first time and have not written anything yet, so the request below was sent for them.",
  "The app has already welcomed them in your voice and said you are reading their mail and calendar, so do not greet them or introduce yourself again: carry out the request in this turn and open with what you found.",
  NO_BUTTONS,
] as const;

/**
 * The frame for a first day whose Bot can't read the person's mail and calendar. The app's plan
 * bubble promised no mail, so this says so; and it asks the model not to repeat that nothing was
 * read, which it otherwise opened its answer with every time.
 */
export const FIRST_DAY_FRAME_WITHOUT_MAIL = [
  FIRST_DAY_FRAME[0],
  "The app has already welcomed them in your voice and said you can't see their mail or calendar yet, so do not greet them, introduce yourself or say again that you haven't read them: carry out the request in this turn.",
  NO_BUTTONS,
] as const;

/**
 * Frames first days were sent with before the two above, still in threads. Read, never sent: a
 * stored first day has to keep drawing as the Bot's greeting, not as a bubble of the person's.
 *
 * - The first frame, with no sentence about reply buttons.
 * - An earlier version of `NO_BUTTONS` that asked the answer to end on a question in words.
 */
const RETIRED_NO_BUTTONS =
  "Do not call suggest_replies in this turn: write the whole answer, and end it with one question in words.";
const RETIRED_FRAMES = [
  FIRST_DAY_FRAME.slice(0, 2),
  [...FIRST_DAY_FRAME.slice(0, 2), RETIRED_NO_BUTTONS],
  [...FIRST_DAY_FRAME_WITHOUT_MAIL.slice(0, 2), RETIRED_NO_BUTTONS],
];

/** Each frame and the blank line under it, which is what `readFirstDay` strips. */
const PREFIXES = [
  FIRST_DAY_FRAME,
  FIRST_DAY_FRAME_WITHOUT_MAIL,
  ...RETIRED_FRAMES,
].map((frame) => [...frame, "", ""].join("\n"));

/**
 * The request, wrapped in the sentences that tell the turn it is the first one.
 *
 * Chat starts the first conversation itself, so nobody typed the request, and a model reading it bare
 * answers it as though the person had asked, with a reply that says "as you asked". The frame says
 * what the request cannot say about itself. It also says the welcome is already on screen: the
 * transcript draws it in place of this message, and a model told only "introduce yourself" opened
 * its answer with a second hello under the first. It is presentation, as the firing frame
 * is: the request stays the plain sentence in `first-day.tsx`, and this is how it is put to the
 * model. `mail: false` picks the frame for a Bot that can't read the person's mail, whose welcome
 * promised none.
 */
export function frameFirstDay(
  request: string,
  options: { mail?: boolean } = {},
): string {
  const frame =
    options.mail === false ? FIRST_DAY_FRAME_WITHOUT_MAIL : FIRST_DAY_FRAME;
  return [...frame, "", request].join("\n");
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
  const prefix = PREFIXES.find((candidate) => text.startsWith(candidate));
  return prefix === undefined ? null : text.slice(prefix.length);
}
