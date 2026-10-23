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
 * The ask back out of a framed message, or null if this was not one.
 *
 * Null means "not a task's first message" and nothing else, the contract `readFiring` keeps. A prefix
 * match on the whole frame, so a person quoting one of its lines still sees their own words.
 */
export function readTaskBrief(text: string): string | null {
  if (!text.startsWith(PREFIX)) return null;
  return text.slice(PREFIX.length);
}
