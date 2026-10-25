import { PAGE_KINDS, PAGE_THEMES } from "@openbot/shared/page-look";
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
export const blockSchema = z.discriminatedUnion("type", [
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
    highlight: z.number().optional(),
  }),
  z.object({
    type: z.literal("list"),
    title: z.string().optional(),
    items: z.array(z.object({ text: z.string(), note: z.string().optional() })),
  }),
  z.object({
    type: z.literal("timeline"),
    items: z.array(
      z.object({
        date: z.string(),
        title: z.string(),
        text: z.string().optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal("checklist"),
    items: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        checked: z.boolean().default(false),
      }),
    ),
  }),
  z.object({
    type: z.literal("table"),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
  }),
  z.object({
    type: z.literal("decision"),
    question: z.string(),
    options: z.array(
      z.object({
        title: z.string(),
        pros: z.array(z.string()),
        cons: z.array(z.string()),
      }),
    ),
    pick: z.string().optional(),
  }),
  z.object({
    type: z.literal("comparison"),
    columns: z.array(
      z.object({ title: z.string(), items: z.array(z.string()) }),
    ),
  }),
  z.object({ type: z.literal("image"), svg: z.string(), alt: z.string() }),
]);
export type PageBlock = z.infer<typeof blockSchema> & {
  /** Position in saved content, retained when parsing leaves unsupported blocks out. */
  persistedIndex?: number;
};

/** Blocks the app knows how to draw, in order. One it does not know is left out, not guessed at. */
const blocksSchema = z
  .array(z.unknown())
  .default([])
  .transform((blocks): PageBlock[] =>
    blocks.flatMap((block, persistedIndex) => {
      const parsed = blockSchema.safeParse(block);
      return parsed.success ? [{ ...parsed.data, persistedIndex }] : [];
    }),
  );

const slideSchema = z.object({ title: z.string(), blocks: blocksSchema });
export type PageSlide = z.infer<typeof slideSchema>;

export const pageSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(PAGE_KINDS),
  botId: z.string().optional(),
  thumbnail: z.string().nullable().optional(),
  theme: z.enum(PAGE_THEMES).optional(),
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

export const pageRecordSchema = pageSummarySchema.extend({
  // Older responses can still be read, but a missing token must fail closed on checklist writes.
  checklistRevision: z.string().default(""),
  content: z.union([
    z.object({
      slides: z.array(slideSchema),
      // Unversioned saved decks retain the original geometry; new saves explicitly carry v2.
      layoutVersion: z.union([z.literal(1), z.literal(2)]).optional(),
    }),
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
