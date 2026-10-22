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

/**
 * One slide on a 16:9 card. A slide holds at most three blocks, drawn small; a chart takes whatever
 * height the others leave it.
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
  // A chart needs the height. Beside one, the words get fewer lines so the bars stay readable.
  const tight = slide.blocks.some((block) => block.type === "bars");
  return (
    <div
      className={cn(
        "flex aspect-video w-full flex-col overflow-hidden rounded-[18px] bg-duet-card p-4 text-duet-ink shadow-duet-raised",
        className,
      )}
    >
      <h3
        className={cn(
          "font-semibold text-[19px] leading-[23px] tracking-[-0.015em]",
          tight ? "line-clamp-1" : "line-clamp-2",
        )}
      >
        {slide.title}
      </h3>
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2">
        {slide.blocks.map((block, index) => (
          <SlideBlock
            block={block}
            // biome-ignore lint/suspicious/noArrayIndexKey: a slide's blocks are fixed in order.
            key={index}
            onListItem={onListItem}
            tight={tight}
          />
        ))}
      </div>
    </div>
  );
}

function SlideBlock({
  block,
  onListItem,
  tight,
}: {
  block: PageBlock;
  onListItem?: OnListItem | undefined;
  tight: boolean;
}): ReactNode {
  const lines = tight ? 2 : 4;
  switch (block.type) {
    case "heading":
      return (
        <p className="font-semibold text-[14px] text-duet-ink leading-[18px]">
          {block.text}
        </p>
      );
    case "text":
      return (
        <p
          className={cn(
            "shrink-0 text-[14px] text-duet-ink-2 leading-[19px]",
            tight ? "line-clamp-2" : "line-clamp-3",
          )}
        >
          {block.text}
        </p>
      );
    case "bullets":
      return (
        <ul className="flex flex-col gap-0.5">
          {block.items.slice(0, lines).map((item, index) => (
            <li
              className="flex gap-2 text-[14px] text-duet-ink-2 leading-[19px]"
              // biome-ignore lint/suspicious/noArrayIndexKey: two bullets may say the same thing.
              key={index}
            >
              <span
                aria-hidden
                className="mt-[8px] size-1 shrink-0 rounded-full bg-duet-ink-3"
              />
              <span className="line-clamp-1 min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      );
    case "metrics":
      return (
        <ul className="grid grid-cols-3 gap-1.5">
          {block.items.slice(0, 3).map((metric, index) => (
            <li
              className="min-w-0 rounded-[10px] bg-duet-tile px-2 py-1.5"
              // biome-ignore lint/suspicious/noArrayIndexKey: two tiles may share a label.
              key={index}
            >
              <span className="block truncate font-semibold text-[16px] tabular-nums leading-5">
                {metric.value}
              </span>
              <span className="block truncate text-[11px] text-duet-ink-2 leading-[14px]">
                {metric.label}
              </span>
            </li>
          ))}
        </ul>
      );
    case "bars":
      return <BarChart compact items={block.items} label={block.label} />;
    case "list":
      return (
        <ul className="flex flex-col">
          {block.items.slice(0, tight ? 2 : 3).map((item, index) => (
            <li
              className="flex items-center gap-1 text-[14px] leading-[19px]"
              // biome-ignore lint/suspicious/noArrayIndexKey: rows may repeat a line.
              key={index}
            >
              {onListItem ? (
                <button
                  className="flex min-w-0 flex-1 items-center gap-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-duet-violet/40"
                  onClick={() => onListItem(item.text)}
                  type="button"
                >
                  <span className="min-w-0 flex-1 truncate">{item.text}</span>
                  <DuetIcon
                    className="text-duet-ink-3"
                    name="chevronRight"
                    size={14}
                    stroke={2.2}
                  />
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate">{item.text}</span>
              )}
            </li>
          ))}
        </ul>
      );
  }
}
