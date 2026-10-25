import { START_TASK_TOOL } from "@openbot/shared/task-brief";
import {
  sanitizeThumbnail,
  THUMBNAIL_GUIDANCE,
} from "@openbot/shared/thumbnail";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import type { AuditInitiator } from "../audit";
import type { OpenedTask, AskedTask as StartedTask } from "../proactive/engine";

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
export { START_TASK_TOOL };
/** The whole ask, in the person's words or a faithful restatement. Room for a long paragraph. */
export const MAX_INSTRUCTION = 4000;
/** Enough for a morning's worth of hand-offs; past this, it is a list, not tasks. */
export const MAX_TASKS_PER_CALL = 8;

const source = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .optional()
  .describe(
    "Where it came from, as the person would say it: 'Gmail', 'Google Calendar'. Leave out when it came from the conversation itself.",
  );
const link = z
  .string()
  .trim()
  .max(1000)
  .refine(
    (value) => /^https?:\/\//i.test(value) && URL.canParse(value),
    "Links must be http or https URLs.",
  )
  .optional()
  .describe("A link to the email or event it came from, when you have one.");

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
    source,
    link,
  })
  .strict();

export type AskedTask = z.infer<typeof task>;

/** Where the cards are saved. The server's assembly provides it; see wiring.ts. */
export type TaskSink = (input: {
  ownerUserId: string;
  agentId: string;
  tasks: AskedTask[];
  /** The channel they were asked for in, or null for Everything. */
  fromChannelId: string | null;
}) => Promise<{ id: string; title: string }[]>;

/** Starts a task in a conversation of its own. The server's assembly provides it; see wiring.ts. */
export type TaskStarter = (input: {
  ownerUserId: string;
  agentId: string;
  task: StartedTask;
}) => Promise<OpenedTask>;

/** The card's body: the reason, then the step, as the Tasks card shows two lines of it. */
export function taskDetail(input: Pick<AskedTask, "why" | "next">): string {
  return `${input.why}\n\nNext: ${input.next}`;
}

export function taskTools(options: {
  actorId: string;
  botId: string;
  initiator: AuditInitiator;
  save: TaskSink;
  /** Absent, `start_task` is not held: there is nowhere to run one. */
  start?: TaskStarter | undefined;
  /**
   * The channel the run calling a tool is in, read when it executes, or null for Everything. What a
   * task started or added there is tagged with. Absent reads null. See openduet/run-channel.ts.
   */
  channel?: () => string | null;
}): GrantedTool[] {
  const channel = options.channel ?? (() => null);
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
    ...(options.start
      ? [startTaskTool({ ...options, start: options.start, channel })]
      : []),
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
          fromChannelId: channel(),
        });
        return JSON.stringify({
          added,
          note: `${added.length === 1 ? "The task is" : `All ${added.length} tasks are`} on the Tasks tab, under Up next, each with Start and Hide. Say so in one short sentence; do not list them again.`,
        });
      },
    },
  ];
}

const startParameters = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .describe(
        "The task's name on its card: a short imperative, e.g. 'Draft a reply to Rosa about Oat Satin'.",
      ),
    instruction: z
      .string()
      .trim()
      .min(1)
      .max(MAX_INSTRUCTION)
      .describe(
        "The whole ask, in the person's words or a faithful restatement, with every detail they gave. The task starts from this alone.",
      ),
    why: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .optional()
      .describe("Why it matters or by when, in a sentence, when they said."),
    source,
    link,
    thumbnail: z.string().optional().describe(THUMBNAIL_GUIDANCE),
  })
  .strict();

/*
 * `start_task`: anything bigger than a quick answer, handed off from Chat to a task of its own.
 *
 * Chat stays one thread. The work happens in the task's own conversation with the same Bot, which
 * the person opens from the card this leaves in Chat and can reply in to steer; Chat only says "On
 * it". Opening the task and starting its turn is the proactive engine's (`startAsked`), the same path
 * Start on a suggestion takes, so both kinds of task run, wait and finish the same way.
 *
 * Nothing leaves the deployment here: the turn it starts is the person's own, made on their behalf in
 * their words, and anything it then tries to send meets the approval gate as any turn of theirs does.
 */
function startTaskTool(options: {
  actorId: string;
  botId: string;
  initiator: AuditInitiator;
  start: TaskStarter;
  channel: () => string | null;
}): GrantedTool {
  return {
    name: START_TASK_TOOL,
    ref: `openduet/${START_TASK_TOOL}`,
    description: [
      "Hand work to a task of its own, which runs in the background in a separate conversation with you, and leave a card for it in Chat.",
      "Use it for anything bigger than a quick answer: drafting, researching, preparing something, or any job of several steps or more than one reply.",
      'Call it once per piece of work; two separate asks are two tasks. Then reply only "On it.", or "On it" and one short clause, and do not do the work in Chat.',
      "Never call it inside a task's own conversation; there, do the work.",
      THUMBNAIL_GUIDANCE,
    ].join(" "),
    parameters: startParameters,
    initiator: options.initiator,
    async execute(args) {
      const parsed = startParameters.safeParse(args ?? {});
      if (!parsed.success)
        return `Refused. ${START_TASK_TOOL} takes a title (at most 160 characters) and the instruction (at most ${MAX_INSTRUCTION}); why, source and link are optional, and a link must be an http or https URL. ${parsed.error.issues[0]?.message ?? ""}`.trim();
      const task = await options.start({
        ownerUserId: options.actorId,
        agentId: options.botId,
        task: {
          ...parsed.data,
          thumbnail: sanitizeThumbnail(parsed.data.thumbnail) ?? undefined,
          fromChannelId: options.channel(),
        },
      });
      return JSON.stringify({
        taskId: task.id,
        channelId: task.channelId,
        title: task.title,
        thumbnail: sanitizeThumbnail(parsed.data.thumbnail),
        note: 'The task is under way in its own conversation, and its card is under your reply. Reply only "On it.", or "On it" and one short clause. Do not describe the task or what happens next, and do not do the work here.',
      });
    },
  };
}
