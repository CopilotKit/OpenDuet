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

/** The second bubble: what the run underneath it is doing. */
export const FIRST_DAY_PLAN =
  "I'm going to read your recent mail and this week's calendar, then tell you how I can help.";
