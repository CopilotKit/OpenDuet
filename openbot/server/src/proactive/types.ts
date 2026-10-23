import { z } from "zod";

export type ProactiveRunStatus = "idle" | "running" | "succeeded" | "error";
export type SuggestionStatus = "open" | "dismissed" | "started";

/** Bounds on how often a Bot may look through a person's apps: once an hour at most, once a day at least. */
export const MIN_INTERVAL_MINUTES = 60;
export const MAX_INTERVAL_MINUTES = 1440;
/** Per run, so one confused run cannot flood the inbox or the memory list. */
export const MAX_SUGGESTIONS_PER_RUN = 5;
export const MAX_MEMORIES_PER_RUN = 10;

export const proactiveSettingInputSchema = z
  .object({
    agentId: z.string().trim().min(1).max(128),
    channelId: z.string().trim().min(1).max(128),
    focus: z.string().trim().max(1000).default(""),
    intervalMinutes: z
      .number()
      .int()
      .min(MIN_INTERVAL_MINUTES)
      .max(MAX_INTERVAL_MINUTES)
      .default(240),
    enabled: z.boolean().default(true),
  })
  .strict();
export const proactiveSettingPatchSchema = proactiveSettingInputSchema
  .pick({ focus: true, intervalMinutes: true, enabled: true })
  .partial()
  .strict();

export const suggestionInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    detail: z.string().trim().min(1).max(2000),
    sourceTool: z.string().trim().min(1).max(256).optional(),
    sourceLink: z
      .string()
      .trim()
      .max(1000)
      .refine(
        (value) => /^https?:\/\//i.test(value) && URL.canParse(value),
        "Links must be http or https URLs.",
      )
      .optional(),
  })
  .strict();
export const proactiveMemoryInputSchema = z
  .object({
    content: z.string().trim().min(1).max(2000),
    sourceTool: z.string().trim().min(1).max(256),
    sourceLink: z
      .string()
      .trim()
      .max(1000)
      .refine(
        (value) => /^https?:\/\//i.test(value) && URL.canParse(value),
        "Links must be http or https URLs.",
      )
      .optional(),
  })
  .strict();

export type ProactiveSettingInput = z.infer<typeof proactiveSettingInputSchema>;
export type ProactiveSetting = {
  id: string;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  threadId: string;
  focus: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: Date;
  lastRunAt: Date | null;
  lastStatus: ProactiveRunStatus;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export type ProactiveSuggestion = {
  id: string;
  ownerUserId: string;
  agentId: string;
  settingId: string;
  runId: string;
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceRef: string | null;
  sourceLink: string | null;
  status: SuggestionStatus;
  deliveredAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
};

/**
 * Where a started suggestion stands, as Tasks lists it.
 *
 * - `working`: its turn is queued, running, or waiting for its one retry after a lost lease.
 * - `needs_input`: its turn ended on something only the person can give: a pending approval, a
 *   question asked through a tool, or a last sentence that asks them something.
 * - `ready_for_review`: its turn finished, and there is a reply to read.
 * - `failed`: its turn errored, lost its lease twice, or was never queued. Never ready for review.
 */
export type StartedState =
  | "working"
  | "needs_input"
  | "ready_for_review"
  | "failed";

/** A suggestion the person started, with where it stands and where its results land. */
export type StartedSuggestion = Pick<
  ProactiveSuggestion,
  "id" | "agentId" | "title" | "detail" | "sourceApp" | "sourceLink"
> & {
  startedAt: Date;
  state: StartedState;
  /**
   * The next step, one line, in plain words: the reply's last sentence, the question it is waiting
   * on, or why it failed. Null when there is none to say.
   */
  next: string | null;
  /** The approval or question it stopped on, when the person's inbox also lists that request. */
  waitingOn: { kind: "approval" | "question"; id: string } | null;
  /** When the person checked it off. Null while it is still theirs to deal with. */
  resolvedAt: Date | null;
  /** When it last changed: started, finished, gave up, or was checked off. */
  at: Date;
  /** The conversation the turn runs in: its research setting's. */
  channelId: string;
};

/**
 * What the person started: everything not yet checked off, and the newest of what was, with how
 * many older checked-off ones were left out so a screen can say so rather than drop them quietly.
 */
export type StartedList = {
  started: StartedSuggestion[];
  olderResolved: number;
};

/** What a started suggestion's turn ended on, kept on its work queue row for Tasks. */
export type TaskOutcome = {
  /** The last sentence of its reply. */
  reply?: string | null;
  /** The request it stopped on, when it was suspended for one. */
  waiting?: { kind: string; id: string | null };
};

export class ProactiveRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProactiveRefusedError";
  }
}
export class ProactiveNotFoundError extends Error {
  constructor() {
    super("This could not be found.");
    this.name = "ProactiveNotFoundError";
  }
}

export function parseWith<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ProactiveRefusedError(
      result.error.issues[0]?.message ?? "Invalid settings.",
    );
  return result.data;
}
