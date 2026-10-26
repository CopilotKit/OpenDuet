import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import type { AuditInitiator } from "../audit";

/*
 * Reply chips: two or three short answers drawn under the Bot's question, so a choice can be
 * answered with a tap. A tap is sent as the person's own message, exactly as if they had typed it,
 * so the Bot reads the answer the way it reads anything else they say.
 *
 * A tool rather than a habit of the Bot's prose, because the app has to know which words are the
 * answers. Picking them out of a sentence would draw chips the Bot never offered and miss the ones
 * it did.
 *
 * NOTHING HAPPENS HERE. The tool checks the replies and says they were shown; drawing them is the
 * app's (app/src/lib/copilot/reply-chips-tool.tsx), and the most a tap can do is send words the
 * person could have typed. So it is a read in every sense the approval gate cares about, and it
 * never meets the gate at all: it runs in this process and calls nothing, and the gate is only
 * asked about connector calls, the computer, host folders and hand-offs. A background run is not
 * offered it, as it is not offered the brief, because `restrictToolsForRun` keeps that run to the
 * catalogue's reads. Nobody is there to tap.
 */

export const REPLIES_TOOL = "suggest_replies";
/** One to three words: what fits on one chip at phone width beside another (parity-spec 2.14). */
export const MAX_REPLY_LENGTH = 24;

const REFUSAL = `Refused. ${REPLIES_TOOL} takes two or three different replies, each at most ${MAX_REPLY_LENGTH} characters.`;

/*
 * What a built-in run answers instead, once it knows the turn (reply-turn.ts). The answer above
 * cannot know whether the question was asked yet, so it asks the model to work that out; told
 * "otherwise stop here", it asked a second time anyway.
 */

/** How every answer that drew the buttons begins, this tool's own included. */
export const REPLIES_DRAWN_PREFIX = "The buttons are";
/**
 * Called beside a read, or before the answer was written: drawn, but under the answer still to come.
 *
 * The answer that collapsed a reply told the model the buttons were on screen and to ask "in one
 * short sentence", and it did exactly that. This one says what the person can actually see, which
 * is nothing yet, and asks for the answer it would write with no buttons at all.
 */
export const REPLIES_HELD = `${REPLIES_DRAWN_PREFIX} held: they appear under the last thing you write this turn. Nothing is on the person's screen yet, not even what you read. Write your full answer now, as you would with no buttons: what you found, what you recommend, and a short question that doesn't list the choices. Don't call ${REPLIES_TOOL} again, and don't mention the buttons.`;
/** Called while the turn waits on the person's approval: the next choice comes after that answer. */
export const REPLIES_AFTER_APPROVAL =
  "Refused. Ask after the person answers the approval, in your reply once the action is done.";
/** The first day's own replies are drawn by the app (`FirstDayReplies`), under its answer. */
export const REPLIES_FIRST_DAY = `Refused. Not on the first day: the app draws this turn's own replies under your answer. Don't call ${REPLIES_TOOL} in this turn.`;
/**
 * The morning brief nobody typed: its card puts Start on each thing that needs the person, so chips
 * under it would be a second set of answers to a question nobody asked (shared/morning-brief.ts).
 */
export const REPLIES_MORNING_BRIEF = `Refused. Not in the morning brief: its card already puts Start on each thing that needs the person. Don't call ${REPLIES_TOOL} in this turn.`;
/**
 * A second set while the first is held for an answer still to come: this one is not drawn, and the
 * answer is still owed. Told "end your turn" here instead, beside the held answer, the model wrote
 * "Nothing more to add for now." in place of its answer.
 */
export const REPLIES_ALREADY_HELD =
  "Refused. One set of buttons is already held for this turn. Write your full answer now, as you would with no buttons, and don't mention the buttons.";
/** A second set in one turn: the first is still on screen, so this one is not drawn. */
export const REPLIES_ALREADY_SHOWN =
  "Refused. The buttons are already on screen. End your turn now and write nothing more.";
/** Drawn under a question already asked in words. */
export const REPLIES_SHOWN = `${REPLIES_DRAWN_PREFIX} on screen, under your question. End your turn now and write nothing more.`;
/** Drawn under words that asked nothing yet. */
export const REPLIES_SHOWN_ASK = `${REPLIES_DRAWN_PREFIX} on screen. Ask your question now in one short sentence, without listing the replies, then end your turn.`;

/** Held by every Bot, like the brief. It reads nothing and writes nothing. */
export function replyTools(options: {
  initiator: AuditInitiator;
}): GrantedTool[] {
  const parameters = z
    .object({
      replies: z
        .array(z.string().trim().min(1).max(MAX_REPLY_LENGTH))
        .min(2)
        .max(3)
        .describe(
          `Two or three replies, in the person's words, each at most ${MAX_REPLY_LENGTH} characters: "Yes", "Not now", or the options you just proposed.`,
        ),
    })
    .strict();
  return [
    {
      name: REPLIES_TOOL,
      ref: `openduet/${REPLIES_TOOL}`,
      description: [
        'Show two or three short replies as buttons for the person to tap, when you are asking them to choose between a few clear answers. Each reply is one to three words, such as "Yes", "Not now" or "SEO blog plan".',
        "Ask the question in words as well: the buttons are drawn under the last thing you write this turn, and never replace the question.",
        "A tap arrives as their next message, so write each reply as they would say it, and never list the replies in your text.",
        "Never use it for an open question. Never use it to ask whether to send, pay, sign or delete: call the tool that does it, and its approval asks them.",
      ].join(" "),
      parameters,
      initiator: options.initiator,
      async execute(args) {
        const parsed = parameters.safeParse(args ?? {});
        if (!parsed.success) return REFUSAL;
        const replies = parsed.data.replies;
        // Two chips saying the same thing is one choice drawn twice.
        if (
          new Set(replies.map((reply) => reply.toLowerCase())).size !==
          replies.length
        )
          return REFUSAL;
        return "The buttons are on screen, under the last thing you write this turn. If you have not asked the question in words yet, ask it now in one short sentence without listing the replies; otherwise stop here.";
      },
    },
  ];
}
