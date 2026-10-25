import { describe, expect, test } from "bun:test";
import { layOutDeck, pageBlockSchema } from "../src/openduet/page-content";
import { parsePageInput } from "../src/openduet/pages";

export const richBlocks = [
  {
    type: "timeline",
    items: [
      { date: "Oct 25", title: "Inspect kiln", text: "Check the coils." },
    ],
  },
  {
    type: "decision",
    question: "Repair or replace?",
    options: [
      { title: "Repair", pros: ["Less cost"], cons: ["One day offline"] },
      { title: "Replace", pros: ["Long warranty"], cons: ["Higher cost"] },
    ],
    pick: "Repair",
  },
  {
    type: "checklist",
    items: [{ id: "coils", text: "Inspect coils", checked: false }],
  },
  { type: "table", columns: ["Item", "Price"], rows: [["Mug", "$18"]] },
  {
    type: "comparison",
    columns: [
      { title: "Repair", items: ["$120"] },
      { title: "Replace", items: ["$800"] },
    ],
  },
  {
    type: "image",
    alt: "Kiln temperature",
    svg: '<svg viewBox="0 0 100 60"><path d="M0 50 L50 20 L100 10" stroke="var(--duet-violet)" fill="none"/></svg>',
  },
];

describe("rich pages", () => {
  for (const kind of [
    "page",
    "slides",
    "dashboard",
    "doc",
    "design",
    "design-system",
  ] as const) {
    test(`preserves ${kind} as its own kind`, () => {
      const content =
        kind === "slides"
          ? { slides: [{ title: "Sales", blocks: [] }] }
          : { blocks: [{ type: "text", text: "Sales grew." }] };
      const parsed = parsePageInput({
        kind,
        title: "Sales",
        theme: "studio",
        ...content,
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.kind).toBe(kind);
    });
  }
  for (const block of richBlocks) {
    test(`accepts and fits ${block.type}`, () => {
      const parsed = pageBlockSchema.safeParse(block);
      expect(parsed.success).toBe(true);
      if (parsed.success)
        expect(
          layOutDeck([{ title: "Plan", blocks: [parsed.data] }]).issues,
        ).toEqual([]);
    });
  }
  test("rejects rows with missing cells and repeated checklist ids", () => {
    expect(
      pageBlockSchema.safeParse({
        type: "table",
        columns: ["A", "B"],
        rows: [["one"]],
      }).success,
    ).toBe(false);
    expect(
      pageBlockSchema.safeParse({
        type: "checklist",
        items: [
          { id: "x", text: "A" },
          { id: "x", text: "B" },
        ],
      }).success,
    ).toBe(false);
  });
  test("invalid thumbnails are discarded without refusing the page", () => {
    const parsed = parsePageInput({
      kind: "page",
      title: "Plan",
      blocks: [{ type: "text", text: "A plan" }],
      thumbnail: "<svg><script>alert(1)</script></svg>",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.thumbnail).toBeUndefined();
  });
});

test("long timelines, checklists and tables continue without losing items", () => {
  for (const block of [
    {
      type: "timeline",
      items: Array.from({ length: 16 }, (_, i) => ({
        date: `Day ${i + 1}`,
        title: `Step ${i + 1}`,
        text: "Confirm the work.",
      })),
    },
    {
      type: "checklist",
      items: Array.from({ length: 20 }, (_, i) => ({
        id: `item-${i}`,
        text: `Check item ${i}`,
        checked: i === 0,
      })),
    },
    {
      type: "table",
      columns: ["Item", "Cost"],
      rows: Array.from({ length: 20 }, (_, i) => [`Item ${i}`, `$${i}`]),
    },
  ]) {
    const parsed = pageBlockSchema.parse(block);
    const laid = layOutDeck([{ title: "Plan", blocks: [parsed] }]);
    expect(laid.issues).toEqual([]);
    expect(laid.slides.length).toBeGreaterThan(1);
    const chunks = laid.slides.flatMap((slide) => slide.blocks);
    const count = chunks.reduce(
      (sum, item) =>
        sum +
        (item.type === "table"
          ? item.rows.length
          : "items" in item
            ? item.items.length
            : 0),
      0,
    );
    expect(count).toBe(
      block.type === "table"
        ? (block.rows?.length ?? 0)
        : (block.items?.length ?? 0),
    );
    if (parsed.type === "table") {
      const tables = chunks.filter((chunk) => chunk.type === "table");
      expect(tables.flatMap((table) => table.rows)).toEqual(parsed.rows);
      for (const table of tables) expect(table.columns).toEqual(parsed.columns);
    } else if (parsed.type === "timeline") {
      expect(
        chunks
          .filter((chunk) => chunk.type === "timeline")
          .flatMap((chunk) => chunk.items),
      ).toEqual(parsed.items);
    } else if (parsed.type === "checklist") {
      // Six short rows fit only if the legacy slide shrinks their screen targets below 44px.
      const legacy = layOutDeck([{ title: "Plan", blocks: [parsed] }], 1);
      expect(
        legacy.slides.flatMap((slide) =>
          slide.blocks.flatMap((chunk) =>
            chunk.type === "checklist" ? [chunk.items.length] : [],
          ),
        ),
      ).toEqual([5, 5, 5, 5]);
      expect(
        chunks
          .filter((chunk) => chunk.type === "checklist")
          .flatMap((chunk) => chunk.items),
      ).toEqual(parsed.items);
    } else {
      throw new Error(`Unexpected rich block type: ${parsed.type}`);
    }
  }
});
