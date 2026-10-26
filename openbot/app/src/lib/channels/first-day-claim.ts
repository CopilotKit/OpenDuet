import { onceClaim } from "./claim-once";

/**
 * Who sends the first-day greeting, so that it goes once.
 *
 * Chat sends it on its own when it opens on nothing (`chat-screen.tsx`), keyed by the person and the
 * Bot. The guards against a second send from this page, another tab and a reload are
 * `claim-once.ts`'s, shared with the morning brief. Two devices on the same first day are the
 * server's to turn away: it claims the first day once (`firstDay` in server/src/channels/routes.ts).
 */

/** How long a sent greeting stops another: well past the few seconds it takes to reach the server. */
export const FIRST_DAY_CLAIM_MS = 5 * 60_000;

const firstDay = onceClaim({
  prefix: "openduet.first-day-greeting:",
  holdMs: FIRST_DAY_CLAIM_MS,
});

/** The storage key for one person's first day with one Bot. */
export const firstDayClaimKey = firstDay.storageKey;

/**
 * Run `greet` if nothing else has greeted this person on this Bot's behalf, and hold off everything
 * else while it runs. `greet` answers whether it sent the greeting; see `OnceClaim.claim`.
 */
export const claimFirstDay = firstDay.claim;
