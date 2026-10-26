import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DuetIcon, type DuetIconName } from "./icons";

/**
 * The pieces the film's app is built from (launch-film/film/src/duet/app.tsx), as web components:
 * the white card, the icon tile, the hairline, the outcome pill, the topic label and the typing dots;
 * and the pieces of the visual system every screen shares (parity-spec Part 2): the list row, the
 * status line, the segmented control, and the thread's footer and "Seen".
 */

/**
 * A white card with a hairline and a soft drop: every card in the thread, Tasks and Activity.
 * `glass` is for a card that floats over a scrolling screen rather than sitting in it.
 */
export function DuetCard({
  className,
  raised = false,
  glass = false,
  ...props
}: ComponentProps<"div"> & { raised?: boolean; glass?: boolean }) {
  return (
    <div
      className={cn(
        "duet-face w-full overflow-hidden rounded-[var(--duet-radius-card)] text-duet-ink",
        glass
          ? "duet-glass shadow-duet-glass"
          : [
              "bg-duet-card",
              raised ? "shadow-duet-raised" : "shadow-duet-card",
            ],
        className,
      )}
      {...props}
    />
  );
}

const TILE_TONES = {
  neutral: "bg-duet-tile text-duet-ink-2",
  green: "bg-duet-green-soft text-duet-green",
  violet: "bg-duet-accent-soft text-duet-accent",
  red: "bg-duet-red-soft text-duet-red",
  blue: "bg-duet-blue-soft text-duet-blue",
  amber: "bg-duet-amber-soft text-duet-amber",
} as const;

export type TileTone = keyof typeof TILE_TONES;

/** A rounded square holding one glyph. Grey by default; tinted only to say how something ended. */
export function Tile({
  icon,
  tone = "neutral",
  size = 40,
}: {
  icon: DuetIconName;
  tone?: TileTone;
  size?: number;
}) {
  return (
    <span
      className={cn("grid shrink-0 place-items-center", TILE_TONES[tone])}
      style={{ width: size, height: size, borderRadius: size * 0.28 }}
    >
      <DuetIcon name={icon} size={size * 0.52} stroke={1.9} />
    </span>
  );
}

/** The hairline between rows. `inset` lines it up with the text after a 40px tile. */
export function Rule({ inset = false }: { inset?: boolean }) {
  return (
    <div
      aria-hidden
      className={cn("h-px bg-duet-hair-2", inset ? "ml-[69px]" : "mx-4")}
    />
  );
}

const PILL_TONES = {
  green: "bg-duet-green-soft text-duet-green",
  red: "bg-duet-red-soft text-duet-red",
  blue: "bg-duet-blue-soft text-duet-blue",
  amber: "bg-duet-amber-soft text-duet-amber",
  neutral: "bg-duet-tile text-duet-ink-2",
} as const;

export type PillTone = keyof typeof PILL_TONES;

/** How something ended, in a word: "Sent", "Done", "Refused". The only colour on a card. */
export function OutcomePill({
  children,
  icon = "check",
  tone,
}: {
  children: ReactNode;
  icon?: DuetIconName | null;
  tone: PillTone;
}) {
  return (
    <span
      className={cn(
        "type-sub inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-[11px] font-medium",
        PILL_TONES[tone],
      )}
    >
      {icon ? <DuetIcon name={icon} size={14} stroke={2.8} /> : null}
      {children}
    </span>
  );
}

/**
 * What a run of messages is about: a hairline hook, a small glyph, the name. Green once the work it
 * names is done; grey while it is still going.
 */
export function Topic({
  children,
  icon = "checkCircle",
  tone = "done",
  className,
}: {
  children: ReactNode;
  icon?: DuetIconName;
  tone?: "done" | "working" | "problem";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "duet-face flex min-h-6 min-w-0 items-center gap-[7px] pl-1",
        className,
      )}
    >
      <svg
        aria-hidden
        className="mt-[9px] shrink-0 text-duet-ink-3"
        height={14}
        viewBox="0 0 14 14"
        width={14}
      >
        <path
          d="M1 13V7a6 6 0 0 1 6-6h6"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={1.2}
        />
      </svg>
      <span
        className={cn(
          "shrink-0",
          tone === "done"
            ? "text-duet-green"
            : tone === "problem"
              ? "text-duet-amber"
              : "text-duet-ink-2",
        )}
      >
        <DuetIcon name={icon} size={16} stroke={2.2} />
      </span>
      <span className="type-sub min-w-0 truncate font-medium text-duet-ink-2">
        {children}
      </span>
    </div>
  );
}

/** Three dots in a grey bubble while the Bot writes. The words are for screen readers. */
export function TypingDots({ label = "Thinking" }: { label?: string }) {
  return (
    <div
      className="inline-flex h-[42px] w-fit items-center gap-1.5 self-start rounded-[var(--duet-radius-bubble)] bg-duet-bubble px-4"
      // `status`, not `alert`: progress, not an interruption.
      role="status"
    >
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((dot) => (
        <span
          aria-hidden
          className="duet-typing-dot size-2 rounded-full bg-duet-ink-2"
          key={dot}
          style={{ animationDelay: `${dot * 160}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * A small grey label over a section of rows: "Needs you", "Can wait", "Earlier". Section headers
 * recede so the rows lead, and the accent is not a heading colour (parity-spec 2.2), so `tone` no
 * longer changes anything; it stays so callers written against it still draw.
 */
export function SectionLabel({
  children,
}: {
  children: ReactNode;
  tone?: "muted" | "accent";
}) {
  return <h2 className="type-sub px-4 text-duet-ink-2">{children}</h2>;
}

/** One row in a card: a tile, a bold line and a grey line under it, and anything trailing. */
export function CardRow({
  icon,
  tone,
  title,
  detail,
  trailing,
  below,
}: {
  /** Left out where the section's label already says what every row is, as the brief's rows do. */
  icon?: DuetIconName;
  tone?: TileTone;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  /**
   * Something to do about the row, set under its text rather than in a column of its own: on a
   * phone a third column squeezes the text into a narrow strip. The row then aligns to its top.
   */
  below?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[66px] gap-[13px] px-4 py-3",
        below ? "items-start" : "items-center",
      )}
    >
      {icon ? <Tile icon={icon} tone={tone} /> : null}
      <div className="min-w-0 flex-1">
        <div className="type-body font-medium text-duet-ink [overflow-wrap:anywhere]">
          {title}
        </div>
        {detail ? (
          <div className="type-sub text-duet-ink-2 [overflow-wrap:anywhere]">
            {detail}
          </div>
        ) : null}
        {below ? <div className="mt-1">{below}</div> : null}
      </div>
      {trailing}
    </div>
  );
}

/**
 * How a piece of work stands, as Duet names it (parity-spec 2.2, Tasks S3c): the four states the
 * status colours exist for. Only these words carry colour; everything around them is grey.
 */
export type WorkStatus = "done" | "needs" | "working" | "problem";

export const STATUS_WORDS: Record<WorkStatus, string> = {
  done: "Ready for review",
  needs: "Needs input",
  working: "Working",
  problem: "Couldn't finish",
};

const STATUS_INK: Record<WorkStatus, string> = {
  done: "text-duet-status-done",
  needs: "text-duet-status-needs",
  working: "text-duet-status-working",
  problem: "text-duet-status-problem",
};

/**
 * The status word in its colour, then the next step in grey, on one line cut with an ellipsis:
 * "Working · Reading your mail". The word shimmers while the work is running.
 */
export function StatusLine({
  status,
  children,
}: {
  status: WorkStatus;
  /** The next step, in the person's terms. */
  children?: ReactNode;
}) {
  return (
    <span className="type-sub flex min-w-0 items-baseline whitespace-nowrap text-duet-ink-2">
      <span
        className={cn(
          "shrink-0",
          STATUS_INK[status],
          status === "working" && "tool-line-running",
        )}
      >
        {STATUS_WORDS[status]}
      </span>
      {children ? (
        <span className="min-w-0 truncate">
          <span aria-hidden> · </span>
          {children}
        </span>
      ) : null}
    </span>
  );
}

type RowAction =
  /** Opens or does something: the whole row is one button. */
  | { onClick: () => void; link?: never }
  /** Goes somewhere: the row is drawn as the link the caller builds from these. */
  | {
      link: (row: { className: string; children: ReactNode }) => ReactNode;
      onClick?: never;
    }
  /** Only states something. */
  | { onClick?: never; link?: never };

/**
 * One row in a list (parity-spec 2.4): what it is (an icon, a tile, an avatar, a checkbox), its title,
 * a line under it, and a status or a chevron at the end. Rows sit on the screen's own background and
 * are told apart by spacing; a list is never a white card of rows.
 *
 * A row that does something is one target, at least 44px tall, and answers a press at once. `size`
 * picks the title: `body` (17px) for a list of work, `nav` (18px) for a list of places, as in the
 * menu and Settings. `current` lays the row on the filled capsule that marks where you are.
 */
export function Row({
  leading,
  title,
  detail,
  meta,
  trailing,
  chevron = false,
  current = false,
  size = "body",
  className,
  ...action
}: {
  leading?: ReactNode;
  title: ReactNode;
  /** The line under the title, such as a status line or what a setting is set to. One line. */
  detail?: ReactNode;
  /** A third line, such as the channel a task belongs to. */
  meta?: ReactNode;
  trailing?: ReactNode;
  /** It opens a page of its own. */
  chevron?: boolean;
  current?: boolean;
  size?: "body" | "nav";
  className?: string;
} & RowAction) {
  const interactive = Boolean(action.onClick || action.link);
  const classes = cn(
    // Gaps in px, not rem: at a large text size the words need the room, not the margins.
    "duet-face flex w-full min-w-0 items-center gap-[12px] rounded-[22px] px-[12px] text-left text-duet-ink",
    detail || meta ? "min-h-[66px] py-2.5" : "min-h-[50px] py-2",
    current && "bg-duet-tile",
    interactive &&
      "cursor-pointer transition-colors duration-[var(--duet-dur-tap)] hover:bg-duet-tile/70 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40 active:bg-duet-tile",
    className,
  );
  const body = (
    <>
      {leading ? (
        <span className="grid shrink-0 place-items-center self-center text-duet-ink-2">
          {leading}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            // Breaks between words. A word too long for the line, at a large text size, is
            // hyphenated rather than cut anywhere.
            "line-clamp-2 font-medium hyphens-auto [overflow-wrap:break-word]",
            size === "nav" ? "type-nav" : "type-body",
          )}
        >
          {title}
        </span>
        {detail ? (
          <span className="type-sub min-w-0 truncate text-duet-ink-2">
            {detail}
          </span>
        ) : null}
        {meta ? (
          <span className="type-caption min-w-0 truncate text-duet-ink-2">
            {meta}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span className="type-sub shrink-0 text-duet-ink-2">{trailing}</span>
      ) : null}
      {chevron ? (
        <DuetIcon
          className="shrink-0 text-duet-ink-3"
          name="chevronRight"
          size={18}
        />
      ) : null}
    </>
  );
  if (action.link) return action.link({ className: classes, children: body });
  if (action.onClick)
    return (
      <button className={classes} onClick={action.onClick} type="button">
        {body}
      </button>
    );
  return <div className={classes}>{body}</div>;
}

/**
 * A choice of a few, side by side, the chosen one on a filled capsule: "Match phone", "Light",
 * "Dark". A radio group to assistive technology, so arrow keys move the choice.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** What is being chosen, for screen readers. */
  label: string;
  options: readonly { value: T; label: string; icon?: DuetIconName }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const move = (from: number, step: number) => {
    const next = options[(from + step + options.length) % options.length];
    if (next) onChange(next.value);
  };
  return (
    <div
      aria-label={label}
      // Wraps onto a second line at a large text size rather than running off the screen.
      className="duet-face flex w-full flex-wrap gap-1 rounded-[26px] bg-duet-tile p-1"
      role="radiogroup"
    >
      {options.map((option, index) => {
        const on = option.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control, drawn as one capsule.
          <button
            aria-checked={on}
            className={cn(
              "type-sub flex min-h-11 flex-[1_1_7rem] items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 font-medium transition-colors duration-[var(--duet-dur-swap)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40",
              on
                ? "bg-duet-card text-duet-ink shadow-duet-float"
                : "text-duet-ink-2 hover:text-duet-ink",
            )}
            key={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(index, -1);
              }
            }}
            role="radio"
            tabIndex={on ? 0 : -1}
            type="button"
          >
            {option.icon ? <DuetIcon name={option.icon} size={18} /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Under the person's newest message once the Bot has it, until its reply lands. */
export function Seen() {
  return (
    <p className="duet-face type-caption mt-1 text-right text-duet-ink-3">
      Seen
    </p>
  );
}
