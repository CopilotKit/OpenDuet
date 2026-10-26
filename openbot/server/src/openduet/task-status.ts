import { TASK_STATUS_TOOL } from "@openbot/shared/task-brief";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import type { TurnReport } from "@openbot/toolkit/run-turn";
import { z } from "zod";
import type { AuditInitiator } from "../audit";

/*
 * Where a task stands, said by the Bot rather than read out of its prose.
 *
 * FOUND ON TASKS. A task's row reads its status and then a next step, and both were worked out from
 * the last paragraph of the Bot's reply (`replyEnding` in proactive/engine.ts). Real rows read "Ready
 * for review · Where the website lives now." and "· Make-up and cancellation policy", the heading
 * of whatever section the reply happened to end on, and "· Priya's other email says your Q2 return
 * is already filed…", a remark. A reply ending "If you send me the details, I'll fill in the labels"
 * read Ready for review, because it asked without a question mark. The reply is written for the
 * person reading the task; the row needs one deliberate line about what happens next, and whether
 * that is the person's move.
 *
 * WHY A TOOL. The same reason reply chips are one (openduet/replies.ts): the row has to know which
 * words are the next step, and picking them out of a reply is the guess that failed. The task's turn
 * collects the call's arguments (`reportTools`, toolkit/run-turn.ts) and records them as the row's
 * line and its needs-input flag (openduet/task-threads.ts), the same two values the prose reading
 * wrote, in the same columns. So nothing new is stored, every task recorded before this reads as it
 * did, and a turn that does not call it falls back to the prose reading.
 *
 * NOTHING HAPPENS HERE. It checks its arguments and says they were noted. It runs in this process
 * and calls nothing, so the approval gate never meets it. Held by every Bot, as the brief and the
 * reply chips are; outside a task's own conversation nothing reads it.
 */

export { TASK_STATUS_TOOL };

/** How long the row's line may run: one line on Tasks at phone width, with the status before it. */
export const TASK_NEXT_MAX = 120;

const parameters = z
  .object({
    status: z
      .enum(["needs_you", "done"])
      .describe(
        "needs_you: you asked them something, or cannot go on without something from them (a detail, a file, a choice, a yes). done: the work is finished and only needs reading.",
      ),
    next: z
      .string()
      .trim()
      .min(1)
      .max(TASK_NEXT_MAX)
      .describe(
        "One line for their Tasks list, under fifteen words: what you need from them, or what is ready for them. For example 'Send me the label sizes and I'll fill them in' or 'Reply to Priya is drafted and ready to send'. Never a heading, and never a fact you found.",
      ),
  })
  .strict();

export type TaskStatusReport = z.infer<typeof parameters>;

const REFUSAL = `Refused. ${TASK_STATUS_TOOL} takes status, needs_you or done, and next, one line of at most ${TASK_NEXT_MAX} characters.`;

/**
 * What the Bot last said through the tool in this turn, or null when it said nothing it would take.
 * The last call wins: a turn that went on working after an early call ends where its last one says.
 */
export function readTaskStatus(
  reports: readonly TurnReport[] | undefined,
): TaskStatusReport | null {
  for (const report of [...(reports ?? [])].reverse()) {
    if (report.name !== TASK_STATUS_TOOL) continue;
    const parsed = parameters.safeParse(report.args);
    if (parsed.success) return parsed.data;
  }
  return null;
}

export function taskStatusTools(options: {
  initiator: AuditInitiator;
}): GrantedTool[] {
  return [
    {
      name: TASK_STATUS_TOOL,
      ref: `openduet/${TASK_STATUS_TOOL}`,
      description: [
        "Say where a task stands, for the person's Tasks list.",
        "Only in a task's own conversation, one that opened with 'This conversation is a task the person handed you'; never in Chat or a channel.",
        "There, call it once at the end of every turn, after your reply: needs_you when you asked them anything or are waiting on them, done when the work is finished.",
        "It is shown on their Tasks list and not in this conversation, so your reply must still say what you did and what you need.",
      ].join(" "),
      parameters,
      initiator: options.initiator,
      async execute(args) {
        const parsed = parameters.safeParse(args ?? {});
        if (!parsed.success) return REFUSAL;
        // Said so the model writes its reply if it called this first, rather than stopping on it.
        return "Noted for their Tasks list. It is not shown in this conversation: if you have not yet told them what you did and what you need, write that now.";
      },
    },
  ];
}
