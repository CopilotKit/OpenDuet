import { utcMidnightOf } from "@openbot/shared/morning-brief";

/**
 * A morning brief committed with its claim, delivered even if the opening browser leaves. Drained by
 * the proactive engine beside the first-day greeting (`drainOpening` in proactive/engine.ts).
 */
export const MORNING_BRIEF_KIND = "openduet.morning-brief";

const DAY_MS = 24 * 60 * 60_000;

/**
 * The browser's local date if it is one a claim can be keyed on, or null.
 *
 * A real `YYYY-MM-DD`, and no more than a day from the server's own UTC date. Every place on Earth
 * keeps a calendar date within a day of UTC's, so a date further out is a clock that is wrong, and
 * a wrong clock would claim a day that has not come yet, which turns the real one away when it
 * arrives. Refused rather than corrected: the server does not know where the person is, so it has
 * no right date to put in its place.
 */
export function briefDate(value: unknown, now: Date): string | null {
  if (typeof value !== "string") return null;
  const at = utcMidnightOf(value);
  if (at === null) return null;
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return Math.abs(at - today) <= DAY_MS ? value : null;
}
