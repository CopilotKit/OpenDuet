import { Fragment, type ReactNode } from "react";
import type { PageBlock, PageSlide } from "@/lib/pages/queries";
import { cn } from "@/lib/utils";
import { DuetIcon } from "./icons";

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
}: {
  blocks: readonly PageBlock[];
  onListItem?: OnListItem;
}) {
  const headline = isDashboard(blocks);
  return (
    <div className="flex flex-col">
      {blocks.map((block, index) => (
        <Block
          block={block}
          // Blocks have no ids, and they never move once made: the index is the identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: a page's blocks are fixed in order.
          key={index}
          lead={headline && index === 0}
          {...(onListItem ? { onListItem } : {})}
        />
      ))}
    </div>
  );
}

function Block({
  block,
  lead,
  onListItem,
}: {
  block: PageBlock;
  lead: boolean;
  onListItem?: OnListItem;
}) {
  switch (block.type) {
    case "heading":
      return (
        <h3 className="type-title mt-7 font-semibold text-duet-ink first:mt-0">
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
        <p className="type-body mt-3 whitespace-pre-line text-duet-ink leading-[27px] [overflow-wrap:anywhere] first:mt-0">
          {block.text}
        </p>
      );
    case "bullets":
      return (
        <ul className="mt-3 flex flex-col gap-2 first:mt-0">
          {block.items.map((item, index) => (
            <li
              className="type-body flex gap-3 text-duet-ink leading-[26px] [overflow-wrap:anywhere]"
              // biome-ignore lint/suspicious/noArrayIndexKey: two bullets may say the same thing.
              key={index}
            >
              <span
                aria-hidden
                className="mt-[11px] size-[5px] shrink-0 rounded-full bg-duet-ink-3"
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
              className="flex min-h-[108px] min-w-0 flex-col rounded-[18px] bg-duet-tile px-3.5 py-3"
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
            <figcaption className="type-label mb-3 font-semibold text-duet-ink-2">
              {block.label}
            </figcaption>
          ) : null}
          <BarChart height={176} items={block.items} label={block.label} />
        </figure>
      );
    case "list":
      return (
        <section
          aria-label={block.title ?? undefined}
          className="mt-7 first:mt-0"
        >
          {block.title ? (
            <h3 className="type-title mb-3 font-semibold text-duet-ink">
              {block.title}
            </h3>
          ) : null}
          <ul className="overflow-hidden rounded-[18px] bg-duet-tile">
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
 * Labelled numbers as bars, the last one in violet: the one the chart is about, usually the latest.
 * The figures are read out as a list, since a screen reader cannot see the heights.
 */
export function BarChart({
  items,
  label,
  height,
  compact = false,
}: {
  items: readonly { label: string; value: number }[];
  label?: string | undefined;
  height?: number;
  compact?: boolean;
}) {
  const max = Math.max(...items.map((item) => item.value), 0);
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
          const last = index === items.length - 1;
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
                  last ? "text-duet-violet" : "text-duet-ink-2",
                )}
              >
                {formatValue(item.value)}
              </span>
              <div className="flex min-h-0 w-full flex-1 items-end">
                <div
                  className={cn(
                    "w-full",
                    compact ? "rounded-[4px]" : "rounded-[7px]",
                    last ? "bg-duet-violet" : "bg-duet-ink-3/35",
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
 * that grow to fit them, and nothing is cut off, clamped or left out. What keeps a slide from
 * running long is the tool, not the slide: `make_page` refuses, at save, a slide that would not fit
 * this frame at 390px wide (`slideHeight` in server/src/openduet/page-content.ts), and tells the
 * model to split it.
 *
 * So the sizes here are a contract with that check, in px rather than rem so the person's root
 * size never moves them: an 18px title, 15px text, 13px captions, 12px between blocks, 16px of
 * padding. Change one here and change it there.
 */

/**
 * One slide of a deck: its title, then its blocks. It is at least 16:9 and grows to show
 * everything it holds. In a deck every slide fills its place, which is as tall as the tallest
 * slide, so the frame doesn't jump as the slides turn.
 */
export function SlideCard({
  slide,
  onListItem,
  className,
}: {
  slide: PageSlide;
  onListItem?: OnListItem;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid h-full w-full grid-cols-1 rounded-[18px] bg-duet-card p-[16px] text-duet-ink shadow-duet-raised",
        className,
      )}
    >
      {/*
       * The floor: a spacer in the same cell as the content, so the card is the taller of the two.
       * 31:16 inside 16px of padding is 16:9 outside it at phone width. An aspect ratio on the card
       * itself would fix its height instead, and the content would spill out of it.
       */}
      <div aria-hidden className="col-start-1 row-start-1 aspect-[31/16]" />
      <div className="col-start-1 row-start-1 flex min-w-0 flex-col self-start">
        <h3 className="font-semibold text-[18px] leading-[22px] tracking-[-0.01em] [overflow-wrap:anywhere]">
          {slide.title}
        </h3>
        {slide.blocks.length > 0 ? (
          <div className="mt-[12px] flex flex-col gap-[12px]">
            {slide.blocks.map((block, index) => (
              <SlideBlock
                block={block}
                // biome-ignore lint/suspicious/noArrayIndexKey: a slide's blocks are fixed in order.
                key={index}
                onListItem={onListItem}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SlideBlock({
  block,
  onListItem,
}: {
  block: PageBlock;
  onListItem?: OnListItem | undefined;
}): ReactNode {
  switch (block.type) {
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
            block.items.length > 1 ? "grid-cols-2" : "grid-cols-1",
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
      return <SlideBars items={block.items} label={block.label} />;
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
                  text={item.text}
                />
              </li>
            ))}
          </ul>
        </div>
      );
  }
}

/** A row on a slide: at least a 44px target, its note under it, a chevron when it can be pressed. */
function SlideRow({
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
  const row =
    "flex min-h-[44px] w-full items-center gap-[8px] py-[4px] text-left";
  return onPress ? (
    <button
      className={cn(
        row,
        "rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-duet-violet/40 active:bg-duet-hair-2",
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
 * A chart on a slide: a column per bar, its figure over it and its label under it, the last one in
 * violet. The bars share one 72px height so they compare; a label wraps under its bar rather than
 * being cut, and the tool refuses a label or figure too wide for its column.
 */
function SlideBars({
  items,
  label,
}: {
  items: readonly { label: string; value: number }[];
  label?: string | undefined;
}) {
  const max = Math.max(...items.map((item) => item.value), 0);
  const described = items.map((item) => `${item.label} ${item.value}`);
  return (
    <figure className="flex flex-col">
      {label ? (
        <figcaption className="mb-[6px] font-semibold text-[13px] text-duet-ink-2 leading-[16px] [overflow-wrap:anywhere]">
          {label}
        </figcaption>
      ) : null}
      <div
        aria-label={[label, described.join(", ")].filter(Boolean).join(": ")}
        className="flex gap-[6px]"
        role="img"
      >
        {items.map((item, index) => {
          const last = index === items.length - 1;
          const share = max > 0 ? item.value / max : 0;
          return (
            <div
              className="flex min-w-0 flex-1 basis-0 flex-col items-center"
              // biome-ignore lint/suspicious/noArrayIndexKey: two bars may share a label.
              key={index}
            >
              <span
                className={cn(
                  "font-medium text-[13px] leading-[16px] tabular-nums",
                  last ? "text-duet-violet" : "text-duet-ink-2",
                )}
              >
                {formatValue(item.value)}
              </span>
              <div className="mt-[2px] flex h-[72px] w-full items-end">
                <div
                  className={cn(
                    "w-full rounded-[6px]",
                    last ? "bg-duet-violet" : "bg-duet-ink-3/35",
                  )}
                  style={{ height: `${Math.max(share * 100, 3)}%` }}
                />
              </div>
              <span className="mt-[4px] w-full text-center text-[13px] text-duet-ink-2 leading-[16px] [overflow-wrap:anywhere]">
                {item.label}
              </span>
            </div>
          );
        })}
      </div>
    </figure>
  );
}
