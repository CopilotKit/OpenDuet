/**
 * What the Bot says on the person's first day, drawn in place of the message Chat sent for them.
 *
 * Chat starts the first conversation itself (`chat-screen.tsx`), so the first message in the thread
 * is a request nobody typed. The transcript draws these two lines there instead, in the Bot's
 * bubbles: the Bot speaking first, saying what it is about to do while it does it.
 */

/**
 * The name to greet somebody by: the first word of their name, or null when there is no name worth
 * using. An account made from an email address often carries the address as its name, and "Hi
 * maya@example.com" is worse than no name at all.
 */
export function firstNameOf(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? "";
  if (trimmed === "" || trimmed.includes("@")) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

/** The first bubble: a welcome, and that the Bot will learn how they work. */
export function firstDayWelcome(firstName: string | null): string {
  const hello = firstName ? `Welcome, ${firstName}.` : "Welcome.";
  return `${hello} It's our first day together, and I'll learn how you work as we go.`;
}

/**
 * The second bubble when the person's Gmail and Calendar are connected: what the run underneath it
 * is doing.
 */
export const FIRST_DAY_PLAN =
  "I'm going to check your recent mail and this week's calendar to see how I can help. Be right back!";

/**
 * What Chat asks for on the first day when the primary Bot can't read the person's mail and
 * calendar: no promise to read them, what it can do now, and the card that connects them.
 *
 * A run that asks the Bot to read mail it cannot reach can only end in a refusal under a bubble that
 * said it was reading. So this run asks for what it can do, and for the app-access card
 * (`show_app_access`), whose Connect is the connection itself. It names the app by its id: asked for
 * "Gmail and Google Calendar", the model asked the tool for "Gmail", "Google Calendar" and "Google
 * Workspace", none of which is an app here, and no card was drawn. Its words are matched exactly by
 * {@link firstDayPlan}, so the transcript draws the plan that goes with it, on every reload.
 */
export const FIRST_DAY_REQUEST_WITHOUT_MAIL =
  "Get to know me. My Gmail and Google Calendar aren't connected yet, so don't try to read them. In a few sentences, tell me what you can do for me now. Then show me the card to connect them: it is one app, google-workspace, but don't write that id to me. Say in one line what you'll do once it's connected.";

/** The second bubble when the mail and calendar aren't connected: no promise to read them. */
export const FIRST_DAY_PLAN_WITHOUT_MAIL =
  "I can't see your mail or calendar yet, so I'll start with what I can do for you now.";

/**
 * The plan bubble for the request Chat sent: the one without mail for that request, and the mail
 * plan for anything else, which is every first day sent before this choice existed.
 */
export function firstDayPlan(request: string | null): string {
  return request === FIRST_DAY_REQUEST_WITHOUT_MAIL
    ? FIRST_DAY_PLAN_WITHOUT_MAIL
    : FIRST_DAY_PLAN;
}
