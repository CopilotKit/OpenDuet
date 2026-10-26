import { useRenderTool } from "@copilotkit/react-core/v2";
import { readConnectPrompt } from "@openbot/shared/connect-prompt";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { AppAccessCard } from "@/components/channels/app-access-card";
import { useConversationSend } from "@/components/channels/conversation-send";
import { ToolLine } from "@/components/channels/tool-line";
import {
  BuildIn,
  BuildInProvider,
  useArrivedLive,
} from "@/components/duet/build-in";
import {
  type BriefItem,
  briefPieceCount,
  MorningBriefCard,
} from "@/components/duet/morning-brief-card";
import {
  BRIEF_EMAIL_SOURCE,
  MORNING_BRIEF_TOOL,
} from "@/lib/channels/morning-brief";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { readToolName } from "@/lib/plugins/tool-name";
import {
  type EmailHandOff,
  startEmailTaskMutationOptions,
} from "@/lib/tasks/mutations";
import { type TaskRecord, taskListQueryOptions } from "@/lib/tasks/queries";

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
    .array(
      z.object({
        source: z.string(),
        why: z.string(),
        // The app to connect, when that is the fix (server/src/openduet/brief.ts, `gapOf`).
        connect: z
          .object({
            serverId: z.string().min(1),
            title: z.string().min(1),
            agentId: z.string().min(1).optional(),
            reason: z
              .enum(["connect", "reconnect", "shared", "access"])
              .optional(),
            at: z.string().optional(),
          })
          .optional()
          .catch(undefined),
      }),
    )
    .default([]),
  /**
   * Which sources were read. Absent on a brief made before it was sent, which is drawn as such a
   * brief always was: nothing said about a quiet source unless the whole card is quiet.
   */
  read: z.object({ gmail: z.boolean(), calendar: z.boolean() }).optional(),
});
export type Brief = z.infer<typeof briefSchema>;
type Gap = Brief["couldNotCheck"][number];

/**
 * What could not be checked, each app to connect once and none of them the refusal's raw marker.
 *
 * A brief made before the server read the marker itself has it in `why`, verbatim and twice, Gmail's
 * and Calendar's, and threads keep those briefs for good: drawn as stored they read
 * `[connect-app]{"serverId":…} You have not connected…` every time Chat is scrolled back. They are
 * read here the way the server reads one now, so an old brief and a new one say the same thing.
 */
export function gapsOf(brief: Brief): Gap[] {
  const gaps: Gap[] = [];
  for (const gap of brief.couldNotCheck) {
    const prompt = gap.connect ? null : readConnectPrompt(gap.why);
    const read: Gap = prompt
      ? {
          source: prompt.title,
          // The server's words for the same refusal (`connectWhy` in server/src/openduet/brief.ts).
          why:
            prompt.reason === "reconnect"
              ? "Needs reconnecting."
              : prompt.reason === "shared"
                ? "Your organisation's account isn't connected yet."
                : "Not connected yet.",
          connect: {
            serverId: prompt.serverId,
            title: prompt.title,
            ...(prompt.agentId ? { agentId: prompt.agentId } : {}),
            ...(prompt.reason ? { reason: prompt.reason } : {}),
            ...(prompt.at ? { at: prompt.at } : {}),
          },
        }
      : gap;
    const serverId = read.connect?.serverId;
    if (serverId && gaps.some((seen) => seen.connect?.serverId === serverId))
      continue;
    gaps.push(read);
  }
  return gaps;
}

/**
 * The card's line for a source read and found empty, or null when there is nothing to say.
 *
 * READ AND EMPTY IS AN ALL-CLEAR; NOT READ IS NOTHING. A morning with Gmail connected and nothing new
 * drew the card with Today alone, and the Bot, reading `checked.mail: 0`, said no messages were
 * checked so it wasn't an all-clear. The server now says which sources it read (`read`), and the card
 * says plainly what came of each one it read and found nothing in. A source it could not read says
 * so under Couldn't check instead, and never reads as quiet.
 */
export function quietLine(brief: Brief): string | null {
  if (!brief.read) return null;
  const noMail =
    brief.read.gmail && brief.needsYou.length === 0 && !brief.canWait.length;
  const noEvents = brief.read.calendar && brief.calendar.length === 0;
  if (noMail && noEvents)
    return "Nothing new came in, and nothing is on your calendar today.";
  if (noMail) return "Nothing new came in to your inbox.";
  if (noEvents) return "Nothing is on your calendar today.";
  return null;
}

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
  /** See `quietLine`; undefined for a brief that never said what it read. */
  quiet?: string | null;
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
    /*
     * What was sorted as needing the person first, and what could not be sorted after it. Those
     * are only here to be safe, and the card shows its first few rows before "Show more", so they
     * should not take those places from mail that does need the person.
     */
    needsYou: [...brief.needsYou]
      .sort(
        (a, b) =>
          Number(a.decidedBy === "unsorted") -
          Number(b.decidedBy === "unsorted"),
      )
      .map((item) => ({
        id: item.id,
        title: item.subject ? `${item.from} · ${item.subject}` : item.from,
        why: item.reason,
      })),
    canWait: brief.canWait.length
      ? [
          {
            id: "can-wait",
            title: `${brief.canWait.length} ${brief.canWait.length === 1 ? "email" : "emails"} can wait`,
            why: rest > 0 ? `${named} and ${rest} more` : named,
          },
        ]
      : [],
    today: brief.calendar.map((event) => ({
      id: event.id,
      title: event.summary,
      why: [timeOf(event.start), event.location].filter(Boolean).join(" · "),
    })),
    notes: gapsOf(brief).map((gap, index) => ({
      id: `gap-${index}`,
      title: gap.source,
      why: gap.why,
    })),
    ...(brief.read ? { quiet: quietLine(brief) } : {}),
  };
}

const TOOL = MORNING_BRIEF_TOOL;
const parameters = z.object({ since: z.string().optional() });

export function MorningBriefTool() {
  useRenderTool({
    name: TOOL,
    parameters,
    render: ({ result, status }) => (
      <BriefToolView
        result={result}
        running={status !== "complete" && result === undefined}
      />
    ),
  });
  return null;
}

/**
 * The tool's line while it reads, then the card. One component for both, so it can tell a brief
 * that arrived while the person watched, which builds in row by row, from one read back from
 * history, which is drawn whole (components/duet/build-in.tsx).
 */
function BriefToolView({
  result,
  running,
}: {
  result: unknown;
  running: boolean;
}) {
  const live = useArrivedLive(running);
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
  return (
    <BuildInProvider value={live}>
      <StartableBrief brief={brief} />
    </BuildInProvider>
  );
}

/**
 * What Start sends the server for a row that needs the person: the email by its id, and what the row
 * shows of it for the task's title. The server writes the task's ask from the id alone, so nothing a
 * sender wrote reaches the model as the person's words (`emailTask` in server/src/openduet/tasks.ts).
 */
export function emailHandOff(
  item: Brief["needsYou"][number],
  botId: string,
): EmailHandOff {
  return {
    botId,
    messageId: item.id,
    from: item.from,
    subject: item.subject,
    ...(item.reason.trim() ? { why: item.reason.trim() } : {}),
  };
}

/** The emails the person already has a task for, by message id, out of their tasks. */
export function startedEmails(
  tasks: readonly Pick<TaskRecord, "sourceApp" | "sourceRef">[] | undefined,
): ReadonlySet<string> {
  return new Set(
    (tasks ?? []).flatMap((task) =>
      task.sourceApp === BRIEF_EMAIL_SOURCE && task.sourceRef
        ? [task.sourceRef]
        : [],
    ),
  );
}

/**
 * The brief with Start on each row that needs the person, and the connect card for any app it could
 * not read. Outside a conversation, or before the surface has said which Bot it drives, the rows
 * draw no button: there is no Bot to hand the email to.
 *
 * START OPENS A TASK. It hands the email to a task of its own on the server, the way Start on a
 * check-in's card starts its task, and the task is then on Tasks with its status like any other.
 *
 * STARTED IS READ FROM THE TASKS, NOT REMEMBERED HERE. It was component state, so a reload, another
 * tab or the person's phone drew Start again on an email already handed off, and a second press
 * started it twice. A task opened for an email carries the email's id (`sourceRef`), so a row is
 * Started exactly when the person has a task for that email, on every device and after every reload;
 * the server answers a second press with the first task, so a press before the list arrives is safe
 * too. The press itself is remembered only until the list catches up, so the row never flickers back
 * to Start in between.
 */
export function StartableBrief({ brief }: { brief: Brief }) {
  const conversation = useConversationSend();
  const botId = useDeclaredBotId();
  const startable = conversation !== null && botId !== undefined;
  const queryClient = useQueryClient();
  const tasks = useQuery({
    ...taskListQueryOptions(),
    enabled: startable && brief.needsYou.length > 0,
  });
  const start = useMutation(startEmailTaskMutationOptions(queryClient));
  const [pressed, setPressed] = useState<
    ReadonlyMap<string, "starting" | "started" | "failed">
  >(new Map());
  const mark = (id: string, state: "starting" | "started" | "failed") =>
    setPressed((current) => new Map(current).set(id, state));
  const started = startedEmails(tasks.data);
  const card = briefCard(brief);
  // By id, not position: the card puts mail that could not be sorted last.
  const mailById = new Map(brief.needsYou.map((item) => [item.id, item]));
  const needsYou =
    startable && botId
      ? card.needsYou.map((row) => {
          const item = mailById.get(row.id);
          if (!item) return row;
          const state = started.has(row.id) ? "started" : pressed.get(row.id);
          return {
            ...row,
            action: {
              label:
                state === "starting"
                  ? "Starting"
                  : state === "failed"
                    ? "Couldn't start · Try again"
                    : "Start",
              name: `Start: ${row.title}`,
              ...(state === "started" ? { done: "Started" } : {}),
              ...(state === "starting" ? { disabled: true } : {}),
              onPress: () => {
                mark(row.id, "starting");
                start
                  .mutateAsync(emailHandOff(item, botId))
                  .then(() => mark(row.id, "started"))
                  .catch(() => mark(row.id, "failed"));
              },
            },
          };
        })
      : card.needsYou;
  const connects = gapsOf(brief).flatMap((gap) =>
    gap.connect ? [gap.connect] : [],
  );
  return (
    <>
      <MorningBriefCard {...card} needsYou={needsYou} />
      {connects.map((connect) => (
        // After the card's last piece, so the button arrives under what it fixes.
        <BuildIn key={connect.serverId} order={briefPieceCount(card)}>
          <AppAccessCard
            prompt={{
              ...connect,
              message: `Connect ${connect.title} and the next brief can read it.`,
            }}
          />
        </BuildIn>
      ))}
    </>
  );
}
