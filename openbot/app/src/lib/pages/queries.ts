import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { client } from "@/lib/client";

/*
 * What OpenDuet made for the person: pages to read and decks to present, saved by the server's
 * `make_page` tool (server/src/openduet/pages.ts). The server checked every block before saving it;
 * the schemas here only make sure the app draws the shapes it knows, and leaves out anything else.
 */

const metric = z.object({
  label: z.string(),
  value: z.string(),
  note: z.string().optional(),
});
const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), text: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("bullets"), items: z.array(z.string()) }),
  z.object({ type: z.literal("metrics"), items: z.array(metric) }),
  z.object({
    type: z.literal("bars"),
    label: z.string().optional(),
    items: z.array(z.object({ label: z.string(), value: z.number() })),
    // A chart continued across slides: the whole chart's largest value, so its parts compare.
    scale: z.number().optional(),
  }),
  z.object({
    type: z.literal("list"),
    title: z.string().optional(),
    items: z.array(z.object({ text: z.string(), note: z.string().optional() })),
  }),
]);
export type PageBlock = z.infer<typeof blockSchema>;

/** Blocks the app knows how to draw, in order. One it does not know is left out, not guessed at. */
const blocksSchema = z
  .array(z.unknown())
  .default([])
  .transform((blocks) =>
    blocks.flatMap((block) => {
      const parsed = blockSchema.safeParse(block);
      return parsed.success ? [parsed.data] : [];
    }),
  );

const slideSchema = z.object({ title: z.string(), blocks: blocksSchema });
export type PageSlide = z.infer<typeof slideSchema>;

export const pageSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(["page", "slides"]),
  title: z.string(),
  summary: z.string().nullable().default(null),
  updatedAt: z.string(),
  slideCount: z.number().default(0),
  preview: z
    .object({ title: z.string().optional(), blocks: blocksSchema })
    .default({ blocks: [] }),
});
/** A page as a card draws it: the title, when it changed, and the first blocks or slide. */
export type PageSummary = z.infer<typeof pageSummarySchema>;

const pageRecordSchema = pageSummarySchema.extend({
  content: z.union([
    z.object({ slides: z.array(slideSchema) }),
    z.object({ blocks: blocksSchema }),
  ]),
});
/** A page whole, as the viewer draws it. */
export type PageRecord = z.infer<typeof pageRecordSchema>;

/** A deck's slides, or none for a page. */
export function slidesOf(page: PageRecord): PageSlide[] {
  return "slides" in page.content ? page.content.slides : [];
}

/** A page's blocks, or none for a deck. */
export function blocksOf(page: PageRecord): PageBlock[] {
  return "blocks" in page.content ? page.content.blocks : [];
}

export const pageKeys = {
  all: ["openduet-pages"] as const,
  list: ["openduet-pages", "list"] as const,
  detail: (id: string) => ["openduet-pages", "detail", id] as const,
};

export const pageListQueryOptions = () =>
  queryOptions({
    queryKey: pageKeys.list,
    queryFn: async (): Promise<PageSummary[]> =>
      z.array(pageSummarySchema).parse(
        await client<unknown[]>("/api/openduet/pages", "pages", {
          fallback: "Couldn't load your pages",
        }),
      ),
  });

export const pageQueryOptions = (id: string) =>
  queryOptions({
    queryKey: pageKeys.detail(id),
    queryFn: async (): Promise<PageRecord> =>
      pageRecordSchema.parse(
        await client<unknown>(
          `/api/openduet/pages/${encodeURIComponent(id)}`,
          "page",
          { fallback: "Couldn't open this page" },
        ),
      ),
  });
