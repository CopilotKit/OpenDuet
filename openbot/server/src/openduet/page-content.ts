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

const line = (max: number) => z.string().trim().min(1).max(max);

const heading = z
  .object({ type: z.literal("heading"), text: line(120) })
  .strict();
const text = z.object({ type: z.literal("text"), text: line(2_000) }).strict();
const bullets = z
  .object({
    type: z.literal("bullets"),
    items: z.array(line(300)).min(1).max(MAX_BULLETS),
  })
  .strict();
const metrics = z
  .object({
    type: z.literal("metrics"),
    items: z
      .array(
        z
          .object({
            label: line(40).describe('What it measures: "Revenue this week".'),
            value: line(24).describe('The figure as it should read: "$528K".'),
            note: line(60)
              .optional()
              .describe('One short line under it: "+11% vs last year".'),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_METRICS),
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
      .max(MAX_BARS),
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
      .max(MAX_LIST),
  })
  .strict();

export const pageBlockSchema = z.discriminatedUnion("type", [
  heading,
  text,
  bullets,
  metrics,
  bars,
  list,
]);
export type PageBlock = z.infer<typeof pageBlockSchema>;

export const pageSlideSchema = z
  .object({
    title: line(MAX_TITLE),
    blocks: z.array(pageBlockSchema).max(MAX_SLIDE_BLOCKS).default([]),
  })
  .strict();
export type PageSlide = z.infer<typeof pageSlideSchema>;

/** What the table's `content` column holds: a page's blocks, or a deck's slides. */
export type PageContent = { blocks: PageBlock[] } | { slides: PageSlide[] };
