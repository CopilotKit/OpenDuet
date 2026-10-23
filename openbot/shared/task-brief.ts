/**
 * The sentences that tell the Bot a conversation is a task of its own, declared once and read from
 * both sides.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `routine-firing.ts` gives. A task starts in a
 * conversation of its own with the person's ask as its first message (`start_task`, or Start on a
 * suggestion), and the turn is started by the server, not typed there. The model needs telling that
 * this conversation IS the task: its prompt says to hand anything bigger than a quick answer to
 * `start_task`, and a task whose first message reads like that ask would hand itself on again,
 * forever. Two readers have to recognise the frame again: the transcript, to draw the person's ask
 * as their own words without the frame, and the titler, to name the conversation from the ask.
 */

/** The tool that hands work to a task of its own. Named here so the frame and the tool agree. */
export const START_TASK_TOOL = "start_task";

export const TASK_FRAME = [
  "This conversation is a task the person handed you. It runs on its own, apart from their Chat, and they read it when they open the task.",
  `Do the work here yourself, all of it, and end with what you did and anything still waiting on them. Never call ${START_TASK_TOOL} in this conversation: this is the task.`,
] as const;

/** The frame and the blank line under it, which is what `readTaskBrief` strips. */
const PREFIX = [...TASK_FRAME, "", ""].join("\n");

/** The person's ask, wrapped in the sentences that tell the turn it is a task's own conversation. */
export function frameTaskBrief(ask: string): string {
  return [...TASK_FRAME, "", ask].join("\n");
}

/**
 * The line between the ask and the person's reply, when they reply to a task that couldn't finish.
 * The run gets the task and their words both; the transcript shows only their words.
 */
export const TASK_REPLY_LINE =
  "The run before this one couldn't finish. The person replied to the task with this:";

/** A reply to a failed task: the ask under the frame for the model, then the person's own words. */
export function frameTaskReply(ask: string, reply: string): string {
  return [...TASK_FRAME, "", ask, "", TASK_REPLY_LINE, "", reply].join("\n");
}

/**
 * The ask back out of a framed message, or null if this was not one. For a reply to a failed task,
 * the reply.
 *
 * Null means "not a task's first message" and nothing else, the contract `readFiring` keeps. A prefix
 * match on the whole frame, so a person quoting one of its lines still sees their own words.
 */
export function readTaskBrief(text: string): string | null {
  if (!text.startsWith(PREFIX)) return null;
  const rest = text.slice(PREFIX.length);
  // A reply to a failed task reads as the reply: that is what the person said.
  const reply = rest.indexOf(`\n\n${TASK_REPLY_LINE}\n\n`);
  return reply === -1 ? rest : rest.slice(reply + TASK_REPLY_LINE.length + 4);
}
