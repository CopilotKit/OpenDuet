import { describe, expect, test } from "bun:test";
import {
  blockHeight,
  type SlideLayoutVersion,
  slideGeometry,
  slideHeight,
} from "@openbot/shared/slide-fit";
import type { PageSlide } from "../src/openduet/page-content";
import {
  offeredInputSchema,
  type PageInput,
  type PageRecord,
  pageTools,
  parsePageInput,
} from "../src/openduet/pages";

type DeckInput = PageInput & { kind: "slides"; slides: PageSlide[] };

function requireDeck(input: PageInput): asserts input is DeckInput {
  if (input.kind !== "slides" || !input.slides)
    throw new Error("Expected a deck with slides");
}

function saved(input: unknown) {
  const parsed = parsePageInput(input);
  if (!parsed.ok) throw new Error(parsed.refusal);
  requireDeck(parsed.value);
  return parsed.value;
}

const bars = {
  type: "bars" as const,
  items: Array.from({ length: 12 }, (_, i) => ({
    label: `Wholesale order from a long-named shop ${i}`,
    value: i + 1,
  })),
};
const deck = <T>(slides: T[]) => ({
  kind: "slides",
  title: "Revenue",
  slides,
});
const fragments = (slides: PageSlide[]) =>
  slides
    .flatMap((slide) => slide.blocks)
    .filter((block) => block.type === "bars");

/** Exercise the offered schema too: the SDK validates before make_page executes. */
async function readAndRevise(
  input: DeckInput,
  claimedVersion?: SlideLayoutVersion | null,
) {
  let record: PageRecord = {
    checklistRevision: "a".repeat(64),
    id: "saved-deck",
    botId: "openduet",
    kind: input.kind,
    title: input.title,
    summary: null,
    slideCount: input.slides.length,
    preview: { blocks: [] },
    content: {
      slides: input.slides,
      ...(input.layoutVersion ? { layoutVersion: input.layoutVersion } : {}),
    },
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
  };
  const tools = pageTools({
    initiator: { kind: "person" },
    get: async () => record,
    save: async (revision) => {
      expect(revision.id).toBe(record.id);
      requireDeck(revision);
      record = {
        ...record,
        title: revision.title,
        content: {
          slides: revision.slides,
          layoutVersion: revision.layoutVersion,
        },
        slideCount: revision.slides.length,
      };
      return record;
    },
  });
  const read = tools.find((tool) => tool.name === "read_page");
  const make = tools.find((tool) => tool.name === "make_page");
  if (!read || !make) throw new Error("Missing page tools");
  const current = JSON.parse(await read.execute({ id: record.id }));
  const revision = offeredInputSchema.parse({
    id: current.id,
    expectedUpdatedAt: current.updatedAt,
    kind: current.kind,
    title: "Revised revenue",
    ...current.content,
    // The saved page owns the version, even if the model omits or changes its metadata.
    ...(claimedVersion === undefined
      ? {}
      : { layoutVersion: claimedVersion ?? undefined }),
  });
  // The tool's offered schema must not strip the persisted chart metadata.
  expect(revision.slides).toEqual(input.slides);
  if (claimedVersion === undefined)
    expect(revision.layoutVersion).toBe(current.content.layoutVersion);
  const answer = await make.execute(revision);
  expect(answer).not.toStartWith("Refused.");
  expect(record.title).toBe("Revised revenue");
  const reread = JSON.parse(
    await read.execute({ id: record.id }),
  ) as PageRecord;
  expect(reread.createdAt).toBe(record.createdAt);
  if (!("slides" in reread.content)) throw new Error("Expected a deck");
  const version = reread.content.layoutVersion;
  expect(version).toBe(input.layoutVersion ?? 1);
  for (const slide of reread.content.slides)
    expect(slideHeight(slide, version)).toBeLessThanOrEqual(
      slideGeometry(version).fitHeight,
    );
  return reread;
}

const legacySlide = (): PageSlide => ({
  title: "Next steps",
  blocks: [
    {
      type: "bullets",
      items: Array(6).fill("Review the roadmap with the delivery team"),
    },
  ],
});

describe("saved page revision round trips", () => {
  test("legacy six-bullet slide keeps its content after a title-only revision", async () => {
    const original = {
      kind: "slides",
      title: "Legacy plan",
      slides: [legacySlide()],
    } satisfies DeckInput;
    const revised = await readAndRevise(original);
    expect(revised.content).toEqual({
      slides: original.slides,
      layoutVersion: 1,
    });
  });

  test("legacy near-limit deck stays editable without losing content or chart semantics", async () => {
    const chart = {
      type: "bars" as const,
      scale: 100,
      highlight: -1,
      items: [{ label: "Before", value: 20 }],
    };
    const slides = Array.from({ length: 39 }, (_, i) => ({
      ...legacySlide(),
      title: `Next steps ${i + 1}`,
    }));
    slides.push({
      title: "Last",
      blocks: [
        chart,
        { ...chart, highlight: 0, items: [{ label: "After", value: 100 }] },
      ],
    });
    const original = {
      kind: "slides",
      title: "Legacy plan",
      slides,
    } satisfies DeckInput;
    const revised = await readAndRevise(original);
    expect(revised.slideCount).toBe(40);
    expect(revised.content).toEqual({ slides, layoutVersion: 1 });
  });
  test("legacy twelve-bar slides retain the former item cap at the deck limit", async () => {
    const slides: PageSlide[] = Array.from({ length: 40 }, (_, i) => ({
      title: `Orders ${i + 1}`,
      blocks: [
        {
          type: "bars",
          label: "Weekly orders",
          scale: 100,
          highlight: 11,
          items: Array.from({ length: 12 }, (_, row) => ({
            label: `Week ${row + 1}`,
            value: row + 1,
          })),
        },
      ],
    }));
    const revised = await readAndRevise({
      kind: "slides",
      title: "Legacy orders",
      slides,
    });
    expect(revised.content).toEqual({ slides, layoutVersion: 1 });
  });

  test("new decks cannot request legacy geometry, while revisions retain the stored version", async () => {
    const original = saved({ ...deck([legacySlide()]), layoutVersion: 1 });
    expect(original.layoutVersion).toBe(2);
    expect(original.slides).toHaveLength(2);
    expect((await readAndRevise(original, 1)).content).toEqual({
      slides: original.slides,
      layoutVersion: 2,
    });
    const legacy = {
      kind: "slides",
      title: "Legacy",
      slides: [legacySlide()],
    } satisfies DeckInput;
    expect((await readAndRevise(legacy, 2)).content).toEqual({
      slides: legacy.slides,
      layoutVersion: 1,
    });
    // Both a verbatim read_page content copy and an omitted internal version remain editable.
    for (const persisted of [
      original,
      { ...legacy, layoutVersion: 1 as const },
    ]) {
      expect((await readAndRevise(persisted)).content).toEqual({
        slides: persisted.slides,
        layoutVersion: persisted.layoutVersion,
      });
      expect((await readAndRevise(persisted, null)).content).toEqual({
        slides: persisted.slides,
        layoutVersion: persisted.layoutVersion,
      });
    }
    expect(slideGeometry(1)).toEqual({
      width: 330,
      contentWidth: 298,
      fitHeight: 298,
      leastScale: 11 / 13,
    });
    expect(slideGeometry(2)).toEqual({
      width: 264,
      contentWidth: 232,
      fitHeight: 232,
      leastScale: 1,
    });
    const list = {
      type: "list" as const,
      items: [{ text: "One" }, { text: "Two" }],
    };
    expect(blockHeight(list, 1)).toBe(105);
    expect(blockHeight(list, 2)).toBe(89);
  });

  test("read_page content revises split bars without changing their common scale or highlight", async () => {
    const original = saved(deck([{ title: "Orders", blocks: [bars] }]));
    expect(original.slides.length).toBeGreaterThan(1);
    const revised = await readAndRevise(original);
    expect(revised.content).toEqual({
      slides: original.slides,
      layoutVersion: original.layoutVersion ?? 1,
    });
  });

  test("read_page content revises a saved forty-slide deck", async () => {
    const original = saved(
      deck(
        Array.from({ length: 20 }, (_, i) => ({
          title: `Slide ${i + 1}`,
          blocks: [
            {
              type: "list",
              items: Array.from({ length: 8 }, (_, row) => ({
                text: `Row ${row} with a decision`,
                note: "Someone is waiting on this",
              })),
            },
          ],
        })),
      ),
    );
    expect(original.slides).toHaveLength(40);
    const revised = await readAndRevise(original);
    expect(revised.slideCount).toBe(40);
    expect(revised.content).toEqual({
      slides: original.slides,
      layoutVersion: original.layoutVersion ?? 1,
    });
  });

  test("repeated chart splits retain one original highlight and a common scale", () => {
    const original = saved({
      ...deck([
        { title: "Orders", blocks: [{ ...bars, scale: 100, highlight: 1 }] },
      ]),
      id: "saved-deck",
    });
    const parts = fragments(original.slides);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((part) => part.items)).toEqual(bars.items);
    expect(parts.map((part) => part.scale)).toEqual(parts.map(() => 100));
    expect(
      parts.flatMap((part) =>
        part.items.filter((_, i) => i === part.highlight),
      ),
    ).toEqual([bars.items[1]]);
    expect(parts.slice(1).every((part) => part.highlight === -1)).toBe(true);
    expect(saved(original)).toEqual(original);
  });

  test("revision input and layout remain bounded at forty slides, and creation at twenty", () => {
    const slides = Array.from({ length: 41 }, () => ({
      title: "Plan",
      blocks: [],
    }));
    const excessive = parsePageInput({ ...deck(slides), id: "saved-deck" });
    expect(excessive.ok).toBe(false);
    expect(parsePageInput(deck(slides.slice(0, 21))).ok).toBe(false);
    const expanding = parsePageInput({
      ...deck(
        slides.slice(0, 40).map((slide) => ({
          ...slide,
          blocks: [bars],
        })),
      ),
      id: "saved-deck",
    });
    if (expanding.ok) throw new Error("Expected bounded layout refusal");
    expect(expanding.refusal).toContain("this deck has at most 40 slides");
  });

  test("zero-valued fragments and a highlight in a later fragment round trip", () => {
    for (const highlight of [-1, 0, 11]) {
      const input = {
        ...deck([
          {
            title: "Orders",
            blocks: [
              {
                type: "bars",
                scale: 0,
                highlight,
                items: [{ label: "A", value: 0 }],
              },
            ],
          },
        ] satisfies PageSlide[]),
        id: "saved-deck",
      };
      expect(saved(input).slides).toEqual(input.slides);
    }
  });

  test("supplied chart metadata must be finite, bounded, and large enough for every bar", () => {
    for (const [field, invalid] of [
      ["scale", -1],
      ["scale", 0],
      ["scale", 5],
      ["scale", Infinity],
      ["scale", NaN],
      ["scale", "12"],
      ["highlight", -2],
      ["highlight", 12],
      ["highlight", 0.5],
      ["highlight", Infinity],
      ["highlight", NaN],
      ["highlight", "1"],
    ] as const) {
      const parsed = parsePageInput({
        ...deck([
          {
            title: "Orders",
            blocks: [
              {
                ...bars,
                scale: 12,
                highlight: 11,
                [field]: invalid,
              },
            ],
          },
        ]),
        id: "saved-deck",
      });
      if (parsed.ok)
        throw new Error(`Expected refusal for ${field}: ${invalid}`);
      expect(parsed.refusal).toContain(`slides.0.blocks.0.${field}`);
    }
  });
});
