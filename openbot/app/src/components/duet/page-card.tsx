import { PAGE_KIND_LABELS, type PageKind } from "@openbot/shared/page-look";
import { sanitizeThumbnail } from "@openbot/shared/thumbnail";
import { type ReactNode, useCallback } from "react";
import { clockTime } from "@/lib/approval-view";
import type { PageBlock, PageSummary } from "@/lib/pages/queries";
import { cn } from "@/lib/utils";
import { DuetIcon } from "./icons";
import { DuetCard } from "./kit";
import { type CardSize, registerCard, rememberOpenedFrom } from "./page-morph";
import { SafeSvg } from "./page-rich-block";
import { isDashboard } from "./page-view";

/*
 * The card for something the Bot made: a preview drawn from its content, its title, when it last
 * changed, and a chevron. The same card sits under the Bot's line in Chat, a row wide, and in the
 * Make grid, half as wide, and pressing it opens the page. The caller supplies the link, since Chat
 * opens it over the conversation and Make opens it over the grid. The sheet grows out of the card
 * (page-morph.tsx), so the card says where it is and what it looks like.
 *
 * The preview is drawn from the page's own blocks in the shell's components, small: never a picture
 * of the page, and never the page itself in a frame. It sits on the neutral tile, whatever the kind
 * or theme: the card, the Make tile and the opened page share one surface, and the only colour in
 * them is the accent on what it marks, such as a chart's highlighted bar.
 */

/** "Updated 5:52 AM" today, "Updated Oct 20" before that. */
export function updatedLabel(iso: string, now = new Date()): string {
  const when = clockTime(iso, now);
  return when ? `Updated ${when}` : "";
}

/** The preview area's height, by size. Tall enough for a thumbnail, short enough to keep moving. */
const PREVIEW_HEIGHT: Record<CardSize, number> = { row: 150, grid: 116 };

/** What a page is, in a word: the Make filters and the grid's cards say it this way. */
export const KIND_LABEL = PAGE_KIND_LABELS;

export function PageCard({
  page,
  link,
  now,
  size = "row",
}: {
  page: PageSummary;
  /** Wraps the card in whatever opens it: a router link, given the card's content and class. */
  link: (props: { className: string; children: ReactNode }) => ReactNode;
  now?: Date;
  /** A row in Chat, or a cell of the Make grid. */
  size?: CardSize;
}) {
  // On screen, the sheet can find it to grow from and to shrink back into.
  const register = useCallback(
    (element: HTMLDivElement | null) =>
      element ? registerCard(element, page, size) : undefined,
    [page, size],
  );
  return link({
    className: cn(
      "group block w-full outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40",
      size === "grid" ? "rounded-[20px]" : "rounded-[22px]",
    ),
    children: (
      <DuetCard
        className={cn(
          "transition-transform motion-safe:group-active:scale-[0.985]",
          size === "grid" && "rounded-[20px]",
        )}
        // Before the link navigates: the sheet it opens reads this as it mounts.
        onClick={(event) => rememberOpenedFrom(event.currentTarget, page, size)}
        ref={register}
      >
        <PageCardFace now={now} page={page} size={size} />
      </DuetCard>
    ),
  });
}

/**
 * The card's content without the card: its preview, then its title and when it changed. The sheet's
 * stand-in draws it too, so what grows into the sheet is what was pressed.
 */
export function PageCardFace({
  page,
  size = "row",
  now,
}: {
  page: PageSummary;
  size?: CardSize;
  now?: Date | undefined;
}) {
  const kind = previewKind(page);
  if (size === "grid") {
    const when = clockTime(page.updatedAt, now);
    return (
      <>
        <div
          aria-hidden
          className="relative overflow-hidden bg-duet-tile"
          data-preview={kind}
          style={{ height: PREVIEW_HEIGHT.grid }}
        >
          <PagePreview page={page} size="grid" />
        </div>
        <div className="min-h-[64px] px-3 pt-2.5 pb-3">
          <p className="line-clamp-2 font-semibold text-[15px] text-duet-ink leading-[19px] tracking-[-0.01em]">
            {page.title}
          </p>
          <p className="type-label mt-0.5 truncate text-duet-ink-3">
            {when ? `${KIND_LABEL[kind]} · ${when}` : KIND_LABEL[kind]}
          </p>
        </div>
      </>
    );
  }
  const updated = updatedLabel(page.updatedAt, now);
  return (
    <>
      <div
        aria-hidden
        className="relative overflow-hidden bg-duet-tile"
        data-preview={kind}
        style={{ height: PREVIEW_HEIGHT.row }}
      >
        <PagePreview page={page} size="row" />
      </div>
      <div className="flex min-h-[66px] items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="type-row truncate font-semibold text-duet-ink">
            {page.title}
          </p>
          {updated ? (
            <p className="type-label mt-0.5 text-duet-ink-3">{updated}</p>
          ) : null}
        </div>
        <span className="shrink-0 text-duet-ink-3">
          <DuetIcon name="chevronRight" size={18} stroke={2.2} />
        </span>
      </div>
    </>
  );
}

/** Which preview a page gets: a deck's first slide, a dashboard's figures, or a page's first lines. */
export function previewKind(page: PageSummary): PageKind {
  if (page.kind !== "page") return page.kind;
  return isDashboard(page.preview.blocks) ? "dashboard" : "page";
}

function PagePreview({ page, size }: { page: PageSummary; size: CardSize }) {
  if (sanitizeThumbnail(page.thumbnail))
    return <SafeSvg className="absolute inset-0" svg={page.thumbnail} />;
  switch (previewKind(page)) {
    case "slides":
      return <SlidePreview page={page} size={size} />;
    case "dashboard":
      return (
        <DashboardPreview
          blocks={page.preview.blocks}
          size={size}
          title={page.title}
        />
      );
    case "page":
    case "doc":
    case "design":
    case "design-system":
      return (
        <DocumentPreview
          blocks={page.preview.blocks}
          size={size}
          title={page.title}
        />
      );
  }
}

/**
 * A page as a sheet of paper seen from above: its title, then its first blocks with every line of
 * text as a soft bar. The sheet runs off the bottom of the preview, as a long page would.
 */
function DocumentPreview({
  title,
  blocks,
  size,
}: {
  title: string;
  blocks: readonly PageBlock[];
  size: CardSize;
}) {
  const grid = size === "grid";
  // In the grid, a page that opens with a heading leads with it; any other leads with its title.
  const [first] = blocks;
  const opensWithHeading = grid && first?.type === "heading";
  const heading = opensWithHeading ? first.text : title;
  return (
    <div
      className={cn(
        "absolute bg-duet-card shadow-[0_0_0_1px_var(--duet-hair),0_8px_20px_-14px_rgb(1_5_7/22%)]",
        grid
          ? "inset-x-3 top-3 -bottom-5 rounded-[10px] px-3 pt-3"
          : "inset-x-6 top-4 -bottom-6 rounded-[14px] px-4 pt-4",
      )}
    >
      <p
        className={cn(
          "line-clamp-2 font-semibold text-duet-ink",
          grid
            ? "text-[13px] leading-[16px] tracking-[-0.006em]"
            : "text-[17px] leading-[21px] tracking-[-0.012em]",
        )}
      >
        {heading}
      </p>
      <div
        className={cn("flex flex-col", grid ? "mt-2.5 gap-2" : "mt-3 gap-2.5")}
      >
        {(grid ? blocks.slice(opensWithHeading ? 1 : 0, 3) : blocks).map(
          (block, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a page's blocks are fixed in order.
            <SkeletonBlock block={block} key={index} />
          ),
        )}
      </div>
    </div>
  );
}

/** How many lines of skeleton a run of text stands for: one to three. */
function linesFor(text: string): number {
  return Math.min(3, Math.max(1, Math.ceil(text.length / 70)));
}

const LINE_WIDTHS = ["100%", "92%", "68%"];

function Bars({ count, strong = false }: { count: number; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-[7px]">
      {LINE_WIDTHS.slice(0, count).map((width, index) => (
        <span
          className={cn(
            "block h-[6px] rounded-full",
            strong ? "bg-duet-ink-3/55" : "bg-duet-ink-3/25",
          )}
          key={width}
          style={{ width: index === count - 1 && count > 1 ? "68%" : width }}
        />
      ))}
    </div>
  );
}

function SkeletonBlock({ block }: { block: PageBlock }) {
  switch (block.type) {
    case "image":
      return <SafeSvg className="h-14" svg={block.svg} />;
    case "table":
      return (
        <div className="grid grid-cols-3 gap-1">
          {block.rows.slice(0, 3).flatMap((row, i) =>
            row.slice(0, 3).map((cell, j) => (
              <span
                className="h-3 rounded bg-duet-ink-3/20"
                // biome-ignore lint/suspicious/noArrayIndexKey: saved table cells keep their position.
                key={`${i}-${j}`}
                title={cell}
              />
            )),
          )}
        </div>
      );
    case "timeline":
    case "checklist":
      return <Bars count={Math.min(block.items.length, 3)} strong />;
    case "comparison":
      return (
        <div className="flex gap-2">
          {block.columns.map((column, index) => (
            <span
              className="min-w-0 flex-1 rounded bg-duet-ink-3/15 p-1 text-[9px]"
              // biome-ignore lint/suspicious/noArrayIndexKey: comparison columns may share a title and have no persistent identity.
              key={index}
            >
              {column.title}
            </span>
          ))}
        </div>
      );
    case "decision":
      return (
        <p className="text-[10px] text-duet-ink-2">
          {block.pick ? `Pick: ${block.pick}` : block.question}
        </p>
      );
    case "heading":
      return (
        <span className="mt-1 block h-[8px] w-[46%] rounded-full bg-duet-ink-3/55" />
      );
    case "text":
      return <Bars count={linesFor(block.text)} />;
    case "bullets":
      return (
        <div className="flex flex-col gap-[7px]">
          {block.items.slice(0, 3).map((item, index) => (
            <span
              className="flex items-center gap-2"
              // biome-ignore lint/suspicious/noArrayIndexKey: two bullets may say the same thing.
              key={index}
            >
              <span className="size-[5px] shrink-0 rounded-full bg-duet-ink-3/55" />
              <span
                className="block h-[6px] rounded-full bg-duet-ink-3/25"
                style={{ width: `${Math.min(88, 40 + item.length)}%` }}
              />
            </span>
          ))}
        </div>
      );
    case "metrics":
      return (
        <div className="grid grid-cols-3 gap-1.5">
          {block.items.slice(0, 3).map((_metric, index) => (
            <span
              className="flex h-[30px] flex-col justify-center gap-[5px] rounded-[7px] bg-duet-tile px-2"
              // biome-ignore lint/suspicious/noArrayIndexKey: two tiles may share a label.
              key={index}
            >
              <span className="block h-[6px] w-[70%] rounded-full bg-duet-ink-3/55" />
              <span className="block h-[4px] w-[45%] rounded-full bg-duet-ink-3/25" />
            </span>
          ))}
        </div>
      );
    case "bars":
      return <MiniBars block={block} height={34} />;
    case "list":
      return (
        <div className="flex flex-col gap-[7px]">
          {block.items.slice(0, 2).map((item, index) => (
            <span
              className="flex items-center gap-2"
              // biome-ignore lint/suspicious/noArrayIndexKey: rows may repeat a line.
              key={index}
            >
              <span
                className="block h-[6px] rounded-full bg-duet-ink-3/25"
                style={{ width: `${Math.min(80, 30 + item.text.length)}%` }}
              />
            </span>
          ))}
        </div>
      );
  }
}

/** A chart at thumbnail size, keeping its shared scale and original highlighted bar. */
function MiniBars({
  block,
  height,
}: {
  block: Extract<PageBlock, { type: "bars" }>;
  height: number;
}) {
  const { items, scale, highlight } = block;
  const max = scale ?? Math.max(...items.map((item) => item.value), 0);
  return (
    <div className="flex w-full items-end gap-[3px]" style={{ height }}>
      {items.map((item, index) => (
        <span
          className={cn(
            "block flex-1 rounded-[2px]",
            index === (highlight ?? items.length - 1)
              ? "bg-duet-violet"
              : "bg-duet-ink-3/35",
          )}
          // biome-ignore lint/suspicious/noArrayIndexKey: two bars may share a label.
          key={index}
          title={item.label}
          style={{
            height: `${Math.max(max > 0 ? (item.value / max) * 100 : 0, 6)}%`,
          }}
        />
      ))}
    </div>
  );
}

/** A dashboard's first headline and figures, wherever they occur in its saved blocks. */
function DashboardPreview({
  blocks,
  size,
  title,
}: {
  blocks: readonly PageBlock[];
  size: CardSize;
  title: string;
}) {
  const grid = size === "grid";
  const headline = blocks.find(
    (block) => block.type === "text" || block.type === "heading",
  );
  const metrics = blocks.find((block) => block.type === "metrics");
  if (!metrics)
    return <DocumentPreview blocks={blocks} size={size} title={title} />;
  return (
    <div
      className={cn("flex h-full flex-col", grid ? "px-3 pt-3" : "px-4 pt-4")}
    >
      <p
        className={cn(
          "font-semibold text-duet-ink",
          grid
            ? "line-clamp-2 text-[13px] leading-[16px] tracking-[-0.006em]"
            : "line-clamp-2 text-[16px] leading-[20px] tracking-[-0.01em]",
        )}
      >
        {headline?.text ?? title}
      </p>
      <div
        className={cn(
          "grid",
          grid ? "mt-2.5 grid-cols-2 gap-1.5" : "mt-3 grid-cols-3 gap-2",
        )}
      >
        {metrics.items.slice(0, grid ? 2 : 3).map((metric, index) => (
          <div
            className={cn(
              "min-w-0 bg-duet-card shadow-[0_0_0_1px_var(--duet-hair-2)]",
              grid ? "rounded-[9px] px-2 py-1.5" : "rounded-[12px] px-2.5 py-2",
            )}
            // biome-ignore lint/suspicious/noArrayIndexKey: two tiles may share a label.
            key={index}
          >
            <p
              className={cn(
                "truncate font-semibold text-duet-ink tabular-nums",
                grid
                  ? "text-[15px] leading-[19px] tracking-[-0.012em]"
                  : "text-[17px] leading-[21px] tracking-[-0.015em]",
              )}
            >
              {metric.value}
            </p>
            <p
              className={cn(
                "truncate text-duet-ink-2",
                grid
                  ? "text-[10px] leading-[13px]"
                  : "text-[11px] leading-[14px]",
              )}
            >
              {metric.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A deck: one slide as a 16:9 thumbnail, the first with a chart when there is one (the server
 * picks it), with the slide's title and its chart drawn as real bars. A slide
 * with no chart shows its other lines as soft bars.
 */
function SlidePreview({ page, size }: { page: PageSummary; size: CardSize }) {
  const grid = size === "grid";
  const chart = page.preview.blocks.find((block) => block.type === "bars");
  const others = page.preview.blocks.filter((block) => block.type !== "bars");
  return (
    <div
      className={cn(
        "absolute inset-x-0 flex justify-center",
        grid ? "top-3.5" : "top-4",
      )}
    >
      <div
        className={cn(
          "flex aspect-video flex-col bg-duet-card shadow-[0_0_0_1px_var(--duet-hair),0_8px_20px_-14px_rgb(1_5_7/22%)]",
          grid
            ? "h-[80px] rounded-[7px] px-2 pt-1.5 pb-1.5"
            : "h-[118px] rounded-[10px] px-3 pt-2.5 pb-2.5",
        )}
      >
        <p
          className={cn(
            "line-clamp-1 font-semibold text-duet-ink",
            grid ? "text-[9.5px] leading-[12px]" : "text-[12px] leading-[15px]",
          )}
        >
          {page.preview.title ?? page.title}
        </p>
        {chart && chart.type === "bars" ? (
          <div
            className={cn(
              "flex min-h-0 flex-1 items-end",
              grid ? "mt-1.5" : "mt-2",
            )}
          >
            <MiniBars block={chart} height={grid ? 44 : 64} />
          </div>
        ) : (
          <div
            className={cn(
              "flex flex-col",
              grid ? "mt-2 gap-1.5" : "mt-2.5 gap-2",
            )}
          >
            {others.slice(0, 2).map((block, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a slide's blocks are fixed in order.
              <SkeletonBlock block={block} key={index} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
