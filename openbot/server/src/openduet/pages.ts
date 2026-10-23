import { randomUUID } from "node:crypto";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { and, desc, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AuditInitiator } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { openduetPages } from "../db/schema/openduet";
import { REFUSAL_MARKER } from "../plugins/tools";
import {
  MAX_BLOCKS,
  MAX_SLIDE_BLOCKS,
  MAX_SLIDES,
  MAX_SUMMARY,
  MAX_TITLE,
  PAGE_KINDS,
  type PageBlock,
  type PageContent,
  type PageKind,
  type PageSlide,
  pageBlockSchema,
  pageSlideSchema,
  SLIDE_MAX_BARS,
  SLIDE_MAX_BULLETS,
  SLIDE_MAX_LIST,
  SLIDE_MAX_METRICS,
} from "./page-content";

/*
 * Things the Bot makes: a page to read (prep notes, a plan, a dashboard) or a deck to present, saved
 * for the person and shown in Chat as a card that opens it. The Pages tab lists everything it made.
 *
 * A tool, rather than a long answer in the thread, because what the person asked for is a thing to
 * keep and come back to. Chat gets a sentence about it and a card; the thing itself lives here.
 *
 * Saving one is a write, but only to the person's own list, and it reaches nobody else: nothing is
 * sent, shared or published. So, like the brief and the reply chips, it never meets the approval
 * gate. A background run is not offered it: `restrictToolsForRun` keeps that run to the
 * catalogue's reads, and a page nobody asked for would be clutter.
 */

export const PAGE_TOOL = "make_page";
/** How many of a page's blocks a card's preview needs. More would only be cut off. */
export const PREVIEW_BLOCKS = 4;

/** A page as a list and a card see it: no content beyond what the preview draws. */
export type PageSummary = {
  id: string;
  botId: string;
  kind: PageKind;
  title: string;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  /** How many slides a deck has. Zero for a page. */
  slideCount: number;
  /** What a card draws: a page's first blocks, or one slide of a deck (see `previewOf`). */
  preview: { title?: string; blocks: PageBlock[] };
};

/** A page whole, for the viewer. */
export type PageRecord = PageSummary & { content: PageContent };

export class PageNotFoundError extends Error {
  constructor() {
    super("Couldn't find that page.");
    this.name = "PageNotFoundError";
  }
}

const inputSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "To revise a page you already made, its id from that call's result. Leave it out to make a new one.",
      ),
    kind: z
      .enum(PAGE_KINDS)
      .describe(
        '"page" for something to read or keep, "slides" for a deck to present.',
      ),
    title: z
      .string()
      .trim()
      .min(1)
      .max(MAX_TITLE)
      .describe(`A short name, at most ${MAX_TITLE} characters.`),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(MAX_SUMMARY)
      .optional()
      .describe(
        `One line on what it is, at most ${MAX_SUMMARY} characters. Shown under the title in the Pages list.`,
      ),
    blocks: z
      .array(pageBlockSchema)
      .min(1)
      .max(MAX_BLOCKS)
      .optional()
      .describe(`A page's content, in order. Required for "page".`),
    slides: z
      .array(pageSlideSchema)
      .min(1)
      .max(MAX_SLIDES)
      .optional()
      .describe(
        `A deck's slides, in order, each a title and at most ${MAX_SLIDE_BLOCKS} blocks that read in full on a phone. Required for "slides".`,
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "page" && !value.blocks)
      context.addIssue({
        code: "custom",
        path: ["blocks"],
        message: 'A "page" needs blocks.',
      });
    if (value.kind === "page" && value.slides)
      context.addIssue({
        code: "custom",
        path: ["slides"],
        message: 'A "page" takes blocks, not slides.',
      });
    if (value.kind === "slides" && !value.slides)
      context.addIssue({
        code: "custom",
        path: ["slides"],
        message: 'A "slides" deck needs slides.',
      });
    if (value.kind === "slides" && value.blocks)
      context.addIssue({
        code: "custom",
        path: ["blocks"],
        message: 'A "slides" deck takes slides, not blocks.',
      });
  });
export type PageInput = z.infer<typeof inputSchema>;

/**
 * Why the input was refused, in a line the model can act on: where, and what was wrong there.
 * The first issue is enough. A model fixes one thing at a time, and a list of ten reads as noise.
 * A slide too full for a phone says how to split it (see `slideHeight` in page-content.ts).
 *
 * The retry is between the model and the tool. The person sees one card when it lands, never a
 * line about a cap or a split.
 */
function refusalFor(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return `${REFUSAL_MARKER} ${PAGE_TOOL} could not save this. ${where}${issue?.message ?? "Invalid arguments."} Fix it and call ${PAGE_TOOL} again. Don't mention this to the person.`;
}

export function parsePageInput(
  input: unknown,
): { ok: true; value: PageInput } | { ok: false; refusal: string } {
  const parsed = inputSchema.safeParse(input ?? {});
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, refusal: refusalFor(parsed.error) };
}

type Row = typeof openduetPages.$inferSelect;

/**
 * What a card previews. A page shows its first blocks. A deck shows its first slide with a chart,
 * since the chart is what a deck's thumbnail is recognised by, and its first slide when it has none.
 * Worked out from the stored content on every read, so a deck saved before this rule previews the
 * same way.
 */
export function previewOf(content: PageContent): PageSummary["preview"] {
  if ("blocks" in content)
    return { blocks: content.blocks.slice(0, PREVIEW_BLOCKS) };
  const shown: PageSlide | undefined =
    content.slides.find((slide) =>
      slide.blocks.some((block) => block.type === "bars"),
    ) ?? content.slides[0];
  return shown ? { title: shown.title, blocks: shown.blocks } : { blocks: [] };
}

function summaryOf(row: Row): PageSummary {
  const slides = "slides" in row.content ? row.content.slides : [];
  return {
    id: row.id,
    botId: row.botId,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    slideCount: slides.length,
    preview: previewOf(row.content),
  };
}

function recordOf(row: Row): PageRecord {
  return { ...summaryOf(row), content: row.content };
}

export type PageStore = ReturnType<typeof createPageStore>;

/** Every read and write is the owner's: another person's page is the same as no page. */
export function createPageStore(
  database: Database,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const owned = (owner: string, id: string) =>
    and(eq(openduetPages.ownerUserId, owner), eq(openduetPages.id, id));
  return {
    /** Makes a page, or revises the owner's own one in place when `input.id` names it. */
    async save(
      owner: string,
      botId: string,
      input: PageInput,
      channelId: string | null = null,
    ): Promise<PageRecord> {
      const content: PageContent =
        input.kind === "slides"
          ? { slides: input.slides ?? [] }
          : { blocks: input.blocks ?? [] };
      const fields = {
        kind: input.kind,
        title: input.title,
        summary: input.summary ?? null,
        content,
      };
      if (input.id) {
        const [row] = await database
          .update(openduetPages)
          .set({ ...fields, updatedAt: now() })
          .where(owned(owner, input.id))
          .returning();
        if (!row) throw new PageNotFoundError();
        return recordOf(row);
      }
      const at = now();
      const [row] = await database
        .insert(openduetPages)
        .values({
          id: randomUUID(),
          ownerUserId: owner,
          botId,
          channelId,
          ...fields,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (!row) throw new Error("The page was not saved.");
      return recordOf(row);
    },
    /** The owner's pages, most recently changed first. */
    async list(owner: string, limit = 100): Promise<PageSummary[]> {
      const rows = await database
        .select()
        .from(openduetPages)
        .where(eq(openduetPages.ownerUserId, owner))
        .orderBy(desc(openduetPages.updatedAt), desc(openduetPages.id))
        .limit(limit);
      return rows.map(summaryOf);
    },
    async get(owner: string, id: string): Promise<PageRecord> {
      const [row] = await database
        .select()
        .from(openduetPages)
        .where(owned(owner, id))
        .limit(1);
      if (!row) throw new PageNotFoundError();
      return recordOf(row);
    },
  };
}

/** `make_page` as a tool the Bot holds. Held by every Bot, like the brief and the reply chips. */
export function pageTools(options: {
  save: (input: PageInput) => Promise<PageRecord>;
  initiator: AuditInitiator;
}): GrantedTool[] {
  return [
    {
      name: PAGE_TOOL,
      ref: `openduet/${PAGE_TOOL}`,
      description: [
        "Make something the person can read, present or keep, and save it for them: prep notes, a plan, a summary, a dashboard, or a deck.",
        'Use kind "page" with blocks for anything to read, and kind "slides" with slides for a deck to present.',
        "A dashboard is a page that starts with a text block holding one short headline sentence (under 90 characters), then a metrics block of up to 8 tiles, then anything else, such as a list block of what to look at next.",
        "Blocks: heading, text, bullets, metrics (label, value, optional note), bars (a bar chart of labelled numbers) and list (rows worth a closer look).",
        `A slide is read on a phone, in full: a title and at most ${MAX_SLIDE_BLOCKS} blocks, with at most ${SLIDE_MAX_METRICS} metrics, ${SLIDE_MAX_BULLETS} bullets, ${SLIDE_MAX_LIST} list rows or ${SLIDE_MAX_BARS} bars, and less when blocks share a slide. Keep figures and bar labels short. When there is more, use more slides.`,
        "The app shows it as a card under your message, and the person opens it from there. So never paste its content into the chat: write one or two sentences about it, such as what it covers and how long it takes to read.",
        "To change one you already made, call it again with that page's id and the whole new content.",
      ].join(" "),
      parameters: inputSchema,
      initiator: options.initiator,
      async execute(args) {
        const parsed = parsePageInput(args);
        if (!parsed.ok) return parsed.refusal;
        try {
          return JSON.stringify(
            summaryOfRecord(await options.save(parsed.value)),
          );
        } catch (error) {
          if (error instanceof PageNotFoundError)
            return `${REFUSAL_MARKER} There is no page of yours with the id "${parsed.value.id}". Leave id out to make a new one.`;
          throw error;
        }
      },
    },
  ];
}

/** The tool's result: what the card draws, without the rest of the content. */
function summaryOfRecord(record: PageRecord): PageSummary {
  const { content: _content, ...summary } = record;
  return summary;
}

/** `/api/openduet/pages`: the person's own pages, as the Pages tab and the viewer read them. */
export function createPageRoutes(
  store: PageStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof PageNotFoundError)
      return context.json({ error: error.message }, 404);
    console.error(
      JSON.stringify({
        type: "openduet-pages-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "Couldn't load your pages. Try again." }, 503);
  });
  routes.get("/", async (context) =>
    context.json({ pages: await store.list(context.var.actor.id) }),
  );
  routes.get("/:id", async (context) =>
    context.json({
      page: await store.get(context.var.actor.id, context.req.param("id")),
    }),
  );
  return routes;
}
