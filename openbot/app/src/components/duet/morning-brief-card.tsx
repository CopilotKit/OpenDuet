import { Fragment } from "react";
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
        <p className="mt-0.5 font-semibold text-[23px] leading-[27px] tracking-[-0.018em]">
          {greeting}
        </p>
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
