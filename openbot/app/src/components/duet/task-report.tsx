import { describeApproval } from "@/lib/approval-view";
import type {
  ReportDecision,
  ReportEntry,
  ReportResource,
  TaskRecord,
  TaskReport,
} from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";
import { DuetIcon, type DuetIconName } from "./icons";

/*
 * A task's page, read as a report: when and why it was noticed (in the sheet's header), then
 * Decisions and updates as a timeline, then Resources, the emails and events it read, then Show
 * conversation, which unfolds the whole thread under it. The reply box stays at the foot.
 */

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const weekdayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "today at 9:41 AM", "yesterday at 9:41 AM", or "on Oct 20". Empty for a time that is not one. */
export function whenLine(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  if (sameDay(at, now)) return `today at ${timeFormat.format(at)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(at, yesterday)) return `yesterday at ${timeFormat.format(at)}`;
  return `on ${dayFormat.format(at)}`;
}

/**
 * The line under a task's title: how it began and when, then why. "Noticed today at 9:41 AM · Ana
 * needs an answer by Friday" for one OpenDuet found; "You asked today at 9:41 AM" for one asked for.
 */
export function noticedLine(
  task: Pick<TaskRecord, "origin" | "createdAt" | "why">,
  now = new Date(),
): string {
  const when = whenLine(task.createdAt, now);
  const how = task.origin === "asked" ? "You asked" : "Noticed";
  const opening = when ? `${how} ${when}` : how;
  const why = task.why?.trim();
  return why ? `${opening} · ${why}` : opening;
}

/** A stamp on a timeline row: the time today, the day before that. Empty when no ledger saw it. */
export function stampOf(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return sameDay(at, now) ? timeFormat.format(at) : dayFormat.format(at);
}

const VERDICT: Record<ReportDecision["decision"], string> = {
  allow_once: "Allowed once",
  allow_always: "Always allowed",
  deny: "Refused",
  handled: "You did it yourself",
};

/** "Allowed once: Send email to ana@hearthandco.com", named the way the approval card names it. */
export function decisionLine(entry: ReportDecision): string {
  const view = describeApproval({ action: entry.action as never });
  const to = view.fields.find((field) => field.label === "To")?.value;
  return `${VERDICT[entry.decision]}: ${view.title}${to ? ` to ${to}` : ""}`;
}

/** The name in "Ana Pereira <ana@…>", or the address when there is no name. */
export function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (!match) return from.trim();
  return match[1]?.trim() || match[2]?.trim() || from.trim();
}

/** "Fri 10:00 AM", for an event's start. An all-day date is its day. */
export function eventTime(start: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    const [year, month, day] = start.split("-").map(Number);
    return dayFormat.format(new Date(year ?? 0, (month ?? 1) - 1, day ?? 1));
  }
  const at = new Date(start);
  return Number.isFinite(at.getTime()) ? weekdayFormat.format(at) : start;
}

export function TaskReportView({
  report,
  pending,
  error,
  botName,
  conversationShown,
  onToggleConversation,
  now,
}: {
  report: TaskReport | undefined;
  pending: boolean;
  error: Error | null;
  botName: string;
  conversationShown: boolean;
  onToggleConversation: () => void;
  now?: Date;
}) {
  return (
    <div className="flex flex-col gap-6 pb-2">
      <section aria-labelledby="report-timeline">
        <ReportHeading id="report-timeline">
          Decisions and updates
        </ReportHeading>
        {pending ? null : error || !report ? (
          <p className="type-sub px-1 text-duet-red" role="alert">
            Couldn't load this task's report. Close it and try again.
          </p>
        ) : report.entries.length === 0 ? (
          <p className="type-sub px-1 text-duet-ink-2">
            Nothing yet. What {botName} decides and finds shows up here.
          </p>
        ) : (
          <Timeline entries={report.entries} now={now} />
        )}
      </section>
      <section aria-labelledby="report-resources">
        <ReportHeading id="report-resources">Resources</ReportHeading>
        {pending || error || !report ? null : report.resources.length === 0 ? (
          <p className="type-sub px-1 text-duet-ink-2">
            No emails or events read yet.
          </p>
        ) : (
          <ul className="flex flex-col overflow-hidden rounded-[18px] bg-duet-tile">
            {report.resources.map((resource, index) => (
              <li
                className={cn(index > 0 && "border-duet-hair-2 border-t")}
                key={`${resource.kind}:${resource.id}`}
              >
                <ResourceRow now={now} resource={resource} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <button
        aria-expanded={conversationShown}
        className="type-row flex h-12 items-center justify-between gap-3 rounded-[16px] px-4 font-semibold text-duet-ink shadow-[inset_0_0_0_1px_var(--duet-hair)] transition-colors hover:bg-duet-tile focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40"
        onClick={onToggleConversation}
        type="button"
      >
        {conversationShown ? "Hide conversation" : "Show conversation"}
        <DuetIcon
          className={cn(
            "text-duet-ink-3 transition-transform duration-200 motion-reduce:transition-none",
            conversationShown ? "-rotate-90" : "rotate-90",
          )}
          name="chevronRight"
          size={18}
          stroke={2.2}
        />
      </button>
    </div>
  );
}

function ReportHeading({ id, children }: { id: string; children: string }) {
  return (
    <h2
      className="type-label mb-2.5 px-1 font-semibold text-duet-ink-3 uppercase tracking-[0.04em]"
      id={id}
    >
      {children}
    </h2>
  );
}

const ENTRY_LOOK: Record<
  "allowed" | "refused" | "reply" | "update",
  { icon: DuetIconName; tone: string }
> = {
  allowed: { icon: "shieldCheck", tone: "bg-duet-green-soft text-duet-green" },
  refused: { icon: "x", tone: "bg-duet-red-soft text-duet-red" },
  reply: { icon: "chat", tone: "bg-duet-tile text-duet-ink-2" },
  update: { icon: "sparkle", tone: "bg-duet-violet-soft text-duet-violet" },
};

function lookOf(entry: ReportEntry) {
  if (entry.kind === "decision")
    return ENTRY_LOOK[entry.decision === "deny" ? "refused" : "allowed"];
  return ENTRY_LOOK[entry.kind];
}

/** The timeline: a mark for each entry on a thin line, what happened, and when. */
function Timeline({
  entries,
  now,
}: {
  entries: readonly ReportEntry[];
  now: Date | undefined;
}) {
  return (
    <ol aria-label="Decisions and updates" className="flex flex-col">
      {entries.map((entry, index) => {
        const look = lookOf(entry);
        const stamp = stampOf(entry.at, now);
        const last = index === entries.length - 1;
        return (
          <li
            className="relative flex gap-3 pb-3.5 last:pb-0"
            data-entry={entry.kind}
            key={`${entry.kind}:${entry.id}`}
          >
            {last ? null : (
              <span
                aria-hidden
                className="absolute top-8 bottom-0 left-[13px] w-px bg-duet-hair"
              />
            )}
            <span
              aria-hidden
              className={cn(
                "relative grid size-[27px] shrink-0 place-items-center rounded-full",
                look.tone,
              )}
            >
              <DuetIcon name={look.icon} size={15} stroke={2.1} />
            </span>
            <div className="min-w-0 flex-1 pt-[3px]">
              {entry.kind === "decision" ? (
                <>
                  <p className="type-sub font-semibold text-duet-ink">
                    {decisionLine(entry)}
                  </p>
                  <p className="type-label mt-0.5 text-duet-ink-3">
                    {stamp ? `By you · ${stamp}` : "By you"}
                  </p>
                </>
              ) : (
                <>
                  <p
                    className={cn(
                      "type-sub text-duet-ink",
                      entry.kind === "reply" && "text-duet-ink-2",
                    )}
                  >
                    {entry.kind === "reply" ? (
                      <>
                        <span className="font-semibold text-duet-ink">
                          You:
                        </span>{" "}
                        {entry.text}
                      </>
                    ) : (
                      entry.text
                    )}
                  </p>
                  {stamp ? (
                    <p className="type-label mt-0.5 text-duet-ink-3">{stamp}</p>
                  ) : null}
                </>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** One email or event it read: who or what, the subject or when, and a link out when there is one. */
function ResourceRow({
  resource,
  now,
}: {
  resource: ReportResource;
  now: Date | undefined;
}) {
  const email = resource.kind === "email";
  const primary = email
    ? senderName(resource.from) || "Unknown sender"
    : resource.title;
  const secondary = email
    ? resource.subject || "(no subject)"
    : [eventTime(resource.start), resource.location]
        .filter(Boolean)
        .join(" · ");
  const stamp = email ? stampOf(resource.at, now) : "";
  const body = (
    <>
      <span
        aria-hidden
        className="grid size-9 shrink-0 place-items-center rounded-full bg-duet-card text-duet-ink-2 shadow-duet-card"
      >
        <DuetIcon name={email ? "mail" : "calendar"} size={17} stroke={1.9} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="type-sub block truncate font-semibold text-duet-ink">
          {primary}
        </span>
        <span className="type-label block truncate text-duet-ink-2">
          {secondary}
        </span>
      </span>
      {stamp ? (
        <span className="type-label shrink-0 text-duet-ink-3">{stamp}</span>
      ) : null}
      {resource.link ? (
        <DuetIcon
          className="shrink-0 text-duet-ink-3"
          name="arrowRight"
          size={16}
          stroke={2.1}
        />
      ) : null}
    </>
  );
  const row = "flex min-h-[60px] items-center gap-3 px-3.5 py-2.5";
  return resource.link ? (
    <a
      aria-label={`${email ? "Open the email from" : "Open"} ${primary}: ${secondary}`}
      className={cn(
        row,
        "outline-none transition-colors hover:bg-duet-hair-2 focus-visible:ring-3 focus-visible:ring-duet-violet/40 focus-visible:ring-inset",
      )}
      href={resource.link}
      rel="noreferrer"
      target="_blank"
    >
      {body}
    </a>
  ) : (
    <div className={row}>{body}</div>
  );
}
