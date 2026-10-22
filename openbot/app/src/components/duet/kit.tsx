import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DuetIcon, type DuetIconName } from "./icons";

/**
 * The pieces the film's app is built from (launch-film/film/src/duet/app.tsx), as web components:
 * the white card, the icon tile, the hairline, the outcome pill, the topic label and the typing dots.
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
        "duet-face w-full overflow-hidden rounded-[22px] text-duet-ink",
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
  violet: "bg-duet-violet-soft text-duet-violet",
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
        "type-label inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-[11px] font-semibold",
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
      <span className="type-label min-w-0 truncate font-semibold text-duet-ink-2">
        {children}
      </span>
    </div>
  );
}

/** Three dots in a grey bubble while the Bot writes. The words are for screen readers. */
export function TypingDots({ label = "Thinking" }: { label?: string }) {
  return (
    <div
      className="inline-flex h-[42px] w-fit items-center gap-1.5 self-start rounded-[21px] rounded-bl-[7px] bg-duet-bubble px-4"
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

/** A small grey label over a section of rows: "Needs you", "Can wait", "Earlier". */
export function SectionLabel({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "accent";
}) {
  return (
    <h2
      className={cn(
        "type-label px-4 font-semibold",
        tone === "accent" ? "text-duet-violet" : "text-duet-ink-2",
      )}
    >
      {children}
    </h2>
  );
}

/** One row in a card: a tile, a bold line and a grey line under it, and anything trailing. */
export function CardRow({
  icon,
  tone,
  title,
  detail,
  trailing,
}: {
  icon: DuetIconName;
  tone?: TileTone;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-h-[66px] items-center gap-[13px] px-4 py-3">
      <Tile icon={icon} tone={tone} />
      <div className="min-w-0 flex-1">
        <div className="type-row font-semibold text-duet-ink [overflow-wrap:anywhere]">
          {title}
        </div>
        {detail ? (
          <div className="type-sub text-duet-ink-2 [overflow-wrap:anywhere]">
            {detail}
          </div>
        ) : null}
      </div>
      {trailing}
    </div>
  );
}
