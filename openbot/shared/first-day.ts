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

/**
 * What Chat asks for on the person's first day. It goes out wrapped in the first-day frame above,
 * which tells the model nobody typed it and the welcome is already on screen, and the transcript
 * draws the Bot's greeting in its place. The `first-day` skill in the tenant package names the mail
 * and calendar tools it needs, and asks for the same shape.
 *
 * THREE PARTS, BECAUSE THE TRANSCRIPT DRAWS THEM AS THREE BUBBLES. Asked only to "tell me what you
 * think I do", the answer came back as one bubble of 1,400 to 1,900 characters with bold labels and
 * three numbered paragraphs, two or three screens at phone width. So the request names the parts,
 * their lengths and the closing sentence, and asks for a blank line between them: the transcript
 * splits the first day's answer at those lines (`firstDayParts` in chat-transcript.tsx).
 *
 * NOTHING HERE ABOUT REPLY BUTTONS. Asking for the answer "before any replies to tap" made the model
 * reach for `suggest_replies` at once and end on the closing question, five runs of five. The frame
 * keeps the model's buttons out of the first day (`NO_BUTTONS`), and the app draws "Sounds right"
 * and "Something's off" under the answer itself.
 *
 * DECLARED HERE, NOT IN THE APP, because the server builds the message from it
 * ({@link firstDayGreeting}) and takes nothing but the choice between the two from the browser.
 */
export const FIRST_DAY_REQUEST = [
  "Get to know me. Look through my recent mail and this week's calendar, then answer in three parts, with a blank line between them.",
  "First, in plain sentences with no bold or headings, say who you think I am and what I do, in at most 450 characters.",
  'Second, write "How I\'ll help:" and then three bullets, one line each and under 60 characters, each tied to something you saw.',
  'Third, end with this sentence on its own: "If any of these sound off, just let me know and I\'ll learn."',
].join(" ");

/**
 * What Chat asks for on the first day when the primary Bot can't read the person's mail and
 * calendar: no promise to read them, what it can do now, and the card that connects them.
 *
 * A run that asks the Bot to read mail it cannot reach can only end in a refusal under a bubble that
 * said it was reading. So this run asks for what it can do, and for the app-access card
 * (`show_app_access`), whose Connect is the connection itself. It names the app by its id: asked for
 * "Gmail and Google Calendar", the model asked the tool for "Gmail", "Google Calendar" and "Google
 * Workspace", none of which is an app here, and no card was drawn. Its words are matched exactly by
 * `firstDayPlan` in the app, so the transcript draws the plan that goes with it, on every reload.
 */
export const FIRST_DAY_REQUEST_WITHOUT_MAIL =
  "Get to know me. My Gmail and Google Calendar aren't connected yet, so don't try to read them. In a few sentences, tell me what you can do for me now. Then show me the card to connect them: it is one app, google-workspace, but don't write that id to me. Say in one line what you'll do once it's connected.";

/** Which first day: the Bot can read the person's mail and calendar, or cannot yet. */
export type FirstDayGreeting = "with_mail" | "without_mail";

/**
 * The first day's message, framed, built from the choice alone.
 *
 * THE SERVER BUILDS IT, NOT THE BROWSER. It runs as a turn nobody typed, in the person's name, and
 * the route used to take up to 8,000 characters of the browser's own text after the frame and run
 * them. The request is one of two constants, so the browser says which and the server writes it:
 * nothing a caller writes reaches the model as the person.
 */
export function firstDayGreeting(which: FirstDayGreeting): string {
  return which === "without_mail"
    ? frameFirstDay(FIRST_DAY_REQUEST_WITHOUT_MAIL, { mail: false })
    : frameFirstDay(FIRST_DAY_REQUEST);
}
