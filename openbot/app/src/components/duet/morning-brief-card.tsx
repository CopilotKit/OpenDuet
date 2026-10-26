import { Fragment } from "react";
import { cn } from "@/lib/utils";
import type { DuetIconName } from "./icons";
import { DuetIcon } from "./icons";
import { CardRow, DuetCard, Rule, SectionLabel } from "./kit";

/** One line of the brief: what it is, and one line on why. */
export type BriefItem = {
  id: string;
  icon: DuetIconName;
  title: string;
  why: string;
  /** Where the row leads. A row with nowhere to go draws no chevron. */
  href?: string;
  /** Something the person can do about this row from the card, such as handing it to the Bot. */
  action?: BriefAction;
};

/** A line of text under the row's why. `done` replaces the label once it has been pressed. */
export type BriefAction = {
  label: string;
  /** What a screen reader hears, naming the row, since "Start" alone says nothing about which. */
  name: string;
  onPress: () => void;
  done?: string;
  disabled?: boolean;
};

/**
 * The film's morning brief: the date, a greeting, what needs the person today, what can wait, and
 * the day's calendar. Drawn from the `morning_brief` tool's result (see morning-brief-tool.tsx), so
 * every row is something that tool read and sorted; nothing renders it with made-up rows.
 *
 * `notes` are the sources it could not check. They are part of the card, not a footnote somewhere
 * else, because a brief that is quiet about Gmail could mean "nothing came in" or "Gmail is not
 * connected", and the person has to be able to tell which.
 */
export function MorningBriefCard({
  date,
  greeting,
  needsYou,
  canWait,
  today = [],
  notes = [],
}: {
  /** "Thursday, October 22". */
  date: string;
  /** "Morning, Maya." */
  greeting: string;
  needsYou: BriefItem[];
  canWait: BriefItem[];
  today?: BriefItem[];
  notes?: BriefItem[];
}) {
  const nothing =
    needsYou.length === 0 && canWait.length === 0 && today.length === 0;
  return (
    <DuetCard aria-label="Morning brief" role="region">
      <div className="px-4 pt-[18px]">
        <p className="type-sub font-medium text-duet-ink-2">{date}</p>
        <p className="type-display mt-0.5 font-semibold">{greeting}</p>
        {nothing && notes.length === 0 ? (
          <p className="type-sub mt-2 text-duet-ink-2">
            Nothing new needs you, and nothing is on your calendar today.
          </p>
        ) : null}
      </div>
      <BriefSection items={needsYou} label="Needs you" tone="accent" />
      <BriefSection items={canWait} label="Can wait" tone="muted" />
      <BriefSection items={today} label="Today" tone="muted" />
      <BriefSection items={notes} label="Couldn't check" tone="muted" />
      <div className="h-2" />
    </DuetCard>
  );
}

function BriefSection({
  label,
  items,
  tone,
}: {
  label: string;
  items: BriefItem[];
  tone: "accent" | "muted";
}) {
  if (items.length === 0) return null;
  return (
    <section className="mt-4">
      <SectionLabel tone={tone}>{label}</SectionLabel>
      <ul className="mt-1.5">
        {items.map((item, index) => {
          const row = (
            <CardRow
              detail={item.why}
              icon={item.icon}
              title={item.title}
              tone={tone === "accent" ? "violet" : "neutral"}
              below={
                item.action ? <RowAction action={item.action} /> : undefined
              }
              trailing={
                item.href ? (
                  <span className="text-duet-ink-3">
                    <DuetIcon name="chevronRight" size={18} stroke={2.2} />
                  </span>
                ) : undefined
              }
            />
          );
          return (
            <Fragment key={item.id}>
              {index > 0 ? <Rule inset /> : null}
              <li>
                {item.href ? (
                  <a
                    className="block"
                    href={item.href}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {row}
                  </a>
                ) : (
                  row
                )}
              </li>
            </Fragment>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The row's action as a line of text under its why. A pill in its own column left the title and
 * the why a narrow strip on a phone; as text it reads as the row's next step.
 */
function RowAction({ action }: { action: BriefAction }) {
  const done = action.done !== undefined;
  return (
    <button
      aria-label={action.done ?? action.name}
      // 44px to tap (parity-spec 2.11) with the box pulled back by the margins, so the text sits
      // as close under the why as a line would; weight 500, as buttons are (2.3).
      className={cn(
        "type-sub -mx-2 -my-2.5 inline-flex h-11 items-center gap-1 rounded-full px-2 font-medium transition-opacity focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40",
        done
          ? "text-duet-status-done"
          : "text-duet-accent hover:opacity-80 active:opacity-60 disabled:text-duet-ink-3 disabled:hover:opacity-100",
      )}
      disabled={action.disabled || done}
      onClick={action.onPress}
      type="button"
    >
      {done ? <DuetIcon name="check" size={15} stroke={2.4} /> : null}
      {action.done ?? action.label}
      {done ? null : <DuetIcon name="arrowRight" size={15} stroke={2.4} />}
    </button>
  );
}
