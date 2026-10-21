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
};

/**
 * The film's morning brief: the date, a greeting, what needs the person today and what can wait.
 *
 * NOT USED YET, ON PURPOSE. Slice 2's triage is what decides "needs you" and "can wait", and until it
 * exists there is nothing true to put in either section. It is here so slice 2 has the film's card to
 * fill; nothing renders it, and nothing may render it with made-up rows.
 */
export function MorningBriefCard({
  date,
  greeting,
  needsYou,
  canWait,
}: {
  /** "Thursday, October 22". */
  date: string;
  /** "Morning, Maya." */
  greeting: string;
  needsYou: BriefItem[];
  canWait: BriefItem[];
}) {
  return (
    <DuetCard aria-label="Morning brief" role="region">
      <div className="px-4 pt-[18px]">
        <p className="type-sub font-medium text-duet-ink-2">{date}</p>
        <p className="mt-0.5 font-semibold text-[23px] leading-[27px] tracking-[-0.018em]">
          {greeting}
        </p>
      </div>
      <BriefSection items={needsYou} label="Needs you" tone="accent" />
      <BriefSection items={canWait} label="Can wait" tone="muted" />
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
        {items.map((item, index) => (
          <Fragment key={item.id}>
            {index > 0 ? <Rule inset /> : null}
            <li>
              <CardRow
                detail={item.why}
                icon={item.icon}
                title={item.title}
                tone={tone === "accent" ? "violet" : "neutral"}
                trailing={
                  <span className="text-duet-ink-3">
                    <DuetIcon name="chevronRight" size={18} stroke={2.2} />
                  </span>
                }
              />
            </li>
          </Fragment>
        ))}
      </ul>
    </section>
  );
}
