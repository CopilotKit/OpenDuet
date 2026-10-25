import { describe, expect, test } from "bun:test";
import {
  CURRENT_SLIDE_LAYOUT,
  type SlideLayoutVersion,
  slideGeometry,
} from "@openbot/shared/slide-fit";
import {
  FIX_SILENTLY,
  type PageSlide,
  SLIDE_FIT_HEIGHT,
  slideHeight,
} from "../src/openduet/page-content";
import { parsePageInput } from "../src/openduet/pages";

const longSentence = `${"A ".repeat(160).trim()}.`;
const slide = (text: string): PageSlide => ({
  title: "Notes",
  blocks: [{ type: "text", text }],
});
const deck = (slides: PageSlide[]) => ({
  kind: "slides",
  title: "Notes",
  slides,
});
function save(
  slides: PageSlide[],
  version: SlideLayoutVersion = CURRENT_SLIDE_LAYOUT,
) {
  const result = parsePageInput(deck(slides), version);
  if (!result.ok) throw new Error(result.refusal);
  const saved = result.value.slides ?? [];
  for (const part of saved)
    expect(slideHeight(part, version)).toBeLessThanOrEqual(
      slideGeometry(version).fitHeight,
    );
  return saved;
}
const textParts = (slides: PageSlide[]) =>
  slides.flatMap((part) =>
    part.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])),
  );

describe("text continuation at save", () => {
  test("an oversized first sentence still saves when another sentence follows", () => {
    for (const text of [longSentence, `${longSentence} Short.`]) {
      expect(slideHeight(slide(text))).toBeGreaterThan(SLIDE_FIT_HEIGHT);
      const saved = save([slide(text)]);
      expect(saved).toHaveLength(2);
      expect(textParts(saved).join(" ")).toBe(text);
      const revision = parsePageInput({ ...deck(saved), id: "saved-deck" });
      expect(revision.ok).toBe(true);
      if (revision.ok) expect(revision.value.slides).toEqual(saved);
    }
  });

  test("ordinary sentences stay whole around an oversized middle sentence", () => {
    const text = `Opening. ${longSentence} Closing.`;
    const saved = save([slide(text)]);
    const parts = textParts(saved);
    expect(parts[0]).toBe("Opening.");
    expect(parts.at(-1)).toEndWith("Closing.");
    expect(parts.join(" ")).toBe(text);
  });

  test("sentences that fit alone keep their boundary on continuation slides", () => {
    const sentence = `${"Detail ".repeat(30).trim()}.`;
    const text = `${sentence} ${sentence} ${sentence}`;
    expect(slideHeight(slide(sentence))).toBeLessThanOrEqual(SLIDE_FIT_HEIGHT);
    expect(textParts(save([slide(text)]))).toEqual([
      sentence,
      sentence,
      sentence,
    ]);
  });

  test("word continuation keeps the heading with its first text fragment", () => {
    const text = `${longSentence} Short.`;
    const saved = save([
      {
        ...slide(text),
        blocks: [
          { type: "heading", text: "Details" },
          { type: "text", text },
        ],
      },
    ]);
    expect(saved[0]?.blocks.map((block) => block.type)).toEqual([
      "heading",
      "text",
    ]);
    expect(textParts(saved).join(" ")).toBe(text);
  });

  test("a sentence that fits on a fresh slide moves whole past earlier blocks", () => {
    const sentence = `${"Detail ".repeat(30).trim()}.`;
    const text = `${sentence} Short.`;
    const saved = save([
      {
        ...slide(text),
        blocks: [
          { type: "text", text: sentence },
          { type: "text", text },
        ],
      },
    ]);
    expect(saved).toHaveLength(2);
    expect(textParts(saved)).toEqual([sentence, text]);
  });

  for (const version of [1, 2] as const) {
    for (const suffix of ["", " Short."]) {
      test(`a fitting ${suffix ? "first" : "single"} sentence moves intact past occupied content in layout v${version}`, () => {
        const sentence =
          "Please confirm the delivery schedule with the warehouse team before the end of this afternoon.";
        const text = `${sentence}${suffix}`;
        const prior = {
          type: "text" as const,
          text: Array.from(
            { length: version === 1 ? 11 : 7 },
            () => "Prior notes.",
          ).join("\n"),
        };
        const target = { type: "text" as const, text };
        const input: PageSlide = { title: "Plan", blocks: [prior, target] };
        const budget = slideGeometry(version).fitHeight;
        const fresh = (value: string): PageSlide => ({
          title: "Plan (continued)",
          blocks: [{ type: "text", text: value }],
        });
        // Both variants fit whole on a fresh slide; even the target sentence alone
        // exceeds the current remainder, independently of the short suffix.
        expect(slideHeight(fresh(sentence), version)).toBeLessThanOrEqual(
          budget,
        );
        expect(slideHeight(fresh(text), version)).toBeLessThanOrEqual(budget);
        expect(
          slideHeight({ ...input, blocks: [prior] }, version),
        ).toBeLessThanOrEqual(budget);
        expect(
          slideHeight(
            { ...input, blocks: [prior, { type: "text", text: sentence }] },
            version,
          ),
        ).toBeGreaterThan(budget);

        const saved = save([input], version);
        expect(saved).toHaveLength(2);
        expect(saved[0]?.blocks).toEqual([prior]);
        expect(saved[1]?.blocks).toEqual([target]);
        expect(textParts(saved)).toEqual([prior.text, text]);
      });
    }
  }

  test("multilingual word continuation retains punctuation, token order and internal whitespace", () => {
    const text = `${"“Café 6.5%,”  (доход)\t東京 👩🏽‍💻 é ".repeat(12).trim()}。短文。`;
    const parts = textParts(save([slide(text)]));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(
      text.replace(/\s+/g, " "),
    );
    // Only whitespace at the cut may be trimmed; every fragment is a literal source slice.
    for (const part of parts) expect(text).toContain(part);
    expect(parts.some((part) => part.includes("  (доход)\t東京"))).toBe(true);
    expect(parts.every((part) => !/^[”’)\]]/.test(part))).toBe(true);
    expect(parts.every((part) => !/6\.$/.test(part))).toBe(true);
  });

  test("sentences without separating spaces preserve their punctuation and order", () => {
    const text = "市場は拡大しました。注文が増えました。".repeat(12);
    const parts = textParts(save([slide(text)]));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(text);
    for (const part of parts) expect(part).toEndWith("。");
  });

  test("an irreducible token remains a bounded refusal", () => {
    const result = parsePageInput(deck([slide(`${"A".repeat(600)}. Short.`)]));
    if (result.ok) throw new Error("Expected an irreducible-token refusal");
    expect(result.refusal).toContain("taller than a phone shows by itself");
    expect(result.refusal).toEndWith(FIX_SILENTLY);
  });

  test("word continuations save at forty slides and refuse further expansion", () => {
    const input = Array.from({ length: 20 }, () =>
      slide(`${longSentence} Short.`),
    );
    expect(save(input)).toHaveLength(40);
    const result = parsePageInput(
      deck([slide(`${"A ".repeat(400).trim()}. Short.`), ...input.slice(1)]),
    );
    if (result.ok) throw new Error("Expected the deck ceiling refusal");
    expect(result.refusal).toContain("this deck has at most 40 slides");
    expect(result.refusal).toEndWith(FIX_SILENTLY);
  });
});
