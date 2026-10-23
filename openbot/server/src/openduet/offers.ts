import { OFFER_TASK_TOOL } from "@openbot/shared/check-in";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import type { AuditInitiator } from "../audit";
import type { ProactiveSuggestion } from "../proactive/types";

/*
 * Offering a task in the conversation: the card a check-in ends on, with Start and Hide, drawn in the
 * thread under the Bot's words about it.
 *
 * WHY A TOOL. A check-in (`shared/check-in.ts`) is the Bot writing first about what background
 * research found. The suggestions already exist, on the Tasks tab; what the thread needs is the same
 * card, at the point the Bot mentions it. The app has to know which suggestion a card is, and a tool
 * call names it exactly, where picking ids out of prose would not.
 *
 * NOTHING HAPPENS HERE. It reads one of the person's own suggestions and returns it for the app to
 * draw (app/src/lib/copilot/offer-task-tool.tsx). Starting it or hiding it is the person's choice,
 * made on the card, through the same routes Tasks uses. So it is a read in every sense the approval
 * gate cares about, and it is the only tool a check-in turn holds (`CHECK_IN_TOOLS`). Held by every
 * Bot, like `add_tasks`, so a Bot can also show a suggestion again when the person asks about it.
 *
 * OWNER-SCOPED. A suggestion that is not the person's is answered exactly like one that does not
 * exist, so an id cannot be used to learn that somebody else's suggestion is there.
 */

export { OFFER_TASK_TOOL };

/** One of the person's suggestions by id, or null when it is not theirs or does not exist. */
export type SuggestionReader = (
  ownerUserId: string,
  suggestionId: string,
) => Promise<ProactiveSuggestion | null>;

/** What the card is drawn from. `status` is the suggestion's now: open, started or dismissed. */
export type OfferedTask = {
  id: string;
  title: string;
  detail: string;
  source: string | null;
  status: ProactiveSuggestion["status"];
};

const REFUSAL = `Refused. ${OFFER_TASK_TOOL} takes the suggestionId of one of this person's suggestions, as listed in the check-in. There is no such suggestion; do not offer it.`;

export function offerTools(options: {
  actorId: string;
  initiator: AuditInitiator;
  read: SuggestionReader;
}): GrantedTool[] {
  const parameters = z
    .object({
      suggestionId: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .describe(
          "The suggestionId of the suggestion to show, exactly as the check-in listed it.",
        ),
    })
    .strict();
  return [
    {
      name: OFFER_TASK_TOOL,
      ref: `openduet/${OFFER_TASK_TOOL}`,
      description: [
        "Show the person one suggested task as a card in this conversation, with Start and Hide, by its suggestionId.",
        "Use it in a check-in, once for each suggestion the check-in lists, after one or two short sentences on what you found.",
        "It starts nothing and sends nothing: the person starts the task or hides it on the card.",
      ].join(" "),
      parameters,
      initiator: options.initiator,
      async execute(args) {
        const parsed = parameters.safeParse(args ?? {});
        if (!parsed.success) return REFUSAL;
        const suggestion = await options.read(
          options.actorId,
          parsed.data.suggestionId,
        );
        if (!suggestion || suggestion.ownerUserId !== options.actorId)
          return REFUSAL;
        const offered: OfferedTask = {
          id: suggestion.id,
          title: suggestion.title,
          detail: suggestion.detail,
          source: suggestion.sourceApp,
          status: suggestion.status,
        };
        return JSON.stringify({
          ...offered,
          note: "The card is on screen under your words. Do not repeat its title or reason in your reply.",
        });
      },
    },
  ];
}
