import { FIRST_DAY_REQUEST_WITHOUT_MAIL } from "@openbot/shared/first-day";

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
 * calendar, declared in `shared/first-day.ts` (with why it reads as it does) because the server
 * builds the message from it. Its words are matched exactly by {@link firstDayPlan}, so the
 * transcript draws the plan that goes with it, on every reload.
 */
export { FIRST_DAY_REQUEST_WITHOUT_MAIL };

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
