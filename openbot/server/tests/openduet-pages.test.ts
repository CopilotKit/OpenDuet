import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { FIX_SILENTLY } from "../src/openduet/page-content";
import {
  PAGE_TOOL,
  type PageInput,
  PageNotFoundError,
  type PageRecord,
  pageTools,
  parsePageInput,
  previewOf,
} from "../src/openduet/pages";

const INITIATOR = { kind: "person" } as const;

/** A store that keeps what it was handed, so a test can read back what the tool saved. */
function tool(
  save: (input: PageInput) => Promise<PageRecord> = async (input) => ({
    checklistRevision: "a".repeat(64),
    id: input.id ?? "page-1",
    botId: "openduet",
    kind: input.kind,
    title: input.title,
    summary: input.summary ?? null,
    createdAt: "2026-10-22T12:52:00.000Z",
    updatedAt: "2026-10-22T12:52:00.000Z",
    slideCount: input.slides?.length ?? 0,
    preview:
      input.kind === "slides"
        ? {
            title: input.slides?.[0]?.title ?? "",
            blocks: input.slides?.[0]?.blocks ?? [],
          }
        : { blocks: (input.blocks ?? []).slice(0, 4) },
    content:
      input.kind === "slides"
        ? { slides: input.slides ?? [] }
        : { blocks: input.blocks ?? [] },
  }),
) {
  const [only] = pageTools({ save, initiator: INITIATOR });
  if (!only) throw new Error("no tool");
  return only;
}

const prep = {
  kind: "page",
  title: "Hearth & Co studio visit",
  summary: "What to ask, what to bring, and the numbers to know.",
  blocks: [
    { type: "heading", text: "Before you go" },
    { type: "text", text: "They want a second kiln run by December." },
    {
      type: "bullets",
      items: ["Bring the glaze samples", "Ask about lead times"],
    },
  ],
};

const deck = {
  kind: "slides",
  title: "This week's orders",
  slides: [
    {
      title: "Orders by day",
      blocks: [
        {
          type: "bars",
          label: "Orders",
          items: [
            { label: "Mon", value: 12 },
            { label: "Tue", value: 18 },
          ],
        },
      ],
    },
    {
      title: "What changed",
      blocks: [{ type: "text", text: "Weekends grew." }],
    },
  ],
};

const dashboard = {
  kind: "page",
  title: "Marlo Pulse",
  blocks: [
    {
      type: "text",
      text: "Healthy, with one leak: weekend delivery at Valencia.",
    },
    {
      type: "metrics",
      items: Array.from({ length: 8 }, (_, index) => ({
        label: `Metric ${index + 1}`,
        value: "$528K",
        note: "+11% vs last year",
      })),
    },
    {
      type: "list",
      title: "Where to look",
      items: [
        { text: "Valencia delivery errors" },
        { text: "Northford teams", note: "Two leads out" },
      ],
    },
  ],
};

describe("the make_page tool", () => {
  test("is held under the openduet ref and says a dashboard leads with a headline and metrics", () => {
    expect(tool().name).toBe(PAGE_TOOL);
    expect(tool().ref).toBe("openduet/make_page");
    expect(tool().initiator).toEqual(INITIATOR);
    expect(tool().description).toContain("dashboard is a page that starts");
    expect(tool().description).toContain("never paste its content");
    // The model is offered a JSON schema; it has to be one.
    expect(z.toJSONSchema(tool().parameters)).toMatchObject({ type: "object" });
  });

  test("saves a page, a deck and a dashboard, and answers with what the card draws", async () => {
    for (const args of [prep, deck, dashboard]) {
      const answer = await tool().execute(args);
      expect(answer).not.toStartWith("Refused.");
      const saved = JSON.parse(answer);
      expect(saved).toMatchObject({
        id: "page-1",
        kind: args.kind,
        title: args.title,
        updatedAt: "2026-10-22T12:52:00.000Z",
      });
      // The card's data, never the whole content.
      expect(saved.content).toBeUndefined();
      expect(saved.preview.blocks.length).toBeGreaterThan(0);
    }
    const slides = JSON.parse(await tool().execute(deck));
    expect(slides.slideCount).toBe(2);
    expect(slides.preview.title).toBe("Orders by day");
  });

  test("refuses what the app cannot draw, naming where and what to fix", async () => {
    const refusals: [unknown, string][] = [
      [{ ...prep, blocks: undefined }, "blocks: This kind needs blocks."],
      [{ ...deck, slides: undefined }, 'slides: A "slides" deck needs slides.'],
      [{ ...prep, slides: deck.slides }, "slides:"],
      [{ ...prep, kind: "video" }, "kind:"],
      [{ ...prep, title: "x".repeat(81) }, "title:"],
      [{ ...prep, summary: "x".repeat(141) }, "summary:"],
      [{ ...prep, blocks: [{ type: "image", url: "x" }] }, "blocks.0"],
      [
        {
          ...dashboard,
          blocks: [
            {
              type: "metrics",
              items: Array.from({ length: 9 }, () => ({
                label: "a",
                value: "1",
              })),
            },
          ],
        },
        "blocks.0.items",
      ],
      [
        {
          ...prep,
          blocks: [
            {
              type: "metrics",
              items: [{ label: "a", value: "1", delta: "+2" }],
            },
          ],
        },
        "blocks.0.items.0",
      ],
      [
        {
          ...prep,
          blocks: [
            {
              type: "bars",
              items: Array.from({ length: 13 }, (_, i) => ({
                label: `${i}`,
                value: i,
              })),
            },
          ],
        },
        "blocks.0.items",
      ],
      [
        {
          ...prep,
          blocks: [{ type: "bars", items: [{ label: "a", value: -1 }] }],
        },
        "blocks.0.items.0.value",
      ],
      [
        {
          ...prep,
          blocks: [
            {
              type: "list",
              items: Array.from({ length: 9 }, () => ({ text: "a" })),
            },
          ],
        },
        "blocks.0.items",
      ],
      [
        {
          ...deck,
          slides: [
            {
              title: "Too much",
              // More than a slide takes from the model; a fifth block continues.
              blocks: Array.from({ length: 9 }, () => ({
                type: "text",
                text: "a",
              })),
            },
          ],
        },
        "slides.0.blocks",
      ],
      [{ ...prep, extra: true }, "Unrecognized key"],
      [undefined, "kind:"],
    ];
    for (const [args, where] of refusals) {
      const answer = await tool().execute(args);
      expect(answer).toStartWith("Refused. make_page could not save this.");
      expect(answer).toContain(where);
      expect(answer).toEndWith(
        `Fix it and call make_page again. ${FIX_SILENTLY}`,
      );
    }
  });

  test("passes a revision's id to the store, and refuses an id that is not the person's", async () => {
    const seen: PageInput[] = [];
    const revising = tool(async (input) => {
      seen.push(input);
      throw new PageNotFoundError();
    });
    const answer = await revising.execute({
      ...prep,
      id: "someone-elses",
      expectedUpdatedAt: "2026-10-22T12:52:00.000Z",
    });
    expect(seen[0]?.id).toBe("someone-elses");
    expect(answer).toBe(
      'Refused. There is no page of yours with the id "someone-elses". Leave id out to make a new one.',
    );
  });

  test("trims what it keeps", () => {
    const parsed = parsePageInput({ ...prep, title: "  Hearth & Co  " });
    expect(parsed.ok && parsed.value.title).toBe("Hearth & Co");
  });
});

describe("a card's preview", () => {
  const chart = {
    type: "bars" as const,
    items: [
      { label: "Mon", value: 12 },
      { label: "Tue", value: 18 },
      { label: "Wed", value: 24 },
    ],
  };
  test("a deck whose chart is on slide 3 previews slide 3's bars", () => {
    expect(
      previewOf({
        slides: [
          { title: "Cover", blocks: [{ type: "text", text: "This week." }] },
          {
            title: "Highlights",
            blocks: [{ type: "bullets", items: ["Weekends grew"] }],
          },
          { title: "Orders by day", blocks: [chart] },
          { title: "Next week", blocks: [chart] },
        ],
      }),
    ).toEqual({ title: "Orders by day", blocks: [chart] });
  });

  test("a deck with no chart previews its first slide, and a page its first four blocks", () => {
    expect(
      previewOf({
        slides: [
          { title: "Cover", blocks: [] },
          { title: "Second", blocks: [] },
        ],
      }),
    ).toEqual({ title: "Cover", blocks: [] });
    expect(previewOf({ slides: [] })).toEqual({ blocks: [] });
    const text = (n: number) => ({ type: "text" as const, text: `Line ${n}` });
    expect(
      previewOf({ blocks: [1, 2, 3, 4, 5].map(text) }).blocks,
    ).toHaveLength(4);
  });
});
