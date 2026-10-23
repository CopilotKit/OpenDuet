import { z } from "zod";

/*
 * What a page the Bot makes is made of, checked once here and trusted everywhere after: the tool
 * refuses anything else, the table stores only what passed, and the app draws only these shapes.
 *
 * A page is a short list of blocks and a deck is a short list of slides, each slide holding a
 * few blocks. Blocks rather than markdown or HTML because the app draws every one of them in its own
 * components: nothing a model writes is ever rendered as markup, and a preview can be drawn from the
 * same data as the page itself.
 */

export const PAGE_KINDS = ["page", "slides"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export const MAX_TITLE = 80;
export const MAX_SUMMARY = 140;
export const MAX_BLOCKS = 40;
export const MAX_SLIDES = 20;
export const MAX_SLIDE_BLOCKS = 3;
export const MAX_METRICS = 8;
export const MAX_BARS = 12;
export const MAX_LIST = 8;
export const MAX_BULLETS = 12;

/*
 * What one slide holds. A page scrolls, so its caps are about length. A slide doesn't: it is one
 * frame, and the viewer shows all of it, so these are what reads in full on a 390px-wide phone (the
 * frame is described with the fit check, below). Each count is the most that fits with short items
 * and nothing else on the slide; the fit check then refuses a slide whose blocks fit apart but not
 * together.
 */
/** Two rows of two half-width tiles. A third row of tiles with notes runs past the frame. */
export const SLIDE_MAX_METRICS = 4;
/** Six bullets of up to two lines each, under the slide's title, fill the frame (294 of 298px). */
export const SLIDE_MAX_BULLETS = 6;
/** Five rows at the 44px a tap target needs, under a list title and the slide's title (282px); a sixth runs past. */
export const SLIDE_MAX_LIST = 5;
/** Eight bars are 32px wide each, room for a 13px figure such as "1.2K" (31px). A ninth makes them too narrow. */
export const SLIDE_MAX_BARS = 8;

const line = (max: number) => z.string().trim().min(1).max(max);

const heading = z
  .object({ type: z.literal("heading"), text: line(120) })
  .strict();
const text = z.object({ type: z.literal("text"), text: line(2_000) }).strict();

/** The most of each kind of item a block takes, and what to say when there are more. */
type Caps = Record<
  "metrics" | "bars" | "list" | "bullets",
  { max: number; message?: string }
>;

/** The six blocks, with a page's or a slide's caps. Everything but the counts is the same. */
function blockSchemaWith(caps: Caps) {
  const most = (cap: Caps[keyof Caps]) =>
    [cap.max, cap.message ? { message: cap.message } : undefined] as const;
  const bullets = z
    .object({
      type: z.literal("bullets"),
      items: z
        .array(line(300))
        .min(1)
        .max(...most(caps.bullets)),
    })
    .strict();
  const metrics = z
    .object({
      type: z.literal("metrics"),
      items: z
        .array(
          z
            .object({
              label: line(40).describe(
                'What it measures: "Revenue this week".',
              ),
              value: line(24).describe(
                'The figure as it should read: "$528K".',
              ),
              note: line(60)
                .optional()
                .describe('One short line under it: "+11% vs last year".'),
            })
            .strict(),
        )
        .min(1)
        .max(...most(caps.metrics)),
    })
    .strict();
  const bars = z
    .object({
      type: z.literal("bars"),
      label: line(60).optional(),
      items: z
        .array(
          z
            .object({
              label: line(24),
              value: z.number().finite().min(0),
            })
            .strict(),
        )
        .min(1)
        .max(...most(caps.bars)),
    })
    .strict();
  const list = z
    .object({
      type: z.literal("list"),
      title: line(60).optional(),
      items: z
        .array(
          z
            .object({
              text: line(80).describe("Something worth a closer look."),
              note: line(80).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(...most(caps.list)),
    })
    .strict();
  return z.discriminatedUnion("type", [
    heading,
    text,
    bullets,
    metrics,
    bars,
    list,
  ]);
}

export const pageBlockSchema = blockSchemaWith({
  metrics: { max: MAX_METRICS },
  bars: { max: MAX_BARS },
  list: { max: MAX_LIST },
  bullets: { max: MAX_BULLETS },
});
export type PageBlock = z.infer<typeof pageBlockSchema>;

/** Said when a slide's block has more than one slide shows. */
const moreThanASlide = (most: number, what: string) =>
  `A slide shows at most ${most} ${what}. Put the rest on a new slide.`;

const slideBlockSchema = blockSchemaWith({
  metrics: {
    max: SLIDE_MAX_METRICS,
    message: moreThanASlide(SLIDE_MAX_METRICS, "metrics"),
  },
  bars: {
    max: SLIDE_MAX_BARS,
    message: moreThanASlide(SLIDE_MAX_BARS, "bars"),
  },
  list: {
    max: SLIDE_MAX_LIST,
    message: moreThanASlide(SLIDE_MAX_LIST, "rows"),
  },
  bullets: {
    max: SLIDE_MAX_BULLETS,
    message: moreThanASlide(SLIDE_MAX_BULLETS, "bullets"),
  },
});

export const pageSlideSchema = z
  .object({
    title: line(MAX_TITLE),
    blocks: z
      .array(slideBlockSchema)
      .max(MAX_SLIDE_BLOCKS, {
        message: moreThanASlide(MAX_SLIDE_BLOCKS, "blocks"),
      })
      .default([]),
  })
  .strict()
  .superRefine((slide, context) => {
    for (const issue of slideFitIssues(slide)) context.addIssue(issue);
  });
export type PageSlide = z.infer<typeof pageSlideSchema>;

/** What the table's `content` column holds: a page's blocks, or a deck's slides. */
export type PageContent = { blocks: PageBlock[] } | { slides: PageSlide[] };

/*
 * The fit check: how tall a slide draws on a 390px-wide phone, worked out from its words, so a deck
 * that would not show in full is refused at save instead of cut short in the viewer.
 *
 * The frame. On a 390px phone the open deck leaves a slide 330 to 334px wide (the sheet's margins
 * are in rem, so the root size moves them by a few pixels; 330 is the narrower). Inside 16px of
 * padding that is 298px of content. A slide may be as tall as it is wide: a square, the tallest a
 * slide gets and still sits on a 390x664 screen (a phone browser with its bars showing) with the
 * sheet's header and the deck's arrows. What fits a square at these sizes also fits a 16:9 slide
 * held sideways, which is wider and barely shorter.
 *
 * The measure. It lays the words out the way the browser does, line by line, from each character's
 * advance in Inter and in the system font, whichever is wider, so it reads a little long, never
 * short. The sizes are the viewer's (`SlideCard` in app/src/components/duet/page-view.tsx): an
 * 18/22 title, 15/20 text, 13/16 captions, 12px between blocks. Change one there, change it here.
 */

/** A slide's content width on a 390px phone: 330px wide, less 16px of padding a side. */
export const SLIDE_FIT_WIDTH = 298;
/** The most a slide's content may stand: as tall as it is wide. */
export const SLIDE_FIT_HEIGHT = 298;

const BLOCK_GAP = 12;

/*
 * Each printable ASCII character's advance, in thousandths of an em, from " " (32) to "~" (126):
 * the wider of Inter and the system font (San Francisco), measured in Chrome. Digits all take the
 * widest digit, since figures are drawn in tabular numerals. Weight 600 stands in for 500 too.
 */
const REGULAR = [
  282, 288, 466, 634, 642, 982, 669, 300, 365, 365, 501, 662, 289, 460, 289,
  361, 646, 646, 646, 646, 646, 646, 646, 646, 646, 646, 289, 302, 662, 662,
  662, 512, 966, 690, 655, 731, 722, 602, 591, 747, 744, 269, 571, 672, 566,
  904, 754, 765, 639, 765, 644, 642, 646, 745, 690, 986, 683, 679, 629, 365,
  361, 365, 605, 527, 500, 562, 613, 572, 613, 584, 371, 614, 592, 243, 243,
  549, 243, 876, 591, 600, 613, 613, 377, 528, 328, 592, 563, 819, 546, 563,
  553, 427, 333, 427, 662,
];
const BOLD = [
  282, 322, 523, 644, 651, 1005, 691, 326, 374, 374, 540, 674, 319, 466, 319,
  379, 667, 667, 667, 667, 667, 667, 667, 667, 667, 667, 319, 330, 674, 674,
  674, 544, 1000, 728, 660, 737, 723, 606, 589, 750, 746, 277, 580, 704, 566,
  923, 760, 769, 645, 773, 653, 651, 661, 737, 728, 1021, 720, 714, 653, 374,
  379, 374, 633, 560, 500, 575, 625, 583, 625, 592, 389, 626, 613, 262, 262,
  570, 262, 901, 612, 609, 625, 625, 398, 550, 354, 613, 588, 840, 569, 589,
  566, 455, 359, 455, 674,
];
type Face = typeof REGULAR;

/** A character's advance in ems. Past ASCII: a wide guess for Latin and punctuation, a full em or more beyond. */
function advance(character: string, face: Face): number {
  const code = character.codePointAt(0) ?? 0;
  if (code >= 32 && code < 127) return (face[code - 32] ?? 1000) / 1000;
  if (code > 0xffff) return 1.3;
  if (code >= 0x2e80) return 1;
  return 0.75;
}

function widthOf(text: string, size: number, face: Face): number {
  let width = 0;
  for (const character of text) width += advance(character, face);
  return width * size;
}

/**
 * How many lines a run of text takes in `width`: breaking at spaces, and inside a word only when the
 * word alone is wider than the line (`overflow-wrap: anywhere`). With `preLine`, a newline starts a
 * line, as `white-space: pre-line` does; otherwise it is a space.
 */
function linesOf(
  text: string,
  size: number,
  face: Face,
  width: number,
  preLine = false,
): number {
  const paragraphs = preLine ? text.split("\n") : [text];
  const space = widthOf(" ", size, face);
  let lines = 0;
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    lines += 1;
    let x = 0;
    for (const word of words) {
      const wide = widthOf(word, size, face);
      if (x > 0 && x + space + wide <= width) {
        x += space + wide;
        continue;
      }
      if (x > 0) lines += 1;
      x = 0;
      for (const character of word) {
        const step = advance(character, face) * size;
        if (x > 0 && x + step > width) {
          lines += 1;
          x = 0;
        }
        x += step;
      }
    }
  }
  return lines;
}

/** 12, 1.5K, 2.1M: a bar's figure as the viewer writes it (`formatValue` in page-view.tsx). */
const barFigure = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** The width of each column of a chart with `count` bars, 6px apart. */
const barWidth = (count: number) => (SLIDE_FIT_WIDTH - 6 * (count - 1)) / count;
/** The width of a figure's tile, and of the words inside its 10px of padding. */
const tileWidth = (count: number) =>
  (count > 1 ? (SLIDE_FIT_WIDTH - 8) / 2 : SLIDE_FIT_WIDTH) - 20;
/** A row's words: the slide's width less the chevron and its gap. */
const ROW_WIDTH = SLIDE_FIT_WIDTH - 24;
/** A bullet's words: the slide's width less the dot and its gap. */
const BULLET_WIDTH = SLIDE_FIT_WIDTH - 12;

/** How tall one block draws on a slide, in px. */
function blockHeight(block: PageBlock): number {
  const W = SLIDE_FIT_WIDTH;
  switch (block.type) {
    case "heading":
      return linesOf(block.text, 15, BOLD, W) * 20;
    case "text":
      return linesOf(block.text, 15, REGULAR, W, true) * 20;
    case "bullets":
      return (
        block.items.reduce(
          (sum, item) => sum + linesOf(item, 15, REGULAR, BULLET_WIDTH) * 20,
          0,
        ) +
        4 * (block.items.length - 1)
      );
    case "metrics": {
      const columns = block.items.length > 1 ? 2 : 1;
      const inner = tileWidth(block.items.length);
      const tiles = block.items.map(
        (metric) =>
          16 +
          linesOf(metric.value, 18, BOLD, inner) * 22 +
          linesOf(metric.label, 13, BOLD, inner) * 16 +
          (metric.note ? 2 + linesOf(metric.note, 13, REGULAR, inner) * 16 : 0),
      );
      let height = 0;
      for (let row = 0; row < tiles.length; row += columns)
        height +=
          Math.max(...tiles.slice(row, row + columns)) + (row > 0 ? 8 : 0);
      return height;
    }
    case "bars": {
      const column = barWidth(block.items.length);
      const caption = block.label
        ? linesOf(block.label, 13, BOLD, W) * 16 + 6
        : 0;
      const figures = Math.max(
        ...block.items.map((item) =>
          linesOf(barFigure.format(item.value), 13, BOLD, column),
        ),
      );
      const labels = Math.max(
        ...block.items.map((item) => linesOf(item.label, 13, REGULAR, column)),
      );
      return caption + figures * 16 + 2 + 72 + 4 + labels * 16;
    }
    case "list": {
      const title = block.title
        ? linesOf(block.title, 15, BOLD, W) * 20 + 4
        : 0;
      return (
        title +
        block.items.reduce(
          (sum, item) =>
            sum +
            Math.max(
              44,
              8 +
                linesOf(item.text, 15, BOLD, ROW_WIDTH) * 20 +
                (item.note
                  ? linesOf(item.note, 13, REGULAR, ROW_WIDTH) * 16
                  : 0),
            ),
          0,
        ) +
        (block.items.length - 1)
      );
    }
  }
}

/** How tall a slide's content draws on a 390px phone, in px: its title, then each block 12px apart. */
export function slideHeight(slide: {
  title: string;
  blocks: readonly PageBlock[];
}): number {
  return (
    linesOf(slide.title, 18, BOLD, SLIDE_FIT_WIDTH) * 22 +
    slide.blocks.reduce((sum, block) => sum + BLOCK_GAP + blockHeight(block), 0)
  );
}

type FitIssue = { code: "custom"; path: (string | number)[]; message: string };

/**
 * Figures the viewer would have to break mid-number: a value wider than its tile, a bar's figure or
 * a word of its label wider than its bar. Words in sentences may break; a figure may not, since "2
 * of 4 cr" over "acked" reads as a different number.
 */
function figureIssues(block: PageBlock, at: number): FitIssue[] {
  const issues: FitIssue[] = [];
  if (block.type === "metrics") {
    const inner = tileWidth(block.items.length);
    block.items.forEach((metric, index) => {
      const word = metric.value
        .split(/\s+/)
        .find((part) => widthOf(part, 18, BOLD) > inner);
      if (word)
        issues.push({
          code: "custom",
          path: ["blocks", at, "items", index, "value"],
          message: `"${metric.value}" is too wide for its tile on a phone. Write the figure shorter, such as "$1.2M" for "$1,234,567".`,
        });
    });
  }
  if (block.type === "bars") {
    const count = block.items.length;
    const column = barWidth(count);
    block.items.forEach((item, index) => {
      const figure = barFigure.format(item.value);
      if (widthOf(figure, 13, BOLD) > column)
        issues.push({
          code: "custom",
          path: ["blocks", at, "items", index, "value"],
          message: `${figure} is too wide for its bar on a phone with ${count} bars. Use fewer bars on this slide.`,
        });
      const word = item.label
        .split(/\s+/)
        .find((part) => widthOf(part, 13, REGULAR) > column);
      if (word)
        issues.push({
          code: "custom",
          path: ["blocks", at, "items", index, "label"],
          message: `"${word}" is too wide for its bar on a phone with ${count} bars. Use a shorter label, such as "Wed" for "Wednesday", or fewer bars.`,
        });
    });
  }
  return issues;
}

const SPLITTABLE = new Set<PageBlock["type"]>([
  "bullets",
  "metrics",
  "bars",
  "list",
]);

/** Everything about a slide that would not show in full on a phone, as issues the refusal names. */
function slideFitIssues(slide: {
  title: string;
  blocks: readonly PageBlock[];
}): FitIssue[] {
  const figures = slide.blocks.flatMap(figureIssues);
  if (figures.length > 0) return figures;
  const height = slideHeight(slide);
  if (height <= SLIDE_FIT_HEIGHT) return [];
  const title = linesOf(slide.title, 18, BOLD, SLIDE_FIT_WIDTH) * 22;
  let used = title;
  let advice = "Shorten the title or the text.";
  for (const [index, block] of slide.blocks.entries()) {
    const step = BLOCK_GAP + blockHeight(block);
    if (title + step > SLIDE_FIT_HEIGHT) {
      advice = SPLITTABLE.has(block.type)
        ? `Block ${index} (${block.type}) is too long for any one slide: keep some of its items here and put the rest in the same kind of block on a new slide.`
        : `Block ${index} (${block.type}) is too long for any one slide: shorten it, or carry it on in a new slide.`;
      break;
    }
    if (used + step > SLIDE_FIT_HEIGHT) {
      const moved = slide.blocks
        .slice(index)
        .map((later) => later.type)
        .join(", ");
      advice = `Keep the blocks before block ${index} here and move the rest (${moved}) to a new slide.`;
      break;
    }
    used += step;
  }
  return [
    {
      code: "custom",
      path: [],
      message: `This slide is too full to read on a phone: it needs about ${Math.ceil(height)}px and a slide has ${SLIDE_FIT_HEIGHT}px. ${advice}`,
    },
  ];
}
