import {
  blockHeight,
  figuresTooWide,
  SLIDE_BLOCK_GAP,
  SLIDE_FIT_HEIGHT,
  type SlideShape,
  slideHeight,
  titleHeight,
} from "@openbot/shared/slide-fit";
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
 * frame, and the viewer shows all of it, so these are what reads in full in that frame (a square of
 * 298px of content, laid out at 330px wide and scaled to the phone: see shared/slide-fit.ts). Each
 * count is the most that fits with short items and nothing else on the slide; the fit check then
 * refuses a slide whose blocks fit apart but not together.
 */
/** Two rows of two half-width tiles. A third row of tiles with notes runs past the frame. */
export const SLIDE_MAX_METRICS = 4;
/** Six bullets of up to two lines each, under the slide's title, fill the frame (294 of 298px). */
export const SLIDE_MAX_BULLETS = 6;
/** Five rows at the 44px a tap target needs, under a list title and the slide's title (282px); a sixth runs past. */
export const SLIDE_MAX_LIST = 5;
/** The most bars that still stand in columns, the shape a chart is read by: 32px each, room for "1.2K" (31px). */
export const SLIDE_MAX_BARS = 8;

export { SLIDE_FIT_HEIGHT, slideHeight };

/**
 * The line every slide refusal ends on, and the make_page tool's own refusal too.
 *
 * A split is between the model and the tool. Told only what to fix, a model fixed it and then told
 * the person "A slide holds at most 5 rows", or made a page when they had asked for a deck. The
 * person should see one card when it lands, the kind they asked for.
 */
export const FIX_SILENTLY =
  'Fix it silently: never mention a limit, a split, what fits or a retry to the person, write nothing to them until the retry is saved, and keep making the same kind with this tool (a deck stays a deck). If the deck ends up longer than they asked, say only how many slides it has, such as "It\'s 3 slides.", and never why.';

/**
 * How a limit is written. Enforced, for the parser `make_page` runs on every call; or only stated,
 * for the schema the model is offered.
 *
 * TWO SCHEMAS, ONE SOURCE. The AI SDK checks a tool's input against the schema it is handed before
 * the tool runs, and answers a failure itself, with the whole input pasted back and none of this
 * tool's words. Handed the stated schema, it checks only the shape; every limit is then checked by
 * the parser, whose refusal says how to fix it and to do so silently. Both are built here from the
 * same calls, so the model is offered exactly the limits the parser enforces.
 */
export type Limits = { enforce: boolean };
export const ENFORCED: Limits = { enforce: true };
export const STATED: Limits = { enforce: false };

/** A trimmed, non-empty line of at most `max` characters. */
export function line(limits: Limits, max: number) {
  return limits.enforce
    ? z.string().trim().min(1).max(max)
    : z.string().meta({ minLength: 1, maxLength: max });
}

/** One to `max` of `item`, saying `message` when there are more. */
export function many<T extends z.ZodType>(
  limits: Limits,
  item: T,
  max: number,
  message?: string,
) {
  return limits.enforce
    ? z
        .array(item)
        .min(1)
        .max(max, message ? { message } : undefined)
    : z.array(item).meta({ minItems: 1, maxItems: max });
}

/** At most `max` of `item`, and possibly none. */
export function upTo<T extends z.ZodType>(
  limits: Limits,
  item: T,
  max: number,
  message?: string,
) {
  return limits.enforce
    ? z.array(item).max(max, message ? { message } : undefined)
    : z.array(item).meta({ maxItems: max });
}

/** An object that takes no keys but these. */
export function closed<T extends z.ZodRawShape>(limits: Limits, shape: T) {
  return limits.enforce
    ? z.object(shape).strict()
    : z.object(shape).meta({ additionalProperties: false });
}

/** A number, zero or more. */
function amount(limits: Limits) {
  return limits.enforce
    ? z.number().finite().min(0)
    : z.number().meta({ minimum: 0 });
}

/** The most of each kind of item a block takes, and what to say when there are more. */
type Caps = Record<
  "metrics" | "bars" | "list" | "bullets",
  { max: number; message?: string }
>;

/** The six blocks, with a page's or a slide's caps. Everything but the counts is the same. */
function blockSchemaWith(limits: Limits, caps: Caps) {
  const heading = closed(limits, {
    type: z.literal("heading"),
    text: line(limits, 120),
  });
  const text = closed(limits, {
    type: z.literal("text"),
    text: line(limits, 2_000),
  });
  const bullets = closed(limits, {
    type: z.literal("bullets"),
    items: many(
      limits,
      line(limits, 300),
      caps.bullets.max,
      caps.bullets.message,
    ),
  });
  const metrics = closed(limits, {
    type: z.literal("metrics"),
    items: many(
      limits,
      closed(limits, {
        label: line(limits, 40).describe(
          'What it measures: "Revenue this week".',
        ),
        value: line(limits, 24).describe(
          'The figure as it should read: "$528K".',
        ),
        note: line(limits, 60)
          .optional()
          .describe('One short line under it: "+11% vs last year".'),
      }),
      caps.metrics.max,
      caps.metrics.message,
    ),
  });
  const bars = closed(limits, {
    type: z.literal("bars"),
    label: line(limits, 60).optional(),
    items: many(
      limits,
      closed(limits, { label: line(limits, 24), value: amount(limits) }),
      caps.bars.max,
      caps.bars.message,
    ),
  });
  const list = closed(limits, {
    type: z.literal("list"),
    title: line(limits, 60).optional(),
    items: many(
      limits,
      closed(limits, {
        text: line(limits, 80).describe("Something worth a closer look."),
        note: line(limits, 80).optional(),
      }),
      caps.list.max,
      caps.list.message,
    ),
  });
  return z.discriminatedUnion("type", [
    heading,
    text,
    bullets,
    metrics,
    bars,
    list,
  ]);
}

const PAGE_CAPS: Caps = {
  metrics: { max: MAX_METRICS },
  bars: { max: MAX_BARS },
  list: { max: MAX_LIST },
  bullets: { max: MAX_BULLETS },
};

/** A page's blocks, with `limits` written as `pageBlockSchema` writes them. */
export function pageBlockSchemaWith(limits: Limits) {
  return blockSchemaWith(limits, PAGE_CAPS);
}
export const pageBlockSchema = pageBlockSchemaWith(ENFORCED);
export type PageBlock = z.infer<typeof pageBlockSchema>;

/** Said when a slide's block has more than one slide shows. */
const moreThanASlide = (most: number, what: string) =>
  `A slide shows at most ${most} ${what}. Put the rest on a new slide. ${FIX_SILENTLY}`;

const SLIDE_CAPS: Caps = {
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
};

/** A deck's slide, with `limits` written as `pageSlideSchema` writes them. Enforced, it is fit-checked too. */
export function pageSlideSchemaWith(limits: Limits) {
  const slide = closed(limits, {
    title: line(limits, MAX_TITLE),
    blocks: upTo(
      limits,
      blockSchemaWith(limits, SLIDE_CAPS),
      MAX_SLIDE_BLOCKS,
      moreThanASlide(MAX_SLIDE_BLOCKS, "blocks"),
    ).default([]),
  });
  return limits.enforce
    ? slide.superRefine((value, context) => {
        for (const issue of slideFitIssues(value)) context.addIssue(issue);
      })
    : slide;
}
export const pageSlideSchema = pageSlideSchemaWith(ENFORCED);
export type PageSlide = z.infer<typeof pageSlideSchema>;

/** What the table's `content` column holds: a page's blocks, or a deck's slides. */
export type PageContent = { blocks: PageBlock[] } | { slides: PageSlide[] };

type FitIssue = { code: "custom"; path: (string | number)[]; message: string };

const SPLITTABLE = new Set<PageBlock["type"]>([
  "bullets",
  "metrics",
  "bars",
  "list",
]);

/**
 * Everything about a slide that would not show in full on a phone, as issues the refusal names: a
 * figure too wide to draw whole, or a slide taller than the frame, with which blocks to move.
 *
 * A chart's labels are never refused: a chart whose labels or figures are too wide for columns is
 * drawn in rows instead (`barsLayout`), and measured that way. A figure is refused only when it is
 * wider than a whole-width tile, since figures of a block wider than half a tile already take the
 * whole width.
 */
function slideFitIssues(slide: SlideShape): FitIssue[] {
  const figures = slide.blocks.flatMap((block, at) =>
    block.type === "metrics"
      ? figuresTooWide(block).map((index) => ({
          code: "custom" as const,
          path: ["blocks", at, "items", index, "value"],
          message: `"${block.items[index]?.value}" is too wide to show on a phone. Write the figure shorter, such as "$1.2M" for "$1,234,567". ${FIX_SILENTLY}`,
        }))
      : [],
  );
  if (figures.length > 0) return figures;
  const height = slideHeight(slide);
  if (height <= SLIDE_FIT_HEIGHT) return [];
  const title = titleHeight(slide.title);
  let used = title;
  let advice = "Shorten the title or the text.";
  for (const [index, block] of slide.blocks.entries()) {
    const step = SLIDE_BLOCK_GAP + blockHeight(block);
    if (title + step > SLIDE_FIT_HEIGHT) {
      advice = SPLITTABLE.has(block.type)
        ? `Block ${index} (${block.type}) is too long for any one slide: keep some of its items here and put the rest in the same kind of block on a new slide.`
        : `Block ${index} (${block.type}) is too long for any one slide: carry it on in a new slide.`;
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
      message: `This slide is too full to read on a phone: it needs about ${Math.ceil(height)}px and a slide has ${SLIDE_FIT_HEIGHT}px. ${advice} Use more slides rather than leave anything out. ${FIX_SILENTLY}`,
    },
  ];
}
