import {
  BAR_PLOT,
  barFigure,
  barsLayout,
  CURRENT_SLIDE_LAYOUT,
  metricColumns,
  ROW_GAP,
  rowLabelWidth,
  SLIDE_PADDING,
  type SlideLayoutVersion,
  slideGeometry,
  TAP_TARGET,
} from "@openbot/shared/slide-fit";
import {
  Fragment,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PageBlock, PageSlide } from "@/lib/pages/queries";
import { cn } from "@/lib/utils";
import { DuetIcon } from "./icons";
import { RichBlock } from "./page-rich-block";

/*
 * A page the Bot made, drawn from its blocks in the shell's own type and colours. The viewer draws
 * them at reading size; a slide draws the same blocks small enough that three fit on one 16:9 card.
 * Nothing here renders text as markup: every block is a fixed shape filled with plain strings.
 */

/**
 * Whether a page reads as a dashboard: a headline sentence, then the figures. The viewer sets the
 * headline large and the card previews the headline over three tiles.
 */
export function isDashboard(blocks: readonly PageBlock[]): boolean {
  return blocks[0]?.type === "text" && blocks[1]?.type === "metrics";
}

/** How long a dashboard's headline can be and still be set large: about two lines at phone width. */
const HEADLINE_LENGTH = 90;

/** One row of a list block, pressed. Absent where there is nowhere to send it, and the rows are still. */
export type OnListItem = (text: string) => void;

/** A page's blocks at reading size, in order. */
export function PageBlocks({
  blocks,
  onListItem,
  onCheck,
}: {
  blocks: readonly PageBlock[];
  onListItem?: OnListItem;
  onCheck?:
    | ((block: number, item: string, checked: boolean) => void)
    | undefined;
}) {
  const headline = isDashboard(blocks);
  return (
    <div className="flex flex-col">
      {blocks.map((block, index) => (
        <Block
          block={block}
          // Saved positions remain stable even when the parser skips unsupported blocks.
          key={block.persistedIndex ?? index}
          lead={headline && index === 0}
          onCheck={
            onCheck
              ? (item, checked) =>
                  onCheck(block.persistedIndex ?? index, item, checked)
              : undefined
          }
          {...(onListItem ? { onListItem } : {})}
        />
      ))}
    </div>
  );
}

function Block({
  block,
  lead,
  onCheck,
  onListItem,
}: {
  block: PageBlock;
  lead: boolean;
  onCheck?: ((item: string, checked: boolean) => void) | undefined;
  onListItem?: OnListItem;
}) {
  switch (block.type) {
    case "timeline":
    case "decision":
    case "checklist":
    case "table":
    case "comparison":
    case "image":
      return <RichBlock block={block} onCheck={onCheck} />;
    case "heading":
      return (
        <h3 className="type-title mt-7 font-semibold text-duet-ink [overflow-wrap:anywhere] first:mt-0">
          {block.text}
        </h3>
      );
    case "text":
      return lead ? (
        <p
          className={cn(
            "mt-1 text-balance font-semibold text-duet-ink [overflow-wrap:anywhere] first:mt-0",
            // About two lines at the large size; a longer headline steps down rather than fill the screen.
            block.text.length > HEADLINE_LENGTH ? "type-title" : "type-big",
          )}
        >
          {block.text}
        </p>
      ) : (
        /*
         * LINE HEIGHTS HERE ARE RATIOS, NOT PIXELS. `type-body` is in rem so it follows the person's
         * text size, and a pixel line height beside it does not: at 200% the text grew to 34px and
         * the lines stayed 27px apart, so every line overlapped the one above. 1.6 is the 27px the
         * reader was drawn with, at the default 17px.
         */
        <p className="type-body mt-3 whitespace-pre-line text-duet-ink leading-[1.6] [overflow-wrap:anywhere] first:mt-0">
          {block.text}
        </p>
      );
    case "bullets":
      return (
        <ul className="mt-3 flex flex-col gap-2 first:mt-0">
          {block.items.map((item, index) => (
            <li
              // 26px at the default size, as a ratio for the reason the paragraph above gives.
              className="type-body flex gap-3 text-duet-ink leading-[1.53] [overflow-wrap:anywhere]"
              // biome-ignore lint/suspicious/noArrayIndexKey: two bullets may say the same thing.
              key={index}
            >
              {/* Centred on the first line at any text size: half the line, less half the dot. */}
              <span
                aria-hidden
                className="mt-[calc(0.765em-2.5px)] size-[5px] shrink-0 rounded-full bg-duet-ink-3"
              />
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      );
    case "metrics":
      return (
        <ul className="mt-6 grid grid-cols-2 gap-2.5 first:mt-0">
          {block.items.map((metric, index) => (
            <li
              className="flex min-h-[108px] min-w-0 flex-col rounded-[18px] bg-duet-card px-3.5 py-3 shadow-[0_0_0_1px_var(--duet-hair-2)]"
              // biome-ignore lint/suspicious/noArrayIndexKey: two tiles may share a label.
              key={index}
            >
              <span className="type-label font-medium text-duet-ink-2 [overflow-wrap:anywhere]">
                {metric.label}
              </span>
              <span className="mt-1 font-semibold text-[28px] text-duet-ink tabular-nums leading-[32px] tracking-[-0.02em] [overflow-wrap:anywhere]">
                {metric.value}
              </span>
              {metric.note ? (
                <span className="type-label mt-auto pt-1 text-duet-ink-2 [overflow-wrap:anywhere]">
                  {metric.note}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      );
    case "bars":
      return (
        <figure className="mt-6 first:mt-0">
          {block.label ? (
            <figcaption className="type-label mb-3 font-semibold text-duet-ink-2 [overflow-wrap:anywhere]">
              {block.label}
            </figcaption>
          ) : null}
          <BarChart
            height={176}
            items={block.items}
            label={block.label}
            scale={block.scale}
            highlight={block.highlight}
          />
        </figure>
      );
    case "list":
      return (
        <section
          aria-label={block.title ?? undefined}
          className="mt-7 first:mt-0"
        >
          {block.title ? (
            <h3 className="type-title mb-3 font-semibold text-duet-ink [overflow-wrap:anywhere]">
              {block.title}
            </h3>
          ) : null}
          <ul className="overflow-hidden rounded-[18px] bg-duet-card shadow-[0_0_0_1px_var(--duet-hair-2)]">
            {block.items.map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows may repeat a line.
              <Fragment key={index}>
                {index > 0 ? (
                  <li aria-hidden className="mx-4 h-px bg-duet-hair" />
                ) : null}
                <li>
                  <ListRow
                    note={item.note}
                    onPress={
                      onListItem ? () => onListItem(item.text) : undefined
                    }
                    text={item.text}
                  />
                </li>
              </Fragment>
            ))}
          </ul>
        </section>
      );
  }
}

function ListRow({
  text,
  note,
  onPress,
}: {
  text: string;
  note?: string | undefined;
  onPress?: (() => void) | undefined;
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="type-row block font-medium text-duet-ink [overflow-wrap:anywhere]">
          {text}
        </span>
        {note ? (
          <span className="type-label block text-duet-ink-2 [overflow-wrap:anywhere]">
            {note}
          </span>
        ) : null}
      </span>
      {onPress ? (
        <span className="shrink-0 text-duet-ink-3">
          <DuetIcon name="chevronRight" size={18} stroke={2.2} />
        </span>
      ) : null}
    </>
  );
  const row = "flex min-h-[54px] w-full items-center gap-3 px-4 py-3 text-left";
  return onPress ? (
    <button
      className={cn(
        row,
        "outline-none transition-colors hover:bg-duet-hair-2 focus-visible:bg-duet-hair-2 focus-visible:ring-3 focus-visible:ring-duet-violet/30 focus-visible:ring-inset active:bg-duet-hair",
      )}
      onClick={onPress}
      type="button"
    >
      {body}
    </button>
  ) : (
    <div className={row}>{body}</div>
  );
}

/**
 * Labelled numbers as bars, preserving a saved chart's scale and highlighted bar.
 * Without saved metadata, the largest value sets the scale and the last bar is violet.
 * The figures are read out as a list, since a screen reader cannot see the heights.
 */
export function BarChart({
  items,
  label,
  height,
  scale,
  highlight,
  compact = false,
}: {
  items: readonly { label: string; value: number }[];
  label?: string | undefined;
  height?: number;
  scale?: number | undefined;
  highlight?: number | undefined;
  compact?: boolean;
}) {
  const max = scale ?? Math.max(...items.map((item) => item.value), 0);
  const described = items.map((item) => `${item.label} ${item.value}`);
  return (
    <div
      aria-label={[label, described.join(", ")].filter(Boolean).join(": ")}
      className={cn("flex w-full", compact ? "min-h-0 flex-1" : "")}
      role="img"
      style={height ? { height } : undefined}
    >
      <div
        className={cn(
          "flex h-full w-full items-stretch",
          compact ? "gap-1.5" : "gap-2",
        )}
      >
        {items.map((item, index) => {
          const highlighted = index === (highlight ?? items.length - 1);
          const share = max > 0 ? item.value / max : 0;
          return (
            <div
              className="flex min-w-0 flex-1 flex-col items-center gap-1"
              // biome-ignore lint/suspicious/noArrayIndexKey: two bars may share a label.
              key={index}
            >
              <span
                className={cn(
                  "font-medium tabular-nums",
                  compact
                    ? "text-[11px] leading-[13px]"
                    : "text-[13px] leading-4",
                  highlighted ? "text-duet-violet" : "text-duet-ink-2",
                )}
              >
                {formatValue(item.value)}
              </span>
              <div className="flex min-h-0 w-full flex-1 items-end">
                <div
                  className={cn(
                    "w-full",
                    compact ? "rounded-[4px]" : "rounded-[7px]",
                    highlighted ? "bg-duet-violet" : "bg-duet-ink-3/35",
                  )}
                  style={{ height: `${Math.max(share * 100, 3)}%` }}
                />
              </div>
              <span
                className={cn(
                  "w-full truncate text-center text-duet-ink-2",
                  compact
                    ? "text-[11px] leading-[13px]"
                    : "text-[13px] leading-4",
                )}
              >
                {item.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 12, 1.5K, 2.1M: a bar's figure at the size a bar can carry. */
export function formatValue(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/*
 * A slide, drawn for a phone. Every block on it is laid out whole: words wrap, figures sit in tiles
 * that grow to fit them, a chart's bars lie in rows when their labels need the room, and nothing is
 * cut off, clamped or left out. What keeps a slide from running long is the tool, not the slide:
 * `make_page` refuses, at save, a slide that would not fit its frame, and tells the model to split it.
 *
 * The slide is laid out at its saved width (264px now; 330px for legacy decks), then scaled to
 * the width the deck gives it, so it wraps in the same places on every phone and the save-time measure holds on all of them
 * (shared/slide-fit.ts). The sizes here are that measure's, in px so the root size never moves them:
 * an 18/22 title, 15/20 text, 18/22 figures, 13/16 captions, 12px between blocks, 16px of padding.
 * Change one here and change it there.
 */

/** A slide's height at the design width, before it is scaled: its content, or 16:9 if that is taller. */
function cardHeight(content: number, width: number): number {
  return Math.max(content + 2 * SLIDE_PADDING, (width * 9) / 16);
}

/** The width an element's parent gives it: its content box. */
function widthGiven(element: HTMLElement): number {
  const parent = element.parentElement;
  if (!parent) return 0;
  const style = getComputedStyle(parent);
  return (
    parent.clientWidth -
    Number.parseFloat(style.paddingLeft || "0") -
    Number.parseFloat(style.paddingRight || "0")
  );
}

/**
 * One slide of a deck: its title, then its blocks. It is at least 16:9 and grows to show everything
 * it holds. In a deck every slide fills its place, which is as tall as the tallest slide, so the
 * frame doesn't jump as the slides turn.
 */
export function SlideCard({
  slide,
  layoutVersion = CURRENT_SLIDE_LAYOUT,
  onListItem,
  onCheck,
  className,
}: {
  slide: PageSlide;
  layoutVersion?: SlideLayoutVersion;
  onCheck?:
    | ((block: number, item: string, checked: boolean) => void)
    | undefined;
  onListItem?: OnListItem;
  className?: string;
}) {
  const geometry = slideGeometry(layoutVersion);
  const frame = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLDivElement>(null);
  /*
   * The width the slide is given, its scale, the height the deck gave it, and its content's height
   * at the design width. Unmeasured (before layout, or where there is none, as in tests) the card
   * is drawn in place at the width it is given.
   */
  const [fit, setFit] = useState<{
    given: number;
    scale: number;
    height: number;
    content: number;
  } | null>(null);
  useLayoutEffect(() => {
    const outer = frame.current;
    const inner = words.current;
    if (!outer || !inner) return;
    const measure = () => {
      const given = widthGiven(outer);
      if (given <= 0) return;
      const next = {
        given,
        scale: Math.max(given / geometry.width, geometry.leastScale),
        height: outer.clientHeight,
        // offsetHeight is the laid-out height, before the transform scales it.
        content: inner.offsetHeight,
      };
      setFit((previous) =>
        previous &&
        previous.given === next.given &&
        previous.scale === next.scale &&
        previous.height === next.height &&
        previous.content === next.content
          ? previous
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    if (outer.parentElement) observer.observe(outer.parentElement);
    return () => observer.disconnect();
  }, [geometry]);
  const height = fit ? cardHeight(fit.content, geometry.width) : 0;
  const width = fit ? geometry.width * fit.scale : 0;
  return (
    <div
      className={cn("relative h-full", fit ? null : "w-full", className)}
      ref={frame}
      style={
        fit
          ? {
              width,
              // Past the least scale the card is wider than its place, and reaches out evenly both sides.
              marginInline: (fit.given - width) / 2,
              minHeight: height * fit.scale,
            }
          : undefined
      }
    >
      <div
        className={cn(
          "grid grid-cols-1 rounded-[18px] bg-duet-card p-[16px] text-duet-ink shadow-duet-raised",
          fit ? "absolute top-0 left-0 origin-top-left" : "h-full w-full",
        )}
        style={
          fit
            ? {
                width: geometry.width,
                height: Math.max(fit.height / fit.scale, height),
                transform: `scale(${fit.scale})`,
              }
            : undefined
        }
      >
        {/*
         * The 16:9 floor before the slide is measured: a spacer in the same cell as the content, so
         * the card is the taller of the two. 31:16 inside 16px of padding is 16:9 outside it.
         */}
        {fit ? null : (
          <div aria-hidden className="col-start-1 row-start-1 aspect-[31/16]" />
        )}
        <div
          className="col-start-1 row-start-1 flex min-w-0 flex-col self-start"
          ref={words}
          // The fit measure uses Inter/system sans, even when the surrounding page is editorial.
          style={{
            fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          }}
        >
          <h3 className="font-semibold text-[18px] leading-[22px] tracking-[-0.01em] [overflow-wrap:anywhere]">
            {slide.title}
          </h3>
          {slide.blocks.length > 0 ? (
            <div className="mt-[12px] flex flex-col gap-[12px]">
              {slide.blocks.map((block, index) => (
                <SlideBlock
                  block={block}
                  key={block.persistedIndex ?? index}
                  onListItem={onListItem}
                  scale={fit?.scale ?? 1}
                  layoutVersion={layoutVersion}
                  onCheck={
                    onCheck
                      ? (item, checked) =>
                          onCheck(block.persistedIndex ?? index, item, checked)
                      : undefined
                  }
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SlideBlock({
  block,
  onListItem,
  onCheck,
  scale,
  layoutVersion,
}: {
  layoutVersion: SlideLayoutVersion;
  block: PageBlock;
  onListItem?: OnListItem | undefined;
  onCheck?: ((item: string, checked: boolean) => void) | undefined;
  /** How much the slide is scaled on screen, so a row can stay a 44px target there. */
  scale: number;
}): ReactNode {
  switch (block.type) {
    case "timeline":
    case "decision":
    case "checklist":
    case "table":
    case "comparison":
    case "image":
      return (
        <RichBlock
          block={block}
          compact
          scale={scale}
          onCheck={onCheck}
          layoutVersion={layoutVersion}
        />
      );
    case "heading":
      return (
        <p className="font-semibold text-[15px] text-duet-ink leading-[20px] [overflow-wrap:anywhere]">
          {block.text}
        </p>
      );
    case "text":
      return (
        <p className="whitespace-pre-line text-[15px] text-duet-ink-2 leading-[20px] [overflow-wrap:anywhere]">
          {block.text}
        </p>
      );
    case "bullets":
      return (
        <ul className="flex flex-col gap-[4px]">
          {block.items.map((item, index) => (
            <li
              className="flex gap-[8px] text-[15px] text-duet-ink-2 leading-[20px]"
              // biome-ignore lint/suspicious/noArrayIndexKey: two bullets may say the same thing.
              key={index}
            >
              <span
                aria-hidden
                className="mt-[8px] size-[4px] shrink-0 rounded-full bg-duet-ink-3"
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">{item}</span>
            </li>
          ))}
        </ul>
      );
    case "metrics":
      return (
        <ul
          className={cn(
            "grid gap-[8px]",
            metricColumns(block, layoutVersion) === 2
              ? "grid-cols-2"
              : "grid-cols-1",
          )}
        >
          {block.items.map((metric, index) => (
            <li
              className="flex min-w-0 flex-col rounded-[10px] bg-duet-tile px-[10px] py-[8px]"
              // biome-ignore lint/suspicious/noArrayIndexKey: two tiles may share a label.
              key={index}
            >
              <span className="font-semibold text-[18px] leading-[22px] tracking-[-0.01em] tabular-nums [overflow-wrap:anywhere]">
                {metric.value}
              </span>
              <span className="font-medium text-[13px] text-duet-ink-2 leading-[16px] [overflow-wrap:anywhere]">
                {metric.label}
              </span>
              {metric.note ? (
                <span className="mt-[2px] text-[13px] text-duet-ink-2 leading-[16px] [overflow-wrap:anywhere]">
                  {metric.note}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      );
    case "bars":
      return <SlideBars block={block} layoutVersion={layoutVersion} />;
    case "list":
      return (
        <div>
          {block.title ? (
            <p className="mb-[4px] font-semibold text-[15px] text-duet-ink leading-[20px] [overflow-wrap:anywhere]">
              {block.title}
            </p>
          ) : null}
          <ul aria-label={block.title ?? undefined} className="flex flex-col">
            {block.items.map((item, index) => (
              <li
                className={index > 0 ? "border-duet-hair border-t" : undefined}
                // biome-ignore lint/suspicious/noArrayIndexKey: rows may repeat a line.
                key={index}
              >
                <SlideRow
                  note={item.note}
                  onPress={onListItem ? () => onListItem(item.text) : undefined}
                  scale={scale}
                  text={item.text}
                />
              </li>
            ))}
          </ul>
        </div>
      );
  }
}

/**
 * A row on a slide: its note under it, a chevron when it can be pressed, and at least a 44px target
 * on screen whatever the slide's scale (52px laid out at the least scale, which the measure counts).
 */
function SlideRow({
  text,
  note,
  onPress,
  scale,
}: {
  text: string;
  note?: string | undefined;
  onPress?: (() => void) | undefined;
  scale: number;
}) {
  const minHeight = TAP_TARGET / scale;
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-[15px] text-duet-ink leading-[20px] [overflow-wrap:anywhere]">
          {text}
        </span>
        {note ? (
          <span className="block text-[13px] text-duet-ink-2 leading-[16px] [overflow-wrap:anywhere]">
            {note}
          </span>
        ) : null}
      </span>
      {onPress ? (
        <DuetIcon
          className="shrink-0 text-duet-ink-3"
          name="chevronRight"
          size={16}
          stroke={2.2}
        />
      ) : null}
    </>
  );
  const row = "flex w-full items-center gap-[8px] py-[4px] text-left";
  return onPress ? (
    <button
      className={cn(
        row,
        "rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-duet-violet/40 active:bg-duet-hair-2",
      )}
      onClick={onPress}
      style={{ minHeight }}
      type="button"
    >
      {body}
    </button>
  ) : (
    <div className={row} style={{ minHeight }}>
      {body}
    </div>
  );
}

/**
 * A chart on a slide, the last bar in violet. Standing in columns, figure over and label under, when
 * every figure and label word fits its column; lying in rows (label, bar, figure) when one doesn't,
 * so "Wednesday" under a seventh of the slide is laid out rather than broken. The server measured
 * the same choice (`barsLayout`). The figures are read out as a list, since a screen reader cannot
 * see the bars.
 */
function SlideBars({
  block,
  layoutVersion,
}: {
  block: Extract<PageBlock, { type: "bars" }>;
  layoutVersion: SlideLayoutVersion;
}) {
  const { items, label } = block;
  // A part of a chart continued across slides draws against the whole chart's largest value.
  const max = block.scale ?? Math.max(...items.map((item) => item.value), 0);
  const described = items.map((item) => `${item.label} ${item.value}`);
  const name = [label, described.join(", ")].filter(Boolean).join(": ");
  const tone = (index: number) =>
    index === (block.highlight ?? items.length - 1) ? "violet" : "grey";
  const share = (value: number) => (max > 0 ? value / max : 0);
  const rows = barsLayout(block, layoutVersion) === "rows";
  // In rows, the label column takes the widest label, as the measure does (`rowLabelWidth`).
  const labelWidth = rows ? rowLabelWidth(block, layoutVersion) : 0;
  return (
    <figure className="flex flex-col">
      {label ? (
        <figcaption className="mb-[6px] font-semibold text-[13px] text-duet-ink-2 leading-[16px] [overflow-wrap:anywhere]">
          {label}
        </figcaption>
      ) : null}
      {rows ? (
        <div
          aria-label={name}
          className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)_max-content] items-center gap-x-[8px]"
          data-layout="rows"
          role="img"
          style={{ rowGap: ROW_GAP }}
        >
          {items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two bars may share a label.
            <Fragment key={index}>
              <span
                className="text-[13px] text-duet-ink-2 leading-[16px] [overflow-wrap:anywhere]"
                style={{ maxWidth: labelWidth }}
              >
                {item.label}
              </span>
              <div className="h-[12px] w-full">
                <div
                  className={cn(
                    "h-full rounded-[4px]",
                    tone(index) === "violet"
                      ? "bg-duet-violet"
                      : "bg-duet-ink-2/70",
                  )}
                  style={{ width: `${Math.max(share(item.value) * 100, 2)}%` }}
                />
              </div>
              <span
                className={cn(
                  "text-right font-medium text-[13px] leading-[16px] tabular-nums",
                  tone(index) === "violet"
                    ? "text-duet-violet"
                    : "text-duet-ink-2",
                )}
              >
                {barFigure(item.value)}
              </span>
            </Fragment>
          ))}
        </div>
      ) : (
        <div
          aria-label={name}
          className="flex gap-[6px]"
          data-layout="columns"
          role="img"
        >
          {items.map((item, index) => (
            <div
              className="flex min-w-0 flex-1 basis-0 flex-col items-center"
              // biome-ignore lint/suspicious/noArrayIndexKey: two bars may share a label.
              key={index}
            >
              <span
                className={cn(
                  "font-medium text-[13px] leading-[16px] tabular-nums",
                  tone(index) === "violet"
                    ? "text-duet-violet"
                    : "text-duet-ink-2",
                )}
              >
                {barFigure(item.value)}
              </span>
              <div
                className="mt-[2px] flex w-full items-end"
                style={{ height: BAR_PLOT }}
              >
                <div
                  className={cn(
                    "w-full rounded-[6px]",
                    tone(index) === "violet"
                      ? "bg-duet-violet"
                      : "bg-duet-ink-2/70",
                  )}
                  style={{ height: `${Math.max(share(item.value) * 100, 3)}%` }}
                />
              </div>
              <span className="mt-[4px] w-full text-center text-[13px] text-duet-ink-2 leading-[16px] [overflow-wrap:anywhere]">
                {item.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}
