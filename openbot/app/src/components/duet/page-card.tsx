import type { ReactNode } from "react";
import { clockTime } from "@/lib/approval-view";
import type { PageBlock, PageSummary } from "@/lib/pages/queries";
import { cn } from "@/lib/utils";
import { DuetIcon } from "./icons";
import { DuetCard } from "./kit";
import { isDashboard } from "./page-view";

/*
 * The card for something the Bot made: a preview drawn from its content, its title, when it last
 * changed, and a chevron. The same card sits under the Bot's line in Chat and in the Pages list, and
 * pressing it opens the page. The caller supplies the link, since Chat opens it over the
 * conversation and Pages opens it over the list.
 *
 * The preview is drawn from the page's own blocks in the shell's components, small: never a picture
 * of the page, and never the page itself in a frame.
 */

/** "Updated 5:52 AM" today, "Updated Oct 20" before that. */
export function updatedLabel(iso: string, now = new Date()): string {
  const when = clockTime(iso, now);
  return when ? `Updated ${when}` : "";
}

/** The preview area's height. Tall enough for a thumbnail, short enough to keep the thread moving. */
const PREVIEW_HEIGHT = 150;

export function PageCard({
  page,
  link,
  now,
}: {
  page: PageSummary;
  /** Wraps the card in whatever opens it: a router link, given the card's content and class. */
  link: (props: { className: string; children: ReactNode }) => ReactNode;
  now?: Date;
}) {
  const updated = updatedLabel(page.updatedAt, now);
  return link({
    className:
      "group block w-full rounded-[22px] outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40",
    children: (
      <DuetCard className="transition-transform duration-150 motion-safe:group-active:scale-[0.985]">
        <div
          aria-hidden
          className="relative overflow-hidden bg-duet-tile"
          data-preview={previewKind(page)}
          style={{ height: PREVIEW_HEIGHT }}
        >
          <PagePreview page={page} />
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
      </DuetCard>
    ),
  });
}

/** Which preview a page gets: a deck's first slide, a dashboard's figures, or a page's first lines. */
export function previewKind(
  page: PageSummary,
): "slides" | "dashboard" | "page" {
  if (page.kind === "slides") return "slides";
  return isDashboard(page.preview.blocks) ? "dashboard" : "page";
}

function PagePreview({ page }: { page: PageSummary }) {
  switch (previewKind(page)) {
    case "slides":
      return <SlidePreview page={page} />;
    case "dashboard":
      return <DashboardPreview blocks={page.preview.blocks} />;
    case "page":
      return (
        <DocumentPreview blocks={page.preview.blocks} title={page.title} />
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
}: {
  title: string;
  blocks: readonly PageBlock[];
}) {
  return (
    <div className="absolute inset-x-6 top-4 -bottom-6 rounded-[14px] bg-duet-card px-4 pt-4 shadow-[0_0_0_1px_var(--duet-hair),0_8px_20px_-14px_rgb(1_5_7/22%)]">
      <p className="line-clamp-2 font-semibold text-[17px] text-duet-ink leading-[21px] tracking-[-0.012em]">
        {title}
      </p>
      <div className="mt-3 flex flex-col gap-2.5">
        {blocks.map((block, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a page's blocks are fixed in order.
          <SkeletonBlock block={block} key={index} />
        ))}
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
      return <MiniBars items={block.items} height={34} />;
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

/** Bars with no figures, the last one violet: the shape of a chart at thumbnail size. */
function MiniBars({
  items,
  height,
}: {
  items: readonly { value: number }[];
  height: number;
}) {
  const max = Math.max(...items.map((item) => item.value), 0);
  return (
    <div className="flex w-full items-end gap-[3px]" style={{ height }}>
      {items.map((item, index) => (
        <span
          className={cn(
            "block flex-1 rounded-[2px]",
            index === items.length - 1 ? "bg-duet-violet" : "bg-duet-ink-3/35",
          )}
          // biome-ignore lint/suspicious/noArrayIndexKey: two bars may share a value.
          key={index}
          style={{
            height: `${Math.max(max > 0 ? (item.value / max) * 100 : 0, 6)}%`,
          }}
        />
      ))}
    </div>
  );
}

/** A dashboard: its headline sentence over the first three figures. */
function DashboardPreview({ blocks }: { blocks: readonly PageBlock[] }) {
  const [headline, metrics] = blocks;
  return (
    <div className="flex h-full flex-col px-4 pt-4">
      <p className="line-clamp-2 font-semibold text-[16px] text-duet-ink leading-[20px] tracking-[-0.01em]">
        {headline?.type === "text" ? headline.text : ""}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {(metrics?.type === "metrics" ? metrics.items : [])
          .slice(0, 3)
          .map((metric, index) => (
            <div
              className="min-w-0 rounded-[12px] bg-duet-card px-2.5 py-2 shadow-[0_0_0_1px_var(--duet-hair-2)]"
              // biome-ignore lint/suspicious/noArrayIndexKey: two tiles may share a label.
              key={index}
            >
              <p className="truncate font-semibold text-[17px] text-duet-ink tabular-nums leading-[21px] tracking-[-0.015em]">
                {metric.value}
              </p>
              <p className="truncate text-[11px] text-duet-ink-2 leading-[14px]">
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
 * picks it), with the slide's title and its chart drawn as real bars, the last one violet. A slide
 * with no chart shows its other lines as soft bars.
 */
function SlidePreview({ page }: { page: PageSummary }) {
  const chart = page.preview.blocks.find((block) => block.type === "bars");
  const others = page.preview.blocks.filter((block) => block.type !== "bars");
  return (
    <div className="absolute inset-x-0 top-4 flex justify-center">
      <div className="flex aspect-video h-[118px] flex-col rounded-[10px] bg-duet-card px-3 pt-2.5 pb-2.5 shadow-[0_0_0_1px_var(--duet-hair),0_8px_20px_-14px_rgb(1_5_7/22%)]">
        <p className="line-clamp-1 font-semibold text-[12px] text-duet-ink leading-[15px]">
          {page.preview.title ?? page.title}
        </p>
        {chart && chart.type === "bars" ? (
          <div className="mt-2 flex min-h-0 flex-1 items-end">
            <MiniBars items={chart.items} height={64} />
          </div>
        ) : (
          <div className="mt-2.5 flex flex-col gap-2">
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
