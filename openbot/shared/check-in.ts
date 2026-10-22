/**
 * The sentences that tell the Bot a turn is a check-in it started itself, declared once and read from
 * both sides.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `routine-firing.ts` gives. Background research
 * starts this turn in the person's own conversation when it found something new, so the framed text
 * lands in the transcript as a `user` message nobody typed. Two readers have to recognise it again:
 * the transcript, to draw a quiet line where the person's bubble would be, and the titler, to name the
 * conversation from what was found rather than from the frame.
 *
 * The suggestions ride under the frame as JSON. The model reads JSON well, the transcript and the
 * browser notification read the same ids and titles out of it, and a title with a newline or a
 * quote in it cannot break a hand-rolled list.
 */

/** The one tool a check-in turn holds: show a suggestion its run recorded as a card in the thread. */
export const OFFER_TASK_TOOL = "offer_task";

export const CHECK_IN_FRAME = [
  "This is a check-in you started yourself. You just looked through the person's mail and calendar in the background, nobody asked you anything, and they have not written.",
  `Write one or two short sentences on what you found, then call ${OFFER_TASK_TOOL} once for each suggestion below with its suggestionId, so each one shows as a card they can start or hide.`,
  `Do nothing else. Never act on a suggestion, never send or change anything, and never call any tool other than ${OFFER_TASK_TOOL}. They decide on the cards.`,
] as const;

/** The frame and the blank line under it, which is what `readCheckIn` strips. */
const PREFIX = [...CHECK_IN_FRAME, "", ""].join("\n");

/** One new suggestion the check-in offers: its id for `offer_task`, its title, and why. */
export type CheckInOffer = { id: string; title: string; why: string };

export type CheckIn = {
  /** When the check-in looked, as an ISO 8601 instant, or null when the frame's body was unreadable. */
  checkedAt: string | null;
  offers: CheckInOffer[];
};

/** The check-in's message: the frame, then what was found, as JSON. */
export function frameCheckIn(checkIn: {
  checkedAt: string;
  offers: readonly CheckInOffer[];
}): string {
  const body = JSON.stringify(
    {
      checkedAt: checkIn.checkedAt,
      suggestions: checkIn.offers.map((offer) => ({
        suggestionId: offer.id,
        title: offer.title,
        why: offer.why,
      })),
    },
    null,
    2,
  );
  return [...CHECK_IN_FRAME, "", body].join("\n");
}

/**
 * What a framed message found, or null if this was not a check-in.
 *
 * Null means "not a check-in" and nothing else, the contract `readFiring` keeps: the transcript falls
 * through to drawing the text as the person's own message, and the titler to the raw text. A frame
 * whose body cannot be read is still a check-in, so it comes back with no time and no offers rather
 * than as null.
 *
 * A prefix match on the whole frame, not on its first sentence, so a person quoting one of the lines
 * back into Chat still sees their own message drawn as theirs.
 */
export function readCheckIn(text: string): CheckIn | null {
  if (!text.startsWith(PREFIX)) return null;
  let body: unknown;
  try {
    body = JSON.parse(text.slice(PREFIX.length));
  } catch {
    return { checkedAt: null, offers: [] };
  }
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const checkedAt =
    typeof record.checkedAt === "string" &&
    Number.isFinite(Date.parse(record.checkedAt))
      ? record.checkedAt
      : null;
  const offers = (
    Array.isArray(record.suggestions) ? record.suggestions : []
  ).flatMap((entry): CheckInOffer[] => {
    if (!entry || typeof entry !== "object") return [];
    const { suggestionId, title, why } = entry as Record<string, unknown>;
    return typeof suggestionId === "string" && typeof title === "string"
      ? [{ id: suggestionId, title, why: typeof why === "string" ? why : "" }]
      : [];
  });
  return { checkedAt, offers };
}

/**
 * A check-in in one line, for a reader that names the conversation from its opening: what was
 * found, by title.
 */
export function describeCheckIn(checkIn: CheckIn): string {
  const titles = checkIn.offers.map((offer) => offer.title);
  return titles.length > 0
    ? `Checked mail and calendar and found: ${titles.join("; ")}`
    : "Checked mail and calendar";
}
