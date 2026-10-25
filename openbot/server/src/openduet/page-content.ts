import {
  CURRENT_SLIDE_LAYOUT,
  figuresTooWide,
  SLIDE_FIT_HEIGHT,
  type SlideLayoutVersion,
  slideGeometry,
  slideHeight,
} from "@openbot/shared/slide-fit";
import { sanitizeThumbnail } from "@openbot/shared/thumbnail";
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

export { PAGE_KINDS, type PageKind } from "@openbot/shared/page-look";

export const MAX_TITLE = 80;
export const MAX_SUMMARY = 140;
export const MAX_BLOCKS = 40;
export const MAX_SLIDES = 20;
/**
 * The most slides a deck has once laid out for a phone, also accepted when revising a saved deck.
 * A new deck starts with at most `MAX_SLIDES`; what runs over continues, and a deck that runs past
 * this is refused. As many as a page has blocks, so a deck never holds more than a page could.
 */
export const MAX_LAID_OUT_SLIDES = MAX_BLOCKS;
export const MAX_SLIDE_BLOCKS = 3;
export const MAX_METRICS = 8;
export const MAX_BARS = 12;
export const MAX_LIST = 8;
export const MAX_BULLETS = 12;

/*
 * What one slide holds. A page scrolls, so its caps are about length. A slide doesn't: it is one
 * frame, and the viewer shows all of it, so these are what reads in full in that frame (a square of
 * content laid out at the narrowest phone slot, then only scaled up: see shared/slide-fit.ts).
 *
 * The model is not held to them. A slide it writes with more is laid out at save onto as many
 * continuation slides as it needs (`layOutDeck`, below): each count is the most one slide takes
 * before the rest continues, and the frame's height decides the rest. Refusing instead cost a run
 * one of its few tool steps per retry, and a run that ran out of steps saved the deck and never
 * said a word about it.
 */
/** Two rows of two half-width tiles. A third row of tiles with notes runs past the frame. */
export const SLIDE_MAX_METRICS = 4;
/** The count cap is a ceiling; the shared height budget splits wrapped bullets sooner. */
export const SLIDE_MAX_BULLETS = 6;
/** Each row retains a 44px target at the narrowest supported width. */
export const SLIDE_MAX_LIST = 4;
/** Ten compact bars fit under the slide title; longer labels can split sooner. */
export const SLIDE_MAX_BARS = 10;

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
    scale: amount(limits)
      .optional()
      .describe(
        "Preserve this on saved chart fragments: their common maximum, at least every item's value. Omit for a new chart.",
      ),
    highlight: (limits.enforce
      ? z
          .number()
          .int()
          .min(-1)
          .max(MAX_BARS - 1)
      : z.number().meta({ type: "integer", minimum: -1, maximum: MAX_BARS - 1 })
    )
      .optional()
      .describe(
        "Preserve this on saved chart fragments: the highlighted bar's zero-based index; an index beyond this fragment or -1 means no highlighted bar here. Omit for a new chart.",
      ),
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
  const timeline = closed(limits, {
    type: z.literal("timeline"),
    items: many(
      limits,
      closed(limits, {
        date: line(limits, 60),
        title: line(limits, 120),
        text: line(limits, 300).optional(),
      }),
      24,
    ),
  });
  const decision = closed(limits, {
    type: z.literal("decision"),
    question: line(limits, 160),
    options: many(
      limits,
      closed(limits, {
        title: line(limits, 80),
        pros: upTo(limits, line(limits, 160), 6),
        cons: upTo(limits, line(limits, 160), 6),
      }),
      3,
    ),
    pick: line(limits, 80).optional(),
  });
  const checklist = closed(limits, {
    type: z.literal("checklist"),
    items: many(
      limits,
      closed(limits, {
        id: line(limits, 64),
        text: line(limits, 240),
        checked: z.boolean().default(false),
      }),
      30,
    ),
  });
  const table = closed(limits, {
    type: z.literal("table"),
    columns: many(limits, line(limits, 60), 8),
    rows: many(limits, many(limits, line(limits, 240), 8), 30),
  });
  const comparison = closed(limits, {
    type: z.literal("comparison"),
    columns: many(
      limits,
      closed(limits, {
        title: line(limits, 80),
        items: many(limits, line(limits, 240), 8),
      }),
      3,
    ),
  });
  const image = closed(limits, {
    type: z.literal("image"),
    alt: line(limits, 160),
    svg: line(limits, 4096),
  });
  const schema = z.discriminatedUnion("type", [
    heading,
    text,
    bullets,
    metrics,
    bars,
    list,
    timeline,
    decision,
    checklist,
    table,
    comparison,
    image,
  ]);
  if (!limits.enforce) return schema;
  return schema.superRefine((block, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (
      block.type === "bars" &&
      block.scale !== undefined &&
      block.scale < Math.max(...block.items.map((item) => item.value), 0)
    )
      context.addIssue({
        code: "custom",
        path: ["scale"],
        message: "A chart's scale must be at least every item's value.",
      });
    if (
      block.type === "table" &&
      block.rows.some((row) => row.length !== block.columns.length)
    )
      issue("Every table row needs one cell per column.");
    if (
      block.type === "checklist" &&
      new Set(block.items.map((item) => item.id)).size !== block.items.length
    )
      issue("Checklist item ids must be unique in a block.");
    if (
      block.type === "decision" &&
      (block.options.length < 2 ||
        (block.pick &&
          !block.options.some((option) => option.title === block.pick)))
    )
      issue("A decision needs two or three options; pick must name an option.");
    if (block.type === "comparison" && block.columns.length < 2)
      issue("A comparison needs two or three columns.");
    if (block.type === "image" && !sanitizeThumbnail(block.svg))
      issue("The figure must be a safe static SVG under 4096 bytes.");
  });
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
 * a chart's bars, which share one scale across continuation slides, are still at most 12.
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
export type PageContent =
  | { blocks: PageBlock[] }
  | { slides: PageSlide[]; layoutVersion?: SlideLayoutVersion };

type FitIssue = { path: (string | number)[]; message: string };

/** The most of each kind of item one slide shows before the rest continues. */
const SLIDE_ITEMS: Partial<Record<PageBlock["type"], number>> = {
  metrics: SLIDE_MAX_METRICS,
  bullets: SLIDE_MAX_BULLETS,
  list: SLIDE_MAX_LIST,
  bars: SLIDE_MAX_BARS,
};

/** Whether a slide shows everything on it in its frame: few enough blocks and items, short enough. */
function fits(slide: PageSlide, version: SlideLayoutVersion): boolean {
  return (
    slide.blocks.length <= MAX_SLIDE_BLOCKS &&
    slide.blocks.every(
      (block) =>
        !("items" in block) ||
        block.items.length <=
          // The former 330px layout accepted twelve chart rows. Keep its count cap as well as
          // its height budget, or a full legacy deck would still expand beyond forty slides.
          (version === 1 && block.type === "bars"
            ? 12
            : (SLIDE_ITEMS[block.type] ?? Infinity)),
    ) &&
    slideHeight(slide, version) <= slideGeometry(version).fitHeight
  );
}

/** A continuation slide's title: the slide's own, marked as carrying on, when that fits the cap. */
const CONTINUED = " (continued)";
function continued(title: string): string {
  const next = `${ownTitle(title)}${CONTINUED}`;
  return next.length <= MAX_TITLE ? next : title;
}

/** A slide's own title, without the mark a continuation slide carries. */
export function ownTitle(title: string): string {
  while (title.endsWith(CONTINUED)) title = title.slice(0, -CONTINUED.length);
  return title;
}

/** Sentence starts are slice offsets, retaining punctuation and the whitespace between them. */
function sentenceBoundaries(text: string): number[] {
  return Array.from(
    new Intl.Segmenter("en", { granularity: "sentence" }).segment(text),
    (part) => part.index,
  ).slice(1);
}

/** A chart fragment's common scale and original highlight are also valid revision input. */
export type ScaledBars = Extract<PageBlock, { type: "bars" }>;

/**
 * A block cut in two: its first `count` units and the rest. The units are items for a block of
 * them (a list keeps its title on the first part) and sentences, or failing that words, for text.
 */
function cut(
  block: PageBlock,
  count: number,
  textBoundaries: readonly number[] = [],
): [PageBlock, PageBlock] | null {
  switch (block.type) {
    case "timeline":
      return [
        { ...block, items: block.items.slice(0, count) },
        { ...block, items: block.items.slice(count) },
      ];
    case "checklist":
      return [
        { ...block, items: block.items.slice(0, count) },
        { ...block, items: block.items.slice(count) },
      ];
    case "table":
      return [
        { ...block, rows: block.rows.slice(0, count) },
        { ...block, rows: block.rows.slice(count) },
      ];
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
      const boundary = textBoundaries[count - 1];
      if (boundary === undefined) return null;
      return [
        { ...block, text: block.text.slice(0, boundary).trim() },
        { ...block, text: block.text.slice(boundary).trim() },
      ];
    }
    // A chart too tall for a slide continues its bars on the next, every part drawn against the
    // whole chart's largest value (`scale`), so a bar on the second slide still compares with one on
    // the first.
    case "bars": {
      const scale =
        block.scale ?? Math.max(...block.items.map((item) => item.value), 0);
      const highlight = block.highlight ?? block.items.length - 1;
      return [
        {
          ...block,
          scale,
          highlight,
          items: block.items.slice(0, count),
        },
        {
          ...block,
          scale,
          // A previously highlighted bar stays on the earlier part. Keep the sentinel bounded
          // across repeated splits so every saved fragment remains valid revision input.
          highlight: Math.max(-1, highlight - count),
          items: block.items.slice(count),
        },
      ];
    }
    // A heading is one line: it is not cut.
    default:
      return null;
  }
}

function unitCount(block: PageBlock): number {
  if (block.type === "table") return block.rows.length;
  return "items" in block ? block.items.length : 1;
}

/**
 * The most of `block` that fits on an otherwise empty slide titled `title`, and the rest; or null
 * when even its first unit does not fit, or it cannot be cut.
 */
function firstPart(
  block: PageBlock,
  title: string,
  version: SlideLayoutVersion,
  before: PageBlock[] = [],
): [PageBlock, PageBlock] | null {
  // Charts switch from tall columns to compact rows as items are added, so their fit is
  // not monotonic. They have at most twelve items; search those bounded prefixes directly.
  if (block.type === "bars") {
    for (let count = unitCount(block) - 1; count >= 1; count--) {
      const parts = cut(block, count);
      if (parts && fits({ title, blocks: [...before, parts[0]] }, version))
        return parts;
    }
    return null;
  }
  const find = (
    textBoundaries?: readonly number[],
  ): [PageBlock, PageBlock] | null => {
    let low = 1;
    let high = textBoundaries?.length ?? unitCount(block) - 1;
    let best: [PageBlock, PageBlock] | null = null;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const parts = cut(block, count, textBoundaries);
      if (!parts) return null;
      if (fits({ title, blocks: [...before, parts[0]] }, version)) {
        best = parts;
        low = count + 1;
      } else high = count - 1;
    }
    return best;
  };
  if (block.type !== "text") return find();
  const boundaries = sentenceBoundaries(block.text);
  const best = find(boundaries);
  if (best) return best;

  const firstSentence = block.text.slice(0, boundaries[0] ?? block.text.length);
  // Keep a sentence whole on the next slide if it only lacks room after earlier blocks.
  if (
    before.length > 0 &&
    fits({ title, blocks: [{ ...block, text: firstSentence.trim() }] }, version)
  )
    return null;
  // A single oversized sentence must also continue when later sentences follow it. Search only
  // its word starts, so punctuation stays attached and an unbroken token is still irreducible.
  return find(
    Array.from(firstSentence.matchAll(/\S+\s*/g), (word) => word.index).slice(
      1,
    ),
  );
}

/**
 * A slide laid out on as many slides as it takes to show it all on a phone. Blocks go on in order
 * while they fit; one that does not starts a continuation slide, carrying the heading run that
 * would otherwise end a slide with it; one too long for any slide is cut by items, or by sentence,
 * and continues; a chart too tall for a slide by itself goes on its own slide and continues its bars on
 * the next, on one scale. Never refused for a chart's height: that ended runs with nothing saved and
 * nothing said. What still cannot be laid out (one unit taller than a slide) comes back as an issue.
 */
function layOutSlide(
  slide: PageSlide,
  at: number,
  remaining: number,
  version: SlideLayoutVersion,
): { slides: PageSlide[]; issues: FitIssue[] } {
  const slides: PageSlide[] = [];
  let current: PageSlide = { title: slide.title, blocks: [] };
  // A title must fit even when there are no blocks to enter the layout loop.
  if (!fits(current, version))
    return {
      slides: [],
      issues: [
        {
          path: ["slides", at, "title"],
          message: `This slide's title is taller than a phone shows by itself (about ${Math.ceil(slideHeight(current, version))}px against ${slideGeometry(version).fitHeight}px). Shorten the title.`,
        },
      ],
    };
  const queue = [...slide.blocks];
  let block = queue.shift();
  while (block) {
    if (slides.length >= remaining)
      return { slides: [], issues: [deckLimitIssue()] };
    const next = { ...current, blocks: [...current.blocks, block] };
    if (fits(next, version)) {
      current = next;
      block = queue.shift();
      continue;
    }
    const fitted = firstPart(block, current.title, version, current.blocks);
    if (fitted) {
      slides.push({ ...current, blocks: [...current.blocks, fitted[0]] });
      current = { title: continued(slide.title), blocks: [] };
      block = fitted[1];
      continue;
    }
    if (current.blocks.length > 0) {
      // Keep every adjacent heading with what it heads, including when another heading is
      // the block that overflows. A heading-only slide cannot be split without an orphan.
      let carryFrom = current.blocks.length;
      while (current.blocks[carryFrom - 1]?.type === "heading") carryFrom--;
      if (carryFrom === 0)
        return {
          slides: [],
          issues: [
            {
              path: ["slides", at],
              message:
                "This heading and the first item below it do not fit together. Shorten them.",
            },
          ],
        };
      slides.push({
        ...current,
        blocks: current.blocks.slice(0, carryFrom),
      });
      const carried = current.blocks.slice(carryFrom);
      current = { title: continued(slide.title), blocks: [] };
      if (carried.length > 0) {
        queue.unshift(...carried, block);
        block = queue.shift();
      }
      continue;
    }
    const parts = firstPart(block, current.title, version);
    if (!parts)
      return {
        slides: [],
        issues: [
          {
            path: ["slides", at],
            message: `This slide's ${block.type} is taller than a phone shows by itself (about ${Math.ceil(slideHeight({ title: current.title, blocks: [block] }, version))}px against ${slideGeometry(version).fitHeight}px). Shorten it.`,
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
 * figure too wide to draw whole even in a whole-width tile, one unit taller than a slide by itself,
 * and a deck that runs past `MAX_LAID_OUT_SLIDES` once laid out.
 */
export function layOutDeck(
  slides: readonly PageSlide[],
  version: SlideLayoutVersion = CURRENT_SLIDE_LAYOUT,
): {
  slides: PageSlide[];
  issues: FitIssue[];
} {
  const issues: FitIssue[] = slides.flatMap((slide, at) =>
    slide.blocks.flatMap((block, index) =>
      block.type === "metrics"
        ? figuresTooWide(block, version).map((item) => ({
            path: ["slides", at, "blocks", index, "items", item, "value"],
            message: `"${block.items[item]?.value}" is too wide to show on a phone. Write the figure shorter, such as "$1.2M" for "$1,234,567".`,
          }))
        : [],
    ),
  );
  if (issues.length > 0) return { slides: [], issues };
  const all: PageSlide[] = [];
  for (const [at, slide] of slides.entries()) {
    const laid = layOutSlide(
      slide,
      at,
      MAX_LAID_OUT_SLIDES - all.length,
      version,
    );
    if (laid.issues.length) return { slides: [], issues: laid.issues };
    all.push(...laid.slides);
    if (all.length > MAX_LAID_OUT_SLIDES)
      return { slides: [], issues: [deckLimitIssue()] };
  }
  return { slides: all, issues: [] };
}

function deckLimitIssue(): FitIssue {
  return {
    path: ["slides"],
    message: `Laid out for a phone, this deck has at most ${MAX_LAID_OUT_SLIDES} slides. Keep fewer items, or shorter notes.`,
  };
}
