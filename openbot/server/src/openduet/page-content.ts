import {
  figuresTooWide,
  SLIDE_FIT_HEIGHT,
  slideHeight,
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
 * 298px of content, laid out at 330px wide and scaled to the phone: see shared/slide-fit.ts).
 *
 * The model is not held to them. A slide it writes with more is laid out at save onto as many
 * continuation slides as it needs (`layOutDeck`, below): each count is the most one slide takes
 * before the rest continues, and the frame's height decides the rest. Refusing instead cost a run
 * one of its few tool steps per retry, and a run that ran out of steps saved the deck and never
 * said a word about it.
 */
/** Two rows of two half-width tiles. A third row of tiles with notes runs past the frame. */
export const SLIDE_MAX_METRICS = 4;
/** Six bullets of up to two lines each, under the slide's title, fill the frame (294 of 298px). */
export const SLIDE_MAX_BULLETS = 6;
/** Four rows at 52px (a 44px tap target at the least scale) under a list title and the slide's title (269px). */
export const SLIDE_MAX_LIST = 4;
/** Twelve bars lying in rows, 16px each and 4px apart, under a caption and the slide's title (292px). */
export const SLIDE_MAX_BARS = 12;

export { SLIDE_FIT_HEIGHT, slideHeight };

/**
 * The line every slide refusal ends on, and the make_page tool's own refusal too.
 *
 * A split is between the model and the tool. Told only what to fix, a model fixed it and then told
 * the person "A slide holds at most 5 rows", or made a page when they had asked for a deck. The
 * person should see one card when it lands, the kind they asked for.
 */
export const FIX_SILENTLY =
  'Fix it silently: never mention a limit, a split, a cut, what fits or a retry to the person, write nothing to them until the retry is saved, and keep making the same kind with this tool (a deck stays a deck). If the deck ends up longer than they asked, say only how many slides it has, such as "It\'s 3 slides.", and never why.';

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
> & {
  /** How long a block's shorter strings may be: a page's lines are short, a slide's wrap. */
  text: {
    metricLabel: number;
    metricNote: number;
    barLabel: number;
    barCaption: number;
    listTitle: number;
    listText: number;
    listNote: number;
  };
};

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
        label: line(limits, caps.text.metricLabel).describe(
          'What it measures: "Revenue this week".',
        ),
        value: line(limits, 24).describe(
          'The figure as it should read: "$528K".',
        ),
        note: line(limits, caps.text.metricNote)
          .optional()
          .describe('One short line under it: "+11% vs last year".'),
      }),
      caps.metrics.max,
      caps.metrics.message,
    ),
  });
  const bars = closed(limits, {
    type: z.literal("bars"),
    label: line(limits, caps.text.barCaption).optional(),
    items: many(
      limits,
      closed(limits, {
        label: line(limits, caps.text.barLabel),
        value: amount(limits),
      }),
      caps.bars.max,
      caps.bars.message,
    ),
  });
  const list = closed(limits, {
    type: z.literal("list"),
    title: line(limits, caps.text.listTitle).optional(),
    items: many(
      limits,
      closed(limits, {
        text: line(limits, caps.text.listText).describe(
          "Something worth a closer look.",
        ),
        note: line(limits, caps.text.listNote).optional(),
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
  text: {
    metricLabel: 40,
    metricNote: 60,
    barLabel: 24,
    barCaption: 60,
    listTitle: 60,
    listText: 80,
    listNote: 80,
  },
};

/** A page's blocks, with `limits` written as `pageBlockSchema` writes them. */
export function pageBlockSchemaWith(limits: Limits) {
  return blockSchemaWith(limits, PAGE_CAPS);
}
export const pageBlockSchema = pageBlockSchemaWith(ENFORCED);
export type PageBlock = z.infer<typeof pageBlockSchema>;

/**
 * What a slide takes from the model: more items and longer lines than a page's. A slide's lines
 * wrap and its items continue onto new slides at save, so a longer note or a fourteenth row is
 * laid out, not refused. Only the shape is refused: a figure is still a figure (24 characters), and
 * a chart's bars, which share one scale and stay on one slide, are still at most 12.
 */
const SLIDE_INPUT_CAPS: Caps = {
  metrics: { max: 16 },
  bars: { max: MAX_BARS },
  list: { max: 24 },
  bullets: { max: 24 },
  text: {
    metricLabel: 60,
    metricNote: 120,
    barLabel: 48,
    barCaption: 120,
    listTitle: 120,
    listText: 120,
    listNote: 160,
  },
};
/** The most blocks a slide takes from the model; past three, they continue onto new slides. */
export const MAX_SLIDE_INPUT_BLOCKS = 8;

/** A deck's slide, with `limits` written as `pageSlideSchema` writes them. */
export function pageSlideSchemaWith(limits: Limits) {
  return closed(limits, {
    title: line(limits, MAX_TITLE),
    blocks: upTo(
      limits,
      blockSchemaWith(limits, SLIDE_INPUT_CAPS),
      MAX_SLIDE_INPUT_BLOCKS,
    ).default([]),
  });
}
export const pageSlideSchema = pageSlideSchemaWith(ENFORCED);
export type PageSlide = z.infer<typeof pageSlideSchema>;

/** What the table's `content` column holds: a page's blocks, or a deck's slides. */
export type PageContent = { blocks: PageBlock[] } | { slides: PageSlide[] };

type FitIssue = { path: (string | number)[]; message: string };

/** The most of each kind of item one slide shows before the rest continues. */
const SLIDE_ITEMS: Partial<Record<PageBlock["type"], number>> = {
  metrics: SLIDE_MAX_METRICS,
  bullets: SLIDE_MAX_BULLETS,
  list: SLIDE_MAX_LIST,
  bars: SLIDE_MAX_BARS,
};

/** Whether a slide shows everything on it in its frame: few enough blocks and items, short enough. */
function fits(slide: PageSlide): boolean {
  return (
    slide.blocks.length <= MAX_SLIDE_BLOCKS &&
    slide.blocks.every(
      (block) =>
        !("items" in block) ||
        block.items.length <= (SLIDE_ITEMS[block.type] ?? Infinity),
    ) &&
    slideHeight(slide) <= SLIDE_FIT_HEIGHT
  );
}

/** A continuation slide's title: the slide's own, marked as carrying on, when that fits the cap. */
const CONTINUED = " (continued)";
function continued(title: string): string {
  const next = `${title}${CONTINUED}`;
  return next.length <= MAX_TITLE ? next : title;
}

/** A slide's own title, without the mark a continuation slide carries. */
export function ownTitle(title: string): string {
  return title.endsWith(CONTINUED) ? title.slice(0, -CONTINUED.length) : title;
}

/** A text block's sentences, each with the space after it, so they join back as written. */
function sentencesOf(text: string): string[] {
  return text.match(/[^.!?\n]+(?:[.!?]+["')\]]*)?\s*|\n+/g) ?? [text];
}

/**
 * A block cut in two: its first `count` units and the rest. The units are items for a block of
 * them (a list keeps its title on the first part) and sentences, or failing that words, for text.
 */
function cut(block: PageBlock, count: number): [PageBlock, PageBlock] | null {
  switch (block.type) {
    case "bullets":
      return [
        { ...block, items: block.items.slice(0, count) },
        { ...block, items: block.items.slice(count) },
      ];
    case "metrics":
      return [
        { ...block, items: block.items.slice(0, count) },
        { ...block, items: block.items.slice(count) },
      ];
    case "list": {
      const { title: _title, ...rest } = block;
      return [
        { ...block, items: block.items.slice(0, count) },
        { ...rest, items: block.items.slice(count) },
      ];
    }
    case "text": {
      const units = unitsOf(block.text);
      return [
        { ...block, text: units.slice(0, count).join("").trim() },
        { ...block, text: units.slice(count).join("").trim() },
      ];
    }
    // A chart's bars share one scale, and a heading is one line: neither is cut.
    default:
      return null;
  }
}

/** How a text block is cut: by sentence, or by word when one sentence is longer than a slide. */
function unitsOf(text: string): string[] {
  const sentences = sentencesOf(text);
  return sentences.length > 1 ? sentences : (text.match(/\S+\s*/g) ?? [text]);
}

function unitCount(block: PageBlock): number {
  if (block.type === "text") return unitsOf(block.text).length;
  return "items" in block ? block.items.length : 1;
}

/**
 * The most of `block` that fits on an otherwise empty slide titled `title`, and the rest; or null
 * when even its first unit does not fit, or it cannot be cut.
 */
function firstPart(
  block: PageBlock,
  title: string,
): [PageBlock, PageBlock] | null {
  for (let count = unitCount(block) - 1; count >= 1; count--) {
    const parts = cut(block, count);
    if (!parts) return null;
    if (fits({ title, blocks: [parts[0]] })) return parts;
  }
  return null;
}

/**
 * A slide laid out on as many slides as it takes to show it all on a phone. Blocks go on in order
 * while they fit; one that does not starts a continuation slide, carrying a heading that would
 * otherwise end a slide with it; one too long for any slide is cut by items, or by sentence, and
 * continues. What cannot be laid out (a chart taller than a slide by itself) comes back as an issue.
 */
function layOutSlide(
  slide: PageSlide,
  at: number,
): { slides: PageSlide[]; issues: FitIssue[] } {
  const slides: PageSlide[] = [];
  let current: PageSlide = { title: slide.title, blocks: [] };
  const queue = [...slide.blocks];
  let block = queue.shift();
  while (block) {
    const next = { ...current, blocks: [...current.blocks, block] };
    if (fits(next)) {
      current = next;
      block = queue.shift();
      continue;
    }
    if (current.blocks.length > 0) {
      // A heading never ends a slide with what it heads on the next one: it goes over with it.
      const last = current.blocks.at(-1);
      const carried =
        last?.type === "heading" && current.blocks.length > 1 ? last : null;
      slides.push({
        ...current,
        blocks: carried ? current.blocks.slice(0, -1) : current.blocks,
      });
      current = { title: continued(slide.title), blocks: [] };
      if (carried) {
        queue.unshift(block);
        block = carried;
      }
      continue;
    }
    const parts = firstPart(block, current.title);
    if (!parts)
      return {
        slides: [],
        issues: [
          {
            path: ["slides", at],
            message: `This slide's ${block.type} is taller than a phone shows by itself (about ${Math.ceil(slideHeight({ title: current.title, blocks: [block] }))}px against ${SLIDE_FIT_HEIGHT}px). ${block.type === "bars" ? "Use fewer bars or shorter labels" : "Shorten it"}.`,
          },
        ],
      };
    slides.push({ ...current, blocks: [parts[0]] });
    current = { title: continued(slide.title), blocks: [] };
    block = parts[1];
  }
  if (current.blocks.length > 0 || slides.length === 0) slides.push(current);
  return { slides, issues: [] };
}

/**
 * A deck as the viewer shows it: every slide laid out on as many slides as it needs (`layOutSlide`),
 * so nothing a slide holds is cut off and nothing is refused for length. What is still refused is a
 * figure too wide to draw whole even in a whole-width tile, a chart taller than a slide by itself,
 * and a deck that runs past `MAX_SLIDES` once laid out.
 */
export function layOutDeck(slides: readonly PageSlide[]): {
  slides: PageSlide[];
  issues: FitIssue[];
} {
  const issues: FitIssue[] = slides.flatMap((slide, at) =>
    slide.blocks.flatMap((block, index) =>
      block.type === "metrics"
        ? figuresTooWide(block).map((item) => ({
            path: ["slides", at, "blocks", index, "items", item, "value"],
            message: `"${block.items[item]?.value}" is too wide to show on a phone. Write the figure shorter, such as "$1.2M" for "$1,234,567".`,
          }))
        : [],
    ),
  );
  if (issues.length > 0) return { slides: [], issues };
  const laid = slides.map((slide, at) => layOutSlide(slide, at));
  const failed = laid.flatMap((result) => result.issues);
  if (failed.length > 0) return { slides: [], issues: failed };
  const all = laid.flatMap((result) => result.slides);
  if (all.length > MAX_SLIDES)
    return {
      slides: [],
      issues: [
        {
          path: ["slides"],
          message: `Laid out for a phone, this deck runs to ${all.length} slides, and a deck has at most ${MAX_SLIDES}. Keep fewer items, or shorter notes.`,
        },
      ],
    };
  return { slides: all, issues: [] };
}
