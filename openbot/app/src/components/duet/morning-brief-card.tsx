import { AnimatePresence, motion } from "motion/react";
import { Fragment, type ReactNode, useState } from "react";
import { DURATION, EASE_OUT } from "@/lib/motion";
import { useReducedMotionPreference } from "@/lib/reduced-motion";
import { cn } from "@/lib/utils";
import { BuildIn } from "./build-in";
import { DuetIcon } from "./icons";
import { CardRow, DuetCard, Rule, SectionLabel } from "./kit";

/**
 * One line of the brief: what it is, and one line on why.
 *
 * NO ICON. Every row in a section is the same kind of thing (mail under "Needs you", events under
 * "Today"), so a tile on each repeated the section's label down the left and took width the title
 * and the why needed on a phone.
 */
export type BriefItem = {
  id: string;
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
  /*
   * Where each section starts in the order the card builds in when it arrives live (build-in.tsx):
   * the date and greeting first, then each section's label and the rows it shows, top to bottom.
   */
  const sections = [
    { items: needsYou, label: "Needs you", tone: "accent" },
    { items: canWait, label: "Can wait", tone: "muted" },
    { items: today, label: "Today", tone: "muted" },
    { items: notes, label: "Couldn't check", tone: "muted" },
  ] as const;
  let next = 1;
  const starts = sections.map((section) => {
    const start = next;
    next += piecesOf(section.items);
    return start;
  });
  return (
    <BuildIn order={0}>
      <DuetCard aria-label="Morning brief" role="region">
        <BuildIn className="px-4 pt-[18px]" order={0}>
          <p className="type-sub font-medium text-duet-ink-2">{date}</p>
          <p className="type-display mt-0.5 font-semibold">{greeting}</p>
          {nothing && notes.length === 0 ? (
            <p className="type-sub mt-2 text-duet-ink-2">
              Nothing new needs you, and nothing is on your calendar today.
            </p>
          ) : null}
        </BuildIn>
        {sections.map((section, index) => (
          <BriefSection
            items={section.items}
            key={section.label}
            label={section.label}
            start={starts[index] ?? 0}
            tone={section.tone}
          />
        ))}
        <div className="h-2" />
      </DuetCard>
    </BuildIn>
  );
}

/**
 * The rows a section shows before "Show N more". A day of mail can sort dozens into "Needs you",
 * and 27 rows on a phone are a second inbox, not a brief. Every row is still one tap away rather
 * than dropped. A section only one row over is shown whole, since "Show 1 more" saves nothing.
 */
export const SECTION_ROWS = 5;

/** The rows a section shows before anything is pressed. */
function firstShown(items: BriefItem[]): number {
  return items.length > SECTION_ROWS + 1 ? SECTION_ROWS : items.length;
}

/** How many pieces a section builds in with: its label, the rows it shows, and "Show N more". */
function piecesOf(items: BriefItem[]): number {
  if (items.length === 0) return 0;
  const shown = firstShown(items);
  return 1 + shown + (shown < items.length ? 1 : 0);
}

function BriefSection({
  label,
  items,
  tone,
  start,
}: {
  label: string;
  items: BriefItem[];
  tone: "accent" | "muted";
  /** Where this section's label falls in the card's build-in order. */
  start: number;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const folded = !open && items.length > SECTION_ROWS + 1;
  const shown = folded ? items.slice(0, SECTION_ROWS) : items;
  const hidden = items.length - shown.length;
  // Rows "Show N more" reveals were not part of the card's arrival, so they are drawn as they are.
  const arrived = firstShown(items);
  const piece = (index: number, node: ReactNode) =>
    index < arrived ? (
      <BuildIn order={start + 1 + index}>{node}</BuildIn>
    ) : (
      node
    );
  return (
    <section className="mt-4">
      <BuildIn order={start}>
        <SectionLabel tone={tone}>{label}</SectionLabel>
      </BuildIn>
      <ul className="mt-1.5">
        {shown.map((item, index) => {
          const row = (
            <CardRow
              detail={item.why}
              title={item.title}
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
              {index > 0 ? piece(index, <Rule />) : null}
              <li>
                {piece(
                  index,
                  item.href ? (
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
                  ),
                )}
              </li>
            </Fragment>
          );
        })}
      </ul>
      {folded ? (
        <BuildIn className="px-4 pt-0.5 pb-1" order={start + 1 + arrived}>
          <button
            aria-label={`Show ${hidden} more in ${label}`}
            // The Start line's look and 44px target, so the card has one kind of text action.
            className="type-sub -mx-2 inline-flex h-11 items-center gap-1 rounded-full px-2 font-medium text-duet-accent transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40 active:opacity-60"
            onClick={() => setOpen(true)}
            type="button"
          >
            Show {hidden} more
          </button>
        </BuildIn>
      ) : null}
    </section>
  );
}

/** How far a label travels as it swaps, in pixels: enough to read as a change, not a move. */
const SWAP_RISE = 4;

/**
 * The row's action as a line of text under its why. A pill in its own column left the title and
 * the why a narrow strip on a phone; as text it reads as the row's next step.
 *
 * Pressed, "Start →" turns into "✓ Started" in place: the old words lift and blur away as the new
 * ones rise out of a blur into their place, both at once over the swap duration, and the colour
 * crosses from the accent to done green with them. Drawn already done, it is simply done. With
 * reduced motion the words cross-fade without moving or blurring.
 */
function RowAction({ action }: { action: BriefAction }) {
  const done = action.done !== undefined;
  const reduced = useReducedMotionPreference();
  const label = action.done ?? action.label;
  const away = reduced
    ? { opacity: 0 }
    : { opacity: 0, y: -SWAP_RISE, filter: "blur(2px)" };
  return (
    <button
      aria-label={action.done ?? action.name}
      // 44px to tap (parity-spec 2.11) with the box pulled back by the margins, so the text sits
      // as close under the why as a line would; weight 500, as buttons are (2.3). Positioned, so the
      // words on their way out can be lifted out of the line while the new ones take it.
      className={cn(
        "type-sub -mx-2 -my-2.5 relative inline-flex h-11 items-center rounded-full px-2 font-medium transition-[opacity,color] duration-[var(--duet-dur-swap)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40",
        done
          ? "text-duet-status-done"
          : "text-duet-accent hover:opacity-80 active:opacity-60 disabled:text-duet-ink-3 disabled:hover:opacity-100",
      )}
      disabled={action.disabled || done}
      onClick={action.onPress}
      type="button"
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          className="inline-flex items-center gap-1 whitespace-nowrap"
          data-row-action={done ? "done" : "ready"}
          exit={away}
          initial={
            reduced
              ? { opacity: 0 }
              : { opacity: 0, y: SWAP_RISE, filter: "blur(2px)" }
          }
          key={done ? "done" : "ready"}
          transition={{ duration: DURATION.swap, ease: EASE_OUT }}
        >
          {done ? <DuetIcon name="check" size={15} stroke={2.4} /> : null}
          {label}
          {done ? null : <DuetIcon name="arrowRight" size={15} stroke={2.4} />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
