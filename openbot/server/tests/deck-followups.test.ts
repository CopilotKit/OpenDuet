import { expect, test } from "bun:test";
import {
  LEAST_SCALE,
  SLIDE_WIDTH,
  slideGeometry,
} from "@openbot/shared/slide-fit";
import {
  FIX_SILENTLY,
  layOutDeck,
  MAX_SLIDE_BLOCKS,
  type PageBlock,
  type PageSlide,
  type ScaledBars,
  slideHeight,
} from "../src/openduet/page-content";
import { parsePageInput } from "../src/openduet/pages";

test("phone captions never scale below their authored size at 320px", () => {
  expect(SLIDE_WIDTH).toBeLessThanOrEqual(264);
  expect(LEAST_SCALE).toBe(1);
});

test("a heading shares its slide with the first part of a long block", () => {
  const result = layOutDeck([
    {
      title: "Repair",
      blocks: [
        { type: "heading", text: "Next steps" },
        {
          type: "bullets",
          items: Array.from(
            { length: 12 },
            (_, i) => `Step ${i}: check the kiln before firing.`,
          ),
        },
      ],
    },
  ]);
  expect(result.issues).toEqual([]);
  expect(result.slides[0]?.blocks.map((b) => b.type)).toEqual([
    "heading",
    "bullets",
  ]);
});

for (const version of [1, 2] as const) {
  for (const count of [2, 3] as const) {
    for (const type of ["text", "bullets"] as const) {
      test(`a ${count}-heading run stays attached or refuses ${type} in layout v${version}`, () => {
        const sentence =
          "Please confirm the delivery schedule with the warehouse team before the end of this afternoon.";
        const prior: PageBlock = {
          type: "text",
          text: Array.from(
            { length: version === 1 ? 8 : 5 },
            () => "Prior notes.",
          ).join("\n"),
        };
        const headings: PageBlock[] = ["First", "Second", "Third"]
          .slice(0, count)
          .map((name) => ({ type: "heading", text: `${name} heading` }));
        const content: PageBlock =
          type === "text"
            ? { type, text: sentence }
            : { type, items: [sentence] };
        const group = [...headings, content];
        const input: PageSlide = {
          title: "Plan",
          blocks: [prior, ...group],
        };
        const budget = slideGeometry(version).fitHeight;
        expect(
          slideHeight({ title: "Plan (continued)", blocks: group }, version),
        ).toBeLessThanOrEqual(budget);
        expect(
          slideHeight({ ...input, blocks: [prior] }, version),
        ).toBeLessThanOrEqual(budget);
        expect(slideHeight(input, version)).toBeGreaterThan(budget);

        const laid = layOutDeck([input], version);
        const parsed = parsePageInput(
          { kind: "slides", title: "Plan", slides: [input] },
          version,
        );
        // Three headings plus content fit geometrically, but exceed the existing
        // three-block cap. Refuse that group instead of stranding a prefix.
        if (count === 3) {
          expect(group.length).toBeGreaterThan(MAX_SLIDE_BLOCKS);
          expect(laid.slides).toEqual([]);
          expect(laid.issues[0]?.message).toContain(
            "heading and the first item below it do not fit together",
          );
          if (parsed.ok) throw new Error("Expected a heading-group refusal");
          expect(parsed.refusal).toContain(
            "heading and the first item below it do not fit together",
          );
          expect(parsed.refusal).toEndWith(FIX_SILENTLY);
          return;
        }

        expect(group.length).toBeLessThanOrEqual(MAX_SLIDE_BLOCKS);
        expect(laid.issues).toEqual([]);
        if (!parsed.ok) throw new Error(parsed.refusal);
        expect(parsed.value.slides).toEqual(laid.slides);
        expect(laid.slides.map((slide) => slide.blocks)).toEqual([
          [prior],
          group,
        ]);
        for (const preceding of laid.slides.slice(0, -1)) {
          for (let prefix = 1; prefix < headings.length; prefix++)
            expect(preceding.blocks.slice(-prefix)).not.toEqual(
              headings.slice(0, prefix),
            );
        }
        expect(laid.slides.flatMap((slide) => slide.blocks)).toEqual(
          input.blocks,
        );
      });
    }
  }
}

test("continuations do not duplicate their title suffix", () => {
  const result = layOutDeck([
    {
      title: "Repair (continued)",
      blocks: [
        {
          type: "bullets",
          items: Array.from(
            { length: 12 },
            () => "Inspect the kiln wiring before powering on.",
          ),
        },
      ],
    },
  ]);
  expect(result.slides.length).toBeGreaterThan(1);
  expect(
    result.slides.every((s) => !s.title.includes("(continued) (continued)")),
  ).toBe(true);
});

test("split text preserves decimal numbers and closing curly quotes", () => {
  const text = Array.from(
    { length: 16 },
    () => "He said “The rate is 6.5%.” Then the team agreed.",
  ).join(" ");
  const result = layOutDeck([
    { title: "Rates", blocks: [{ type: "text", text }] },
  ]);
  expect(result.issues).toEqual([]);
  const parts = result.slides
    .flatMap((s) => s.blocks)
    .map((b) => (b.type === "text" ? b.text : ""));
  expect(parts.join(" ")).toBe(text);
  expect(parts.every((p) => !/^[”’)\]]/.test(p))).toBe(true);
  expect(parts.every((p) => !/6\.$/.test(p))).toBe(true);
});

test("continued charts highlight only the original final bar", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    label: `Very long label for category ${i}`,
    value: i + 1,
  }));
  const result = layOutDeck([
    { title: "Categories", blocks: [{ type: "bars", items }] },
  ]);
  expect(result.issues).toEqual([]);
  const bars = result.slides
    .flatMap((s) => s.blocks)
    .filter((b) => b.type === "bars");
  expect(bars.length).toBeGreaterThan(1);
  const highlightedItems: ScaledBars["items"] = bars.flatMap((b) =>
    b.highlight !== undefined &&
    b.highlight >= 0 &&
    b.highlight < b.items.length
      ? [b.items[b.highlight]]
      : [],
  );
  const finalItem = items.at(-1);
  if (!finalItem) throw new Error("Expected a final chart item.");
  expect(highlightedItems).toHaveLength(1);
  expect(highlightedItems).toEqual([finalItem]);
});

test("oversized decks stop at the output cap", () => {
  const slides: PageSlide[] = Array.from({ length: 20 }, () => ({
    title: "Long report",
    blocks: Array.from({ length: 8 }, () => ({
      type: "text" as const,
      text: "Sentence with enough words to wrap. ".repeat(100),
    })),
  }));
  const start = performance.now();
  const result = layOutDeck(slides);
  expect(result.slides).toEqual([]);
  expect(result.issues[0]?.message).toContain("at most 40");
  expect(performance.now() - start).toBeLessThan(1000);
});

test("chart prefixes consider the shorter row layout after tall columns", () => {
  const result = layOutDeck([
    {
      title: "Repair",
      blocks: [
        { type: "heading", text: "Next steps for the kiln. ".repeat(4).trim() },
        {
          type: "bars",
          items: Array.from({ length: 7 }, (_, i) => ({
            label: "Ceramics",
            value: i + 1,
          })),
        },
      ],
    },
  ]);
  expect(result.issues).toEqual([]);
  expect(result.slides[0]?.blocks.map((b) => b.type)).toEqual([
    "heading",
    "bars",
  ]);
  const bars = result.slides
    .flatMap((s) => s.blocks)
    .filter((b) => b.type === "bars");
  expect(bars.reduce((count, block) => count + block.items.length, 0)).toBe(7);
});
