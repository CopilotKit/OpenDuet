import { onceClaim } from "./claim-once";

/**
 * Who asks for the day's morning brief, so that this browser asks once.
 *
 * Keyed by the person, the Bot and the local date, so a claim never reaches into another day. The
 * guards against a second ask from this page, another tab and a reload are `claim-once.ts`'s. The
 * real claim is the server's, once per person, per Bot, per date (`morningBrief` in
 * server/src/channels/routes.ts); this one only saves asking it again on every open of Chat.
 *
 * HELD FOR A DAY, not the first day's few minutes. The server answers every ask after the first with
 * "already claimed", so a later open of Chat on the same day has nothing to gain by asking, and the
 * date in the key frees the next day's on its own.
 */
export const MORNING_BRIEF_CLAIM_MS = 24 * 60 * 60_000;

const morningBrief = onceClaim({
  prefix: "openduet.morning-brief:",
  holdMs: MORNING_BRIEF_CLAIM_MS,
});

/** The storage key for one person's brief with one Bot on one local date. */
export const morningBriefClaimKey = morningBrief.storageKey;

/**
 * Run `ask` if this browser has not asked for this brief yet, and hold off everything else while it
 * runs. `ask` answers whether it asked; see `OnceClaim.claim`.
 */
export const claimMorningBrief = morningBrief.claim;
