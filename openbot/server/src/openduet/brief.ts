import { MORNING_BRIEF_TOOL } from "@openbot/shared/morning-brief";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import type { AuditInitiator } from "../audit";
import { z } from "zod";
import {
  type Complete,
  type TriageMessage,
  type TriagePerson,
  triage,
} from "./triage";

/*
 * The morning brief: what needs the person today, each with why, what can wait, today's calendar,
 * and what could not be checked.
 *
 * One server tool rather than a prompt that strings connector calls together, because the sorting
 * has to be the same sorting evals/triage measures, and because the honest parts (an app that is
 * not connected, a message the model could not sort) are easy for a model to smooth over and easy
 * for code to report. The Bot's part is the conversation around the brief, not the brief.
 *
 * It reads Gmail and Calendar through the plugin store, as the person and under the Bot's grants,
 * so a brief can only ever contain what this Bot was granted and this person connected.
 */

/** Declared with the frame that asks for it (shared/morning-brief.ts), which names it to the model. */
export const BRIEF_TOOL = MORNING_BRIEF_TOOL;
export const GMAIL_SEARCH = "google-workspace/gmail_search_messages";
export const CALENDAR_LIST = "google-workspace/calendar_list_events";

export type BriefMail = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  reason: string;
  /** `rule:<id>`, `model:<name>`, or `unsorted` when sorting failed and it is shown to be safe. */
  decidedBy: string;
};

export type BriefEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
};

export type MorningBrief = {
  /** ISO 8601, when the brief was made. */
  at: string;
  /** The first name to greet, when known. */
  name: string | null;
  needsYou: BriefMail[];
  canWait: BriefMail[];
  calendar: BriefEvent[];
  /** Each source that could not be read, and why, in words the person can act on. */
  couldNotCheck: { source: string; why: string }[];
  checked: { mail: number; byRules: number; byModel: number };
};

export type CallTool = (input: {
  ref: string;
  args: Record<string, unknown>;
  botId: string;
  actorId: string;
  initiator: AuditInitiator;
}) => Promise<{ text: string; isError: boolean }>;

const searchedMessage = z.object({
  id: z.string(),
  threadId: z.string().default(""),
  from: z.string().default(""),
  to: z.array(z.string()).default([]),
  cc: z.array(z.string()).default([]),
  subject: z.string().default(""),
  date: z.string().default(""),
  snippet: z.string().default(""),
  labels: z.array(z.string()).default([]),
  headers: z.record(z.string(), z.string()).default({}),
});
const searchResult = z.object({
  messages: z.array(searchedMessage).default([]),
  /** Gmail's estimate of how many messages matched, before the cap. */
  resultSizeEstimate: z.number().nullable().optional(),
});

/**
 * How many of the window's messages the brief reads and sorts, the most the search tool returns.
 *
 * It was 25, and a real brief left out a direct "rotate your credentials" notice from 20 hours
 * earlier: a working inbox gets more than 25 messages a day, the search returns the newest first,
 * and the oldest ones fell off the end with nothing said. More messages cost more sorting, so the
 * cap stays, but a window that held more than it is now said out loud under could not check.
 */
export const BRIEF_MAIL_CAP = 50;
const calendarResult = z.object({
  events: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().default("(no title)"),
        start: z.string().default(""),
        end: z.string().default(""),
        location: z.string().optional(),
      }),
    )
    .default([]),
});

/** What went wrong, in a sentence: the plugin store's refusals already are one. */
function why(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Refused\.\s*/, "").slice(0, 300);
}

/** `Ana Pereira <ana@x>` reads as "Ana Pereira"; a bare address stays an address. */
export function displayName(from: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  return (named?.[1] ?? from).trim();
}

const ADDRESS = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

/**
 * Whose inbox this is. The sign-in address is the best answer when it is a real one that the mail is
 * addressed to; in single-user mode it is a placeholder, so otherwise the address the most messages
 * were sent to stands in. Only used to tell "sent to you" from "you were copied".
 */
export function inboxOwner(
  signedInAs: string | null,
  messages: readonly { to: string[]; cc: string[] }[],
): string | null {
  const counts = new Map<string, number>();
  for (const message of messages)
    for (const recipient of [...message.to, ...message.cc]) {
      const address = ADDRESS.exec(recipient)?.[0]?.toLowerCase();
      if (address) counts.set(address, (counts.get(address) ?? 0) + 1);
    }
  const own = signedInAs?.toLowerCase();
  if (own && counts.has(own)) return own;
  let best: string | null = null;
  for (const [address, count] of counts)
    if (!best || count > (counts.get(best) ?? 0)) best = address;
  return best ?? own ?? null;
}

/**
 * The first name the card greets. A single-user install keeps the sign-in email as the person's
 * name, and "Afternoon, dev@openbot.local." greets an address; with no name the card says
 * "Afternoon." instead.
 */
export function firstNameOf(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first && !first.includes("@") ? first : null;
}

async function inParallel<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++)
        results[index] = await work(items[index] as T);
    }),
  );
  return results;
}

export async function buildMorningBrief(
  deps: {
    callTool: CallTool;
    complete: Complete;
    model: string;
    now?: () => Date;
  },
  input: {
    actorId: string;
    botId: string;
    initiator: AuditInitiator;
    person: { name: string | null; email: string | null };
    since?: string;
  },
): Promise<MorningBrief> {
  const now = deps.now?.() ?? new Date();
  const call = (ref: string, args: Record<string, unknown>) =>
    deps.callTool({
      ref,
      args,
      botId: input.botId,
      actorId: input.actorId,
      initiator: input.initiator,
    });
  const couldNotCheck: MorningBrief["couldNotCheck"] = [];
  const brief: MorningBrief = {
    at: now.toISOString(),
    name: firstNameOf(input.person.name),
    needsYou: [],
    canWait: [],
    calendar: [],
    couldNotCheck,
    checked: { mail: 0, byRules: 0, byModel: 0 },
  };

  let messages: z.infer<typeof searchedMessage>[] = [];
  try {
    const result = await call(GMAIL_SEARCH, {
      query: `in:inbox newer_than:${input.since ?? "1d"}`,
      maxResults: BRIEF_MAIL_CAP,
    });
    if (result.isError)
      couldNotCheck.push({ source: "Gmail", why: why(result.text) });
    else {
      const found = searchResult.parse(JSON.parse(result.text));
      messages = found.messages;
      const matched = found.resultSizeEstimate ?? 0;
      if (messages.length >= BRIEF_MAIL_CAP && matched > messages.length)
        couldNotCheck.push({
          source: "Gmail",
          why: `Only the newest ${messages.length} of about ${matched} messages from this window were sorted. Older ones were not checked.`,
        });
    }
  } catch (error) {
    couldNotCheck.push({ source: "Gmail", why: why(error) });
  }

  const owner = inboxOwner(input.person.email, messages);
  const person: TriagePerson = {
    name: input.person.name ?? owner ?? "the person",
    email: owner ?? "",
  };
  /*
   * Eight at a time. Reading 50 rather than 25 doubles the messages the model sorts, and at four
   * at a time a fifty-message morning took about 50 seconds against the fake mailbox; eight keeps
   * the brief near what 25 cost. Each sort is one small call, so this is well inside a provider's
   * rate limits for one person.
   */
  const sorted = await inParallel(messages, 8, async (message) => {
    const asTriage: TriageMessage = {
      id: message.id,
      from: message.from,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      date: message.date,
      headers: message.headers,
      labels: message.labels,
      // The snippet is what search returns. Enough to sort by; the Bot reads the whole message
      // before it drafts anything.
      body: message.snippet,
    };
    try {
      return {
        message,
        result: await triage(asTriage, person, {
          complete: deps.complete,
          model: deps.model,
          now: () => now,
        }),
      };
    } catch (error) {
      return { message, error: why(error) };
    }
  });

  const failures: string[] = [];
  for (const entry of sorted) {
    const item = {
      id: entry.message.id,
      threadId: entry.message.threadId,
      from: displayName(entry.message.from),
      subject: entry.message.subject,
    };
    if (!("result" in entry) || !entry.result) {
      // Never hidden: a message that could not be sorted is shown as needing the person.
      failures.push(entry.error ?? "unknown error");
      brief.needsYou.push({
        ...item,
        reason: "Could not be sorted, so it is here to be safe.",
        decidedBy: "unsorted",
      });
      continue;
    }
    const { verdict, reason, decidedBy } = entry.result;
    (verdict === "needs_you" ? brief.needsYou : brief.canWait).push({
      ...item,
      reason,
      decidedBy,
    });
    if (decidedBy.startsWith("rule:")) brief.checked.byRules++;
    else brief.checked.byModel++;
  }
  brief.checked.mail = messages.length;
  if (failures.length)
    couldNotCheck.push({
      source: "Sorting",
      why: `${failures.length} of ${messages.length} messages could not be sorted (${failures[0]}). They are listed under needs you.`,
    });

  try {
    const result = await call(CALENDAR_LIST, {});
    if (result.isError)
      couldNotCheck.push({ source: "Google Calendar", why: why(result.text) });
    else brief.calendar = calendarResult.parse(JSON.parse(result.text)).events;
  } catch (error) {
    couldNotCheck.push({ source: "Google Calendar", why: why(error) });
  }
  return brief;
}

/** The brief as a tool the Bot holds. Held by every Bot; it reads only what the Bot was granted. */
export function openduetTools(options: {
  actorId: string;
  botId: string;
  initiator: AuditInitiator;
  person: () => Promise<{ name: string | null; email: string | null }>;
  build: (
    input: Parameters<typeof buildMorningBrief>[1],
  ) => Promise<MorningBrief>;
}): GrantedTool[] {
  const parameters = z
    .object({
      since: z
        .enum(["12h", "1d", "2d", "3d", "7d"])
        .optional()
        .describe("How far back to look in the inbox. Defaults to 1d."),
    })
    .strict();
  return [
    {
      name: BRIEF_TOOL,
      ref: `openduet/${BRIEF_TOOL}`,
      description: [
        "Build the person's morning brief from their connected Gmail and Google Calendar: what needs them today, each with a one-line reason, what can wait, today's calendar, and what could not be checked and why.",
        "The app shows the result as a card, so do not repeat it. After calling it, write at most two short sentences: the most important thing, and one offer of help, such as drafting a reply.",
        "Never claim to have checked a source listed under couldNotCheck; say what is missing and how to connect it.",
      ].join(" "),
      parameters,
      initiator: options.initiator,
      async execute(args) {
        const parsed = parameters.safeParse(args ?? {});
        if (!parsed.success) return "Refused. Invalid morning_brief arguments.";
        const brief = await options.build({
          actorId: options.actorId,
          botId: options.botId,
          initiator: options.initiator,
          person: await options.person(),
          ...(parsed.data.since ? { since: parsed.data.since } : {}),
        });
        return JSON.stringify(brief);
      },
    },
  ];
}
