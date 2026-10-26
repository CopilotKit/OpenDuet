/**
 * The sentences that tell the Bot a turn is the day's morning brief, posted because the person
 * opened the app, declared once and read from both sides.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `routine-firing.ts` gives. Chat asks for the
 * brief the first time the person opens it on a day that is not their first (the first day belongs
 * to the greeting in `first-day.ts`), so the framed text lands in the transcript as a `user` message
 * nobody typed. Five readers have to recognise it again: the transcript, to draw nothing where the
 * person's bubble would be, since the Bot speaks first; the titler and the conversation summary, so
 * the brief never names a conversation; the task turn, so the roster never shows it as the person's
 * ask; and the reply-chips check, which refuses buttons on this turn as it does on the first day.
 * Two copies of a sentence is a contract with two authors, and the first rewording breaks a reader
 * silently.
 *
 * REWORDING IT. A brief already posted keeps its old frame in the thread for good. A new wording has
 * to keep the old one readable, the way `RETIRED_FRAMES` in `first-day.ts` does, or every earlier
 * day's brief starts drawing as a bubble of the person's.
 */

/** The server tool that builds the brief (server/src/openduet/brief.ts) and the app draws as a card. */
export const MORNING_BRIEF_TOOL = "morning_brief";

/**
 * NO BUTTONS FROM THE MODEL, for the reason `NO_BUTTONS` in `first-day.ts` gives. A model offered
 * `suggest_replies` beside a read calls it in its first step, before it has written anything, and
 * the turn collapses to a closing question. Here the read is the brief, and its card already puts
 * Start on each thing that needs the person, so a row of chips under it would be a second set of
 * answers to a question nobody asked.
 */
const NO_BUTTONS =
  "Do not call suggest_replies in this turn: the brief's card already puts Start on each thing that needs them.";

export const MORNING_BRIEF_FRAME = [
  "Nobody typed this. The person has just opened the app for the first time today, and the app sent the request below for them, so the day's brief is waiting when they look.",
  `Call ${MORNING_BRIEF_TOOL} once. The app shows what it returns as a card that already greets them, so do not greet them or repeat what it lists. After it, add at most one short sentence, on the one thing that matters most today or on what could not be checked, and do nothing else this turn.`,
  NO_BUTTONS,
] as const;

/**
 * What Chat asks for the first time it opens on a day that is not the first. It goes out wrapped in
 * the frame above, which tells the model nobody typed it, to call `morning_brief`, and to say at most
 * one sentence after it; the transcript draws nothing where it sits, so the Bot's reply and the
 * brief's card are what the person finds.
 *
 * Plain, because the frame says everything about how to answer. The brief itself is the tool's,
 * sorted on the server the way evals/triage measures, and the card is the app's.
 */
export const MORNING_BRIEF_REQUEST = "Give me my morning brief.";

/** The frame and the blank line under it, which is what `readMorningBrief` strips. */
const PREFIX = [...MORNING_BRIEF_FRAME, "", ""].join("\n");

/**
 * The request, wrapped in the sentences that tell the turn nobody asked for it.
 *
 * Presentation, as the first-day frame is: the request stays the plain sentence in `morning-brief.tsx`
 * on the app's side, and this is how it is put to the model. Read bare, "Give me my morning brief"
 * is answered as though the person had typed it, and the answer opens with "Good morning! Here's
 * the brief you asked for".
 */
export function frameMorningBrief(request: string): string {
  return [...MORNING_BRIEF_FRAME, "", request].join("\n");
}

/**
 * The morning brief's message, framed. Built by the server and never taken from the browser, for
 * the reason `firstDayGreeting` in `first-day.ts` gives: it runs as a turn in the person's
 * name, and the request is a constant, so there is nothing for a caller to say.
 */
export function morningBriefMessage(): string {
  return frameMorningBrief(MORNING_BRIEF_REQUEST);
}

/**
 * The request back out of a framed message, or null if this was not one.
 *
 * Null means "not a morning brief" and nothing else, the contract `readFiring` keeps: the transcript
 * falls through to drawing the text as the person's own message, and the titler to the raw text. A
 * frame around a blank request is still a brief, so it returns the blank request rather than null.
 *
 * A prefix match on the whole frame, not on its first sentence, so a person quoting one of the lines
 * back into Chat still sees their own message drawn as theirs.
 *
 * Returned untrimmed, exactly as `frameMorningBrief` was given it.
 */
export function readMorningBrief(text: string): string | null {
  return text.startsWith(PREFIX) ? text.slice(PREFIX.length) : null;
}

/** `YYYY-MM-DD`: the shape a local date travels in, from the browser to the claim's column. */
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The person's calendar date where they are, as `YYYY-MM-DD`.
 *
 * THE BROWSER'S DATE, NOT THE SERVER'S. "The first time today" is the person's today: a server in
 * UTC would post a New York morning's brief at 8pm the evening before, and none the next morning.
 * The server never learns the person's time zone; it is told this date and checks it is plausible
 * (`briefDate` in server/src/channels/morning-brief.ts).
 */
export function localDateOf(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${String(at.getFullYear()).padStart(4, "0")}-${month}-${day}`;
}

/**
 * Midnight UTC on a `YYYY-MM-DD` date, in milliseconds, or null for anything that is not a real one.
 *
 * Checked by round trip, because `Date.UTC` rolls "2026-02-30" over into March rather than refusing
 * it, and a date that names no day is not one a claim can be keyed on.
 */
export function utcMidnightOf(value: string): number | null {
  const parts = LOCAL_DATE.exec(value);
  if (!parts) return null;
  const [year, month, day] = [parts[1], parts[2], parts[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const at = Date.UTC(year, month - 1, day);
  const back = new Date(at);
  return back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day
    ? at
    : null;
}
