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
/** About what fits on one chip at phone width beside another. */
export const MAX_REPLY_LENGTH = 40;

const REFUSAL = `Refused. ${REPLIES_TOOL} takes two or three different replies, each at most ${MAX_REPLY_LENGTH} characters.`;

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
        "Show two or three short replies as buttons for the person to tap, when you are asking them to choose between a few clear answers.",
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
