import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import {
  type BriefItem,
  MorningBriefCard,
} from "@/components/duet/morning-brief-card";
import { readToolName } from "@/lib/plugins/tool-name";

/*
 * Draws the server's `morning_brief` tool as the film's brief card. The tool runs on the server
 * (server/src/openduet/brief.ts), where the sorting is the same sorting evals/triage measures; this
 * only draws what it returned.
 */

const mail = z.object({
  id: z.string(),
  threadId: z.string().default(""),
  from: z.string(),
  subject: z.string().default(""),
  reason: z.string(),
  decidedBy: z.string().default(""),
});
export const briefSchema = z.object({
  at: z.string(),
  name: z.string().nullable().default(null),
  needsYou: z.array(mail).default([]),
  canWait: z.array(mail).default([]),
  calendar: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string(),
        start: z.string(),
        end: z.string().default(""),
        location: z.string().optional(),
      }),
    )
    .default([]),
  couldNotCheck: z
    .array(z.object({ source: z.string(), why: z.string() }))
    .default([]),
});
export type Brief = z.infer<typeof briefSchema>;

/** The tool's result, or null when it is a refusal or not a brief. */
export function readBrief(result: unknown): Brief | null {
  if (typeof result !== "string") return null;
  try {
    let value: unknown = JSON.parse(result);
    // A server tool's text can arrive JSON-encoded once more on the way through the runtime.
    if (typeof value === "string") value = JSON.parse(value);
    const parsed = briefSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function greetingFor(at: Date, name: string | null): string {
  const hour = at.getHours();
  const part = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  return name ? `${part}, ${name}.` : `${part}.`;
}

/** "3:00 PM" for a timed event, "All day" for a date. */
function timeOf(start: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return "All day";
  const when = new Date(start);
  return Number.isNaN(when.getTime())
    ? start
    : when.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
}

/** The card's rows. Can wait folds into one row: the film's "I'll handle these", not a second inbox. */
export function briefCard(brief: Brief): {
  date: string;
  greeting: string;
  needsYou: BriefItem[];
  canWait: BriefItem[];
  today: BriefItem[];
  notes: BriefItem[];
} {
  const at = new Date(brief.at);
  const senders = [...new Set(brief.canWait.map((item) => item.from))];
  const named = senders.slice(0, 3).join(", ");
  const rest = senders.length - 3;
  return {
    date: at.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
    greeting: greetingFor(at, brief.name),
    needsYou: brief.needsYou.map((item) => ({
      id: item.id,
      icon: "mail",
      title: item.subject ? `${item.from} · ${item.subject}` : item.from,
      why: item.reason,
    })),
    canWait: brief.canWait.length
      ? [
          {
            id: "can-wait",
            icon: "mail",
            title: `${brief.canWait.length} ${brief.canWait.length === 1 ? "email" : "emails"} can wait`,
            why: rest > 0 ? `${named} and ${rest} more` : named,
          },
        ]
      : [],
    today: brief.calendar.map((event) => ({
      id: event.id,
      icon: "clock",
      title: event.summary,
      why: [timeOf(event.start), event.location].filter(Boolean).join(" · "),
    })),
    notes: brief.couldNotCheck.map((gap, index) => ({
      id: `gap-${index}`,
      icon: "question",
      title: gap.source,
      why: gap.why,
    })),
  };
}

const TOOL = "morning_brief";
const parameters = z.object({ since: z.string().optional() });

export function MorningBriefTool() {
  useRenderTool({
    name: TOOL,
    parameters,
    render: ({ result, status }) => {
      const running = status !== "complete" && result === undefined;
      if (running)
        return <ToolLine label={readToolName(TOOL, true).label} running />;
      const brief = readBrief(result);
      if (!brief)
        return (
          <ToolLine
            label="Couldn't make the brief"
            detail={typeof result === "string" ? result : undefined}
            refused
          />
        );
      return <MorningBriefCard {...briefCard(brief)} />;
    },
  });
  return null;
}
