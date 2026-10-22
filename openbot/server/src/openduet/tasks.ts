import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import type { AuditInitiator } from "../audit";

/*
 * Tasks the person asks for in a conversation: "turn these into tasks", "hand those off", "add that
 * to my list". Each becomes a card on the Tasks tab, with Start and Hide, the same card background
 * research leaves there.
 *
 * FOUND ON A REAL ACCOUNT. Asked to turn a morning brief into tasks, the Bot had no tool that puts
 * anything on the Tasks tab: `suggest_next_step` exists only inside a research run. It reached for
 * the one write it does hold in a conversation, its computer's file tool, and wrote a markdown
 * checklist to its workspace. Nothing appeared where the person looks for tasks.
 *
 * The cards are proactive suggestions, deliberately. Tasks already draws them, Start already runs
 * one as a turn the person asked for, and Hide already puts one away; a second kind of task would
 * need all three again. A suggestion belongs to the person's research setting for the Bot, which
 * says where Start runs it. When research was never set up, one is made with research left off,
 * pointing at the person's own conversation with the Bot, so Start has somewhere to go and turning
 * research on later finds it there.
 *
 * Nothing leaves the deployment: the card is the person's own, and starting it is the person's
 * choice, made on the card. So it is not an action the approval gate is asked about.
 */

export const ADD_TASKS_TOOL = "add_tasks";
/** Enough for a morning's worth of hand-offs; past this, it is a list, not tasks. */
export const MAX_TASKS_PER_CALL = 8;

const task = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .describe(
        "What to do, as the card's title: a short imperative, e.g. 'Reply to Rosa about the glaze substitute'.",
      ),
    why: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .describe(
        "Why it matters and by when, in one or two sentences, from what you read.",
      ),
    next: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .describe("The first concrete step, in one sentence."),
    source: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe(
        "Where it came from, as the person would say it: 'Gmail', 'Google Calendar'. Leave out when it came from the conversation itself.",
      ),
    link: z
      .string()
      .trim()
      .max(1000)
      .refine(
        (value) => /^https?:\/\//i.test(value) && URL.canParse(value),
        "Links must be http or https URLs.",
      )
      .optional()
      .describe(
        "A link to the email or event it came from, when you have one.",
      ),
  })
  .strict();

export type AskedTask = z.infer<typeof task>;

/** Where the cards are saved. The server's assembly provides it; see wiring.ts. */
export type TaskSink = (input: {
  ownerUserId: string;
  agentId: string;
  tasks: AskedTask[];
}) => Promise<{ id: string; title: string }[]>;

/** The card's body: the reason, then the step, as the Tasks card shows two lines of it. */
export function taskDetail(input: Pick<AskedTask, "why" | "next">): string {
  return `${input.why}\n\nNext: ${input.next}`;
}

export function taskTools(options: {
  actorId: string;
  botId: string;
  initiator: AuditInitiator;
  save: TaskSink;
}): GrantedTool[] {
  const parameters = z
    .object({
      tasks: z
        .array(task)
        .min(1)
        .max(MAX_TASKS_PER_CALL)
        .describe(`One to ${MAX_TASKS_PER_CALL} tasks.`),
    })
    .strict();
  return [
    {
      name: ADD_TASKS_TOOL,
      ref: `openduet/${ADD_TASKS_TOOL}`,
      description: [
        "Put tasks on the person's Tasks tab, one card each, with Start and Hide.",
        "Use it whenever they ask to turn something into tasks, hand items off, or add something to their list. Never write a task list to a file or into your reply instead.",
        "Each task carries a short title, why it matters, the first step, and where it came from.",
        "This only adds cards: it starts nothing. They start a task from its card, or ask you to start it now.",
      ].join(" "),
      parameters,
      initiator: options.initiator,
      async execute(args) {
        const parsed = parameters.safeParse(args ?? {});
        if (!parsed.success)
          return `Refused. ${ADD_TASKS_TOOL} takes 1 to ${MAX_TASKS_PER_CALL} tasks, each with a title (at most 160 characters), why and next; source and link are optional, and a link must be an http or https URL. ${parsed.error.issues[0]?.message ?? ""}`.trim();
        const added = await options.save({
          ownerUserId: options.actorId,
          agentId: options.botId,
          tasks: parsed.data.tasks,
        });
        return JSON.stringify({
          added,
          note: `${added.length === 1 ? "The task is" : `All ${added.length} tasks are`} on the Tasks tab, under Suggested, each with Start and Hide. Say so in one short sentence; do not list them again.`,
        });
      },
    },
  ];
}
