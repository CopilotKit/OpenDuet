import { describe, expect, test } from "bun:test";
import {
  barFigure,
  barsLayout,
  blockHeight,
  figuresTooWide,
  linesOf,
  metricColumns,
  ROW_LABEL_WIDTH,
  rowLabelWidth,
  slideGeometry,
  widthOf,
} from "@openbot/shared/slide-fit";
import { z } from "zod";
import {
  FIX_SILENTLY,
  layOutDeck,
  MAX_BARS,
  MAX_BULLETS,
  MAX_LIST,
  MAX_METRICS,
  MAX_SLIDE_BLOCKS,
  type PageBlock,
  type PageSlide,
  SLIDE_FIT_HEIGHT,
  SLIDE_MAX_BARS,
  SLIDE_MAX_BULLETS,
  SLIDE_MAX_LIST,
  SLIDE_MAX_METRICS,
  slideHeight,
} from "../src/openduet/page-content";
import {
  offeredInputSchema,
  type PageInput,
  type PageRecord,
  pageInputSchema,
  pageTools,
  parsePageInput,
  previewOf,
} from "../src/openduet/pages";

/*
 * A deck is only worth saving if every slide can be read in full on a phone. These tests hold the
 * tool to that: a slide with more than a phone shows is laid out at save onto continuation slides,
 * with nothing dropped and nothing refused for length; only what cannot be laid out is refused.
 *
 * The deck is the one the parity review made on 2026-10-22 ("Make me a 3-slide deck on this week's
 * orders, with a chart."). The tool accepted it, and the viewer showed 3 of 4 figures, 2 of 4
 * bullets and 3 of 7 rows.
 */

const ordersAtAGlance = {
  title: "Orders at a glance",
  blocks: [
    {
      type: "text",
      text: "Only the Hearth & Co order is a big one, and it's at risk. The store is paused too.",
    },
    {
      type: "metrics",
      items: [
        {
          label: "Hearth & Co",
          value: "120 mugs",
          note: "Ana asks if 200 is possible",
        },
        {
          label: "Order #1038",
          value: "2 of 4 cracked",
          note: "Jordan Lee wants a refund or replacements",
        },
        {
          label: "Inbound CW-8830",
          value: "50 lb porcelain",
          note: "Arrives Oct 28",
        },
        {
          label: "Shopify store",
          value: "Paused",
          note: "Expired payment method; checkout closed",
        },
      ],
    },
    {
      type: "text",
      text: "Source: Gmail, read today. Order totals and revenue aren't in your inbox, so none are shown.",
    },
  ],
} satisfies PageSlide;

const mugsChart = {
  type: "bars",
  label: "Mugs for the Friday ship date",
  items: [
    { label: "Current order", value: 120 },
    { label: "Ana's ask", value: 200 },
  ],
} satisfies PageBlock;
const mugsBullets = {
  type: "bullets",
  items: [
    "The extra 80 mugs is a 67% jump on the same date.",
    "The kiln is out of service until Monday (Dev Patel, Kilnworks).",
    "I can't see how many mugs are already fired, so check before you promise anything.",
    "Ana needs an answer today. She says she'll confirm the 200 today if you can do it.",
  ],
} satisfies PageBlock;
const hearth = {
  title: "Hearth & Co: 120 now, 200 asked",
  blocks: [mugsChart, mugsBullets],
} satisfies PageSlide;

const decisions = [
  {
    note: "Ana needs to tell her stores by end of day",
    text: "Hearth: confirm Friday for 120, and say yes or no to 200",
  },
  { note: "Sam is blocked on packing", text: "Boxes: double-wall or regular" },
  {
    note: "Rosa Lind needs a reply by end of day; Speckled White is two weeks late",
    text: "Glaze: accept the Oat Satin substitute",
  },
  {
    note: "Jordan Lee sent photos",
    text: "Order #1038: refund or replace two bowls",
  },
  {
    note: "Store paused for an expired payment method",
    text: "Shopify: update billing to reopen checkout",
  },
  {
    note: "Update payment within 48 hours to keep the supply account",
    text: "Clayworks invoice #5521: $640 card declined",
  },
  {
    note: "Leah Gold, referred by Ana",
    text: "Golden Hour Home: send samples by Tuesday",
  },
];
const whatNeedsADecision = {
  title: "What needs a decision",
  blocks: [{ type: "list", title: "Order-related items", items: decisions }],
} satisfies PageSlide;

const deck = (...slides: PageSlide[]) => ({
  kind: "slides",
  title: "This week's orders",
  summary: "Three slides on the orders visible in your inbox and calendar.",
  slides,
});

function saved(input: unknown) {
  const parsed = parsePageInput(input);
  if (!parsed.ok) throw new Error(parsed.refusal);
  return parsed;
}

/** Every string a deck holds, so a test can say none was dropped on the way. */
function stringsOf(slides: readonly PageSlide[]): string[] {
  return slides.flatMap((slide) =>
    slide.blocks.flatMap((block) => {
      switch (block.type) {
        case "heading":
        case "text":
          return [block.text];
        case "bullets":
          return block.items;
        case "metrics":
          return block.items.flatMap((m) => [m.label, m.value, m.note ?? ""]);
        case "bars":
          return [block.label ?? "", ...block.items.map((i) => i.label)];
        case "list":
          return [
            block.title ?? "",
            ...block.items.flatMap((i) => [i.text, i.note ?? ""]),
          ];
        default:
          return [];
      }
    }),
  );
}

/** Whether every slide shows whole on a phone: few enough blocks and items, short enough. */
function everySlideFits(slides: readonly PageSlide[]) {
  for (const slide of slides) {
    expect(slideHeight(slide)).toBeLessThanOrEqual(SLIDE_FIT_HEIGHT);
    expect(slide.blocks.length).toBeLessThanOrEqual(MAX_SLIDE_BLOCKS);
    for (const block of slide.blocks) {
      const most = {
        metrics: SLIDE_MAX_METRICS,
        bullets: SLIDE_MAX_BULLETS,
        list: SLIDE_MAX_LIST,
        bars: SLIDE_MAX_BARS,
      }[block.type as "metrics"];
      if ("items" in block && most)
        expect(block.items.length).toBeLessThanOrEqual(most);
    }
  }
}

describe("a deck the review made, which the viewer cut short", () => {
  test("is saved whole: each slide that runs past a phone continues onto the next, nothing dropped", () => {
    const input = deck(ordersAtAGlance, hearth, whatNeedsADecision);
    const parsed = saved(input);
    const slides = parsed.value.slides ?? [];
    expect(slides.length).toBeGreaterThan(3);
    expect(parsed.continued).toEqual({ from: 3, to: slides.length });
    everySlideFits(slides);
    // Every figure, bullet, row and note the model wrote, in the order it wrote them.
    const want = stringsOf(input.slides).filter(Boolean);
    const got = stringsOf(slides).filter(Boolean);
    expect(got.join("\n")).toContain(want.slice(0, 1).join("\n"));
    for (const text of want) expect(got.join(" ")).toContain(text);
    // Text is cut nowhere: each sentence the model wrote is still one string.
    expect(got).toContain(
      "Only the Hearth & Co order is a big one, and it's at risk. The store is paused too.",
    );
  });

  test("seven decision rows continue onto new slides, the list's title on the first, the slide's on each", () => {
    const slides = saved(deck(whatNeedsADecision)).value.slides ?? [];
    expect(slides.length).toBeGreaterThan(1);
    everySlideFits(slides);
    expect(slides.map((slide) => slide.title)).toEqual([
      "What needs a decision",
      ...slides.slice(1).map(() => "What needs a decision (continued)"),
    ]);
    const lists = slides.map((slide) => slide.blocks[0]);
    const rows = lists.flatMap((list) =>
      list?.type === "list" ? list.items : [],
    );
    expect(rows).toEqual(decisions);
    expect(lists[0]?.type === "list" && lists[0].title).toBe(
      "Order-related items",
    );
    // Every continuation is a list, and none repeats the title.
    for (const list of lists.slice(1)) {
      expect(list?.type).toBe("list");
      expect(list && "title" in list).toBe(false);
    }
  });

  test("a deck's thumbnail shows a continued chart slide under its own title", () => {
    const slides =
      saved(
        deck({
          title: "Inbox this week",
          blocks: [
            { type: "text", text: "Fifty emails read." },
            ordersAtAGlance.blocks[1],
            mugsChart,
          ],
        }),
      ).value.slides ?? [];
    expect(
      slides.some((slide) => slide.title === "Inbox this week (continued)"),
    ).toBe(true);
    expect(previewOf({ slides }).title).toBe("Inbox this week");
  });

  test("a slide that fits is saved as written, and the tool says nothing about continuing", () => {
    const parsed = saved(
      deck(
        { title: "Orders by day", blocks: [mugsChart] },
        { title: "Why", blocks: [] },
      ),
    );
    expect(parsed.continued).toBeUndefined();
    expect(parsed.value.slides).toHaveLength(2);
  });
});

describe("laying a slide out", () => {
  const many = <T>(count: number, make: (index: number) => T) =>
    Array.from({ length: count }, (_, index) => make(index));

  test("a heading never ends a slide: it goes over with the block it heads", () => {
    const rows = many(4, (i) => ({
      text: `Row ${i + 1} that needs a decision today`,
      note: "Someone is waiting on this one",
    }));
    const slides = layOutDeck([
      {
        title: "This week",
        blocks: [
          { type: "list", items: rows },
          { type: "heading", text: "Next week" },
          { type: "list", items: rows },
        ],
      },
    ]).slides;
    everySlideFits(slides);
    for (const slide of slides)
      expect(
        slide.blocks.at(-1)?.type === "heading" && slide.blocks.length > 1,
      ).toBe(false);
    const headed = slides.find((slide) =>
      slide.blocks.some((block) => block.type === "heading"),
    );
    expect(headed?.blocks.at(-1)?.type).toBe("list");
  });

  test("a text too long for any slide continues by sentence", () => {
    const sentence = (n: number) =>
      `Sentence ${n} says something about the orders that came in this week. `;
    const text = many(16, sentence).join("").trim();
    const slides = layOutDeck([
      { title: "Notes", blocks: [{ type: "text", text }] },
    ]).slides;
    expect(slides.length).toBeGreaterThan(1);
    everySlideFits(slides);
    const parts = slides.map(
      (slide) => slide.blocks[0]?.type === "text" && slide.blocks[0].text,
    );
    expect(parts.join(" ")).toBe(text);
    for (const part of parts) expect(part).toMatch(/\.$/);
  });

  test("more blocks than a slide takes continue, three to a slide", () => {
    const slides = layOutDeck([
      {
        title: "Short points",
        blocks: many(7, (i) => ({
          type: "text" as const,
          text: `Point ${i + 1}.`,
        })),
      },
    ]).slides;
    expect(slides.map((slide) => slide.blocks.length)).toEqual([3, 3, 1]);
  });

  test("a slide takes up to its caps of each block, short items fitting, as written", () => {
    for (const block of [
      {
        type: "metrics",
        items: many(SLIDE_MAX_METRICS, (i) => ({
          label: `Store ${i + 1}`,
          value: "$4.2K",
        })),
      },
      {
        type: "bars",
        items: many(SLIDE_MAX_BARS, (i) => ({
          label: `M${i + 1}`,
          value: 10 + i,
        })),
      },
      {
        type: "bullets",
        items: many(SLIDE_MAX_BULLETS, (i) => `Point ${i + 1}`),
      },
      {
        type: "list",
        items: many(SLIDE_MAX_LIST, (i) => ({ text: `Row ${i + 1}` })),
      },
    ] satisfies PageBlock[]) {
      const parsed = saved(deck({ title: "Orders by day", blocks: [block] }));
      expect(parsed.continued).toBeUndefined();
    }
  });

  test("a slide's lines may run longer than a page's, since they wrap and continue", () => {
    const note = "n".repeat(10).concat(" ").repeat(12).trim(); // 131 characters
    const slideList = {
      type: "list",
      items: [{ text: "Hearth & Co", note }],
    } satisfies PageBlock;
    expect(
      saved(deck({ title: "Notes", blocks: [slideList] })).value.slides,
    ).toHaveLength(1);
    expect(
      parsePageInput({ kind: "page", title: "A page", blocks: [slideList] }).ok,
    ).toBe(false);
  });

  test("fourteen rows on one slide are laid out four to a slide, though a page takes eight", () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({
      text: `Email ${i + 1}`,
      note: "Waiting on a reply",
    }));
    const list = { type: "list", items: rows } satisfies PageBlock;
    const slides =
      saved(deck({ title: "Replies", blocks: [list] })).value.slides ?? [];
    everySlideFits(slides);
    expect(
      slides.flatMap((slide) =>
        slide.blocks.flatMap((b) => (b.type === "list" ? b.items : [])),
      ),
    ).toEqual(rows);
    expect(
      parsePageInput({ kind: "page", title: "A page", blocks: [list] }).ok,
    ).toBe(false);
  });

  test("a blank optional note, title, label or summary is dropped rather than refused", () => {
    const parsed = saved({
      ...deck({
        title: "Orders",
        blocks: [
          { type: "list", title: " ", items: [{ text: "Ana", note: "" }] },
          { type: "bars", label: "", items: [{ label: "Mon", value: 3 }] },
        ],
      }),
      summary: "",
    });
    expect(parsed.value.summary).toBeUndefined();
    expect(parsed.value.slides?.[0]?.blocks).toEqual([
      { type: "list", items: [{ text: "Ana" }] },
      { type: "bars", items: [{ label: "Mon", value: 3 }] },
    ]);
    // A required string left blank is still refused.
    expect(parsePageInput(deck({ title: "", blocks: [] })).ok).toBe(false);
  });

  test("a page keeps the limits it had", () => {
    expect([MAX_METRICS, MAX_BARS, MAX_LIST, MAX_BULLETS]).toEqual([
      8, 12, 8, 12,
    ]);
  });

  test("figures too wide for half a slide take a whole-width tile each, rather than breaking", () => {
    const wide = {
      type: "metrics" as const,
      items: [
        { label: "Revenue", value: "$1,234,567.89" },
        { label: "Orders", value: "1,204" },
      ],
    };
    expect(metricColumns(wide)).toBe(1);
    expect(saved(deck({ title: "Cash", blocks: [wide] })).ok).toBe(true);
  });

  test("a weekday chart with full day names lies in rows, and saves", () => {
    const week = {
      type: "bars" as const,
      label: "Emails by day",
      items: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ].map((label, value) => ({ label, value: 10 + value })),
    };
    expect(barsLayout(week)).toBe("rows");
    expect(
      barsLayout({
        ...week,
        items: week.items.map((i) => ({ ...i, label: i.label.slice(0, 1) })),
      }),
    ).toBe("columns");
    expect(
      saved(deck({ title: "Orders by day", blocks: [week] })).continued,
    ).toBeUndefined();
  });
});

describe("slide titles fit with or without body blocks", () => {
  const overflowing = "\u2167".repeat(80);
  const body = [{ type: "text" as const, text: "Start here." }];

  test.each([
    ["short title without blocks", "Plan", []],
    ["short title with a body", "Plan", body],
    ["overflowing title without blocks", overflowing, []],
    ["overflowing title with a body", overflowing, body],
  ] satisfies [string, string, PageBlock[]][])("%s", (_name, title, blocks) => {
    expect(slideGeometry(2).fitHeight).toBe(232);
    const input = deck({ title, blocks });
    const parsed = parsePageInput(input);
    if (title === overflowing) {
      expect(slideHeight({ title, blocks: [] })).toBeGreaterThan(232);
      if (parsed.ok) throw new Error("expected a title refusal");
      expect(parsed.refusal).toContain(
        "slides.0.title: This slide's title is taller than a phone shows by itself",
      );
      expect(parsed.refusal).toContain("Shorten the title.");
      expect(parsed.refusal).toEndWith(FIX_SILENTLY);
      return;
    }
    if (!parsed.ok) throw new Error(parsed.refusal);
    expect(parsed.value.slides).toEqual(input.slides);
    everySlideFits(parsed.value.slides ?? []);
  });
});

describe("localized numeric figures stay whole", () => {
  for (const version of [1, 2] as const) {
    for (const [name, separator] of [
      ["NBSP", "\u00a0"],
      ["narrow NBSP", "\u202f"],
    ] as const) {
      const groups = ["123", "456", "789", "012", "345", "678"];
      test.each([
        ["narrow-fitting", ["12", "345"].join(separator)],
        [
          "full-width-only",
          groups
            .slice(0, version === 2 && name === "narrow NBSP" ? 3 : 4)
            .join(separator),
        ],
        [
          "too-wide",
          // Seven NBSP groups exceed v1's 278px tile but also the 24-character input cap.
          // Uneven grouping reaches that width within the cap; v2 keeps the exact R4 repro.
          version === 1 && name === "NBSP"
            ? ["12345678901234567890", "123"].join(separator)
            : groups.join(separator),
        ],
      ] as const)(`%s with ${name} in layout v${version}`, (band, value) => {
        const { contentWidth, fitHeight } = slideGeometry(version);
        const narrow = (contentWidth - 8) / 2 - 20;
        const full = contentWidth - 20;
        const whole = widthOf(value, 18, "bold");
        expect(value.length).toBeLessThanOrEqual(24);
        if (band === "narrow-fitting")
          expect(whole).toBeLessThanOrEqual(narrow);
        else expect(whole).toBeGreaterThan(narrow);
        if (band === "too-wide") expect(whole).toBeGreaterThan(full);
        else expect(whole).toBeLessThanOrEqual(full);

        const block = {
          type: "metrics" as const,
          items: [
            { label: "Revenue", value },
            { label: "Orders", value: "42" },
          ],
        };
        const input = deck({ title: "Cash", blocks: [block] });
        const parsed = parsePageInput(input, version);
        if (band === "too-wide") {
          if (parsed.ok) throw new Error("expected a width refusal");
          expect(parsed.refusal).toContain(
            `slides.0.blocks.0.items.0.value: "${value}"`,
          );
          expect(parsed.refusal).toContain("Write the figure shorter");
          expect(parsed.refusal).toEndWith(FIX_SILENTLY);
          expect(figuresTooWide(block, version)).toEqual([0]);
          expect(metricColumns(block, version)).toBe(1);
          return;
        }
        if (!parsed.ok) throw new Error(parsed.refusal);
        expect(parsed.value.slides).toEqual(input.slides);
        expect(figuresTooWide(block, version)).toEqual([]);
        const columns = metricColumns(block, version);
        expect(columns).toBe(band === "narrow-fitting" ? 2 : 1);
        const allocation = columns === 2 ? narrow : full;
        expect(whole).toBeLessThanOrEqual(allocation);
        expect(linesOf(value, 18, "bold", allocation)).toBe(1);
        for (const slide of parsed.value.slides ?? [])
          expect(slideHeight(slide, version)).toBeLessThanOrEqual(fitHeight);
      });
    }

    test(`ordinary ASCII text and compact figures remain accepted in layout v${version}`, () => {
      const block = {
        type: "metrics" as const,
        items: [
          { label: "Revenue", value: "$4.2K" },
          { label: "Orders", value: "12 345 678 901 234 567" },
        ],
      };
      const input = deck({
        title: "Cash",
        blocks: [{ type: "text", text: "Orders grew this week." }, block],
      });
      const parsed = parsePageInput(input, version);
      if (!parsed.ok) throw new Error(parsed.refusal);
      expect(parsed.value.slides).toEqual(input.slides);
      expect(metricColumns(block, version)).toBe(2);
      expect(figuresTooWide(block, version)).toEqual([]);
      for (const slide of parsed.value.slides ?? [])
        expect(slideHeight(slide, version)).toBeLessThanOrEqual(
          slideGeometry(version).fitHeight,
        );
    });
  }
});

describe("wide Arabic presentation ligatures", () => {
  const glyph = "\ufdfd";
  const unbroken = glyph.repeat(80);

  test("the body estimate covers the independent 400px browser measurement", () => {
    // R4 pages finding #2: Chrome 155.0.8059.85, Inter/ui-sans-serif/system-ui/sans-serif,
    // 232px width, 15px font, 20px line height, pre-line, overflow-wrap:anywhere => 400px.
    expect(slideGeometry(2).contentWidth).toBe(232);
    expect(
      blockHeight({ type: "text", text: unbroken }, 2),
    ).toBeGreaterThanOrEqual(400);
  });

  test("nearby word ligatures cover their measured fallback advances at both weights", () => {
    // Same offline Chrome/font stack, 13/15/18px at weights 400/600. Values are observed
    // maxima in em, not copied from the estimator's conservative range bounds.
    for (const [code, observed] of [
      [0xfdf0, 1.9182692307692308],
      [0xfdf1, 1.3052884615384615],
      [0xfdf3, 1.6072916666666666],
      [0xfdf5, 2.332291666666667],
      [0xfdf6, 2.34375],
      [0xfdf7, 1.7213541666666667],
      [0xfdf8, 2.1298076923076925],
      [0xfdf9, 2.019791666666667],
      [0xfdfb, 1.7416666666666667],
      [0xfdfd, 3.5520833333333335],
    ] as const) {
      for (const face of ["regular", "bold"] as const)
        expect(
          widthOf(String.fromCodePoint(code), 1, face),
        ).toBeGreaterThanOrEqual(observed);
    }
  });

  for (const version of [1, 2] as const) {
    test(`an oversized unbroken ligature run is refused in layout v${version}`, () => {
      const parsed = parsePageInput(
        {
          kind: "slides",
          title: "Probe",
          slides: [
            { title: "Test", blocks: [{ type: "text", text: unbroken }] },
          ],
        },
        version,
      );
      if (parsed.ok) throw new Error("expected an irreducible text refusal");
      expect(parsed.refusal).toContain("slides.0: This slide's text is taller");
      expect(parsed.refusal).toContain("Shorten it.");
      expect(parsed.refusal).toEndWith(FIX_SILENTLY);
    });

    test(`breakable ligature text continues in order in layout v${version}`, () => {
      const text = Array.from(
        { length: 80 },
        (_, index) => `${index + 1}${glyph}`,
      ).join(" ");
      const parsed = parsePageInput(
        deck({ title: "Test", blocks: [{ type: "text", text }] }),
        version,
      );
      if (!parsed.ok) throw new Error(parsed.refusal);
      const slides = parsed.value.slides ?? [];
      expect(slides.length).toBeGreaterThan(1);
      expect(stringsOf(slides).join(" ")).toBe(text);
      const { contentWidth, fitHeight } = slideGeometry(version);
      expect(contentWidth).toBe(version === 1 ? 298 : 232);
      expect(fitHeight).toBe(contentWidth);
      for (const slide of slides)
        expect(slideHeight(slide, version)).toBeLessThanOrEqual(fitHeight);
    });

    test(`short ligature text remains accepted in layout v${version}`, () => {
      const input = deck({
        title: "Test",
        blocks: [{ type: "text", text: `${glyph} Short text.` }],
      });
      const parsed = parsePageInput(input, version);
      if (!parsed.ok) throw new Error(parsed.refusal);
      expect(parsed.value.slides).toEqual(input.slides);
      for (const slide of parsed.value.slides ?? [])
        expect(slideHeight(slide, version)).toBeLessThanOrEqual(
          slideGeometry(version).fitHeight,
        );
    });
  }
});

describe("a chart is never refused for its height", () => {
  for (const version of [1, 2] as const) {
    test.each([0, 999, 1e12, 1e18, 1e21, 1e24, 1e42, Number.MAX_VALUE])(
      `finite bar value %s remains readable and unchanged in layout v${version}`,
      (value) => {
        const item = { label: "Count", value };
        // The single bar is the reported overflow; neighbors also exercise row allocations/order.
        for (const items of [
          [item],
          [
            { label: "EarlierComparison", value: 999 },
            item,
            { label: "LaterComparison", value: 0 },
          ],
        ]) {
          const parsed = parsePageInput(
            deck({ title: "Counts", blocks: [{ type: "bars", items }] }),
            version,
          );
          if (!parsed.ok) throw new Error(parsed.refusal);
          const slides = parsed.value.slides ?? [];
          const charts = slides
            .flatMap((slide) => slide.blocks)
            .filter((block) => block.type === "bars");
          expect(charts.flatMap((chart) => chart.items)).toEqual(items);
          const { contentWidth, fitHeight } = slideGeometry(version);
          for (const slide of slides)
            expect(slideHeight(slide, version)).toBeLessThanOrEqual(fitHeight);
          for (const chart of charts) {
            const rows = barsLayout(chart, version) === "rows";
            expect(rows).toBe(items.length > 1);
            const label = rowLabelWidth(chart, version);
            if (rows) {
              expect(Number.isFinite(label)).toBe(true);
              expect(label).toBeGreaterThan(0);
            }
            const allocation = rows
              ? contentWidth - label - 48 - 2 * 8
              : (contentWidth - 6 * (chart.items.length - 1)) /
                chart.items.length;
            for (const entry of chart.items)
              expect(
                widthOf(barFigure(entry.value), 13, "bold"),
              ).toBeLessThanOrEqual(allocation);
          }
        }
      },
    );
  }

  test("ordinary bar figures retain their compact display", () => {
    expect([0, 12, 999, 1500, 2.1e6, 1e12, 999e12].map(barFigure)).toEqual([
      "0",
      "12",
      "999",
      "1.5K",
      "2.1M",
      "1T",
      "999T",
    ]);
  });

  test("a chart by sender keeps each whole label on one line where the row has the room", () => {
    const senders = [
      "Coastal Bank: KilnMart charge",
      "Ana Pereira, Hearth & Co",
      "Rosa at Clayworks Supply",
      "noreply@shopify.com",
      "Priya Shah, accountant",
      "Dev Patel, kiln repairs",
      "Sam Okafor, studio",
      "Leah Gold, gallery",
    ];
    const block = {
      type: "bars" as const,
      label: "Emails by sender",
      items: senders.map((label, i) => ({ label, value: 12 - i })),
    };
    const widest = Math.max(
      ...senders.map((label) => widthOf(label, 13, "regular")),
    );
    expect(rowLabelWidth(block)).toBeLessThanOrEqual(Math.ceil(widest));
    expect(rowLabelWidth(block)).toBeGreaterThanOrEqual(ROW_LABEL_WIDTH);
    const result = saved(deck({ title: "Who writes to you", blocks: [block] }));
    everySlideFits(result.value.slides ?? []);
    expect(
      (result.value.slides ?? [])
        .flatMap((s) => s.blocks)
        .flatMap((b) => (b.type === "bars" ? b.items : [])),
    ).toEqual(block.items);
  });

  test("a chart taller than a slide goes on its own slide and continues its bars on one scale", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      label: `Wholesale order from a long-named shop ${i}`,
      value: i + 1,
    }));
    const result = saved(
      deck({
        title: "Orders",
        blocks: [
          { type: "text", text: "Orders by customer this month." },
          { type: "bars", items },
        ],
      }),
    );
    const slides = result.value.slides ?? [];
    expect(slides.length).toBeGreaterThanOrEqual(3);
    expect(slides[0]?.blocks[0]?.type).toBe("text");
    const parts = slides
      .flatMap((slide) => slide.blocks)
      .filter((block) => block.type === "bars");
    expect(parts.length).toBeGreaterThanOrEqual(2);
    // Every bar, in order, once.
    expect(parts.flatMap((part) => part.items)).toEqual(items);
    // Each part draws against the whole chart's largest value.
    for (const part of parts)
      expect((part as { scale?: number }).scale).toBe(12);
    for (const slide of slides)
      expect(slideHeight(slide)).toBeLessThanOrEqual(SLIDE_FIT_HEIGHT);
  });
});

describe("what is still refused, silently", () => {
  test("a figure too wide for even a whole-width tile", () => {
    const value = "Ж".repeat(15);
    expect(widthOf(value, 18, "bold")).toBeGreaterThan(278);
    const parsed = parsePageInput(
      deck({
        title: "Cash",
        blocks: [{ type: "metrics", items: [{ label: "Revenue", value }] }],
      }),
    );
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.refusal).toContain(
      `slides.0.blocks.0.items.0.value: "${value}"`,
    );
    expect(parsed.refusal).toEndWith(FIX_SILENTLY);
  });

  test("a deck that runs past forty slides once laid out, though its written slides may run past twenty", () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        text: `Row ${i} with a decision`,
        note: "Someone is waiting on this",
      }));
    const slides = (count: number, items: number): PageSlide[] =>
      Array.from({ length: count }, (_, i) => ({
        title: `Slide ${i + 1}`,
        blocks: [{ type: "list", items: rows(items) }],
      }));
    expect(saved(deck(...slides(12, 8))).value.slides).toHaveLength(24);
    expect(saved(deck(...slides(20, 8))).value.slides).toHaveLength(40);
    const parsed = parsePageInput(deck(...slides(20, 12)));
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.refusal).toContain("this deck has at most 40");
  });
});

describe("the fit check's measure", () => {
  test("a title alone is one line, and a slide is at most as tall as it is wide", () => {
    expect(slideHeight({ title: "Orders", blocks: [] })).toBe(22);
    expect(SLIDE_FIT_HEIGHT).toBeLessThanOrEqual(298);
  });

  test("lines break after a hyphen, dash, question mark or ellipsis, as Chrome breaks them, and not after a slash", () => {
    // Measured in Chrome at 90px: "aaaa-" | "bbbbbbbbbb" | "bbbbbb", and "x/12345678" | "90123456".
    expect(linesOf("aaaa-bbbbbbbbbbbbbbbb", 15, "regular", 90)).toBe(3);
    expect(linesOf("aaaa—bbbbbbbbbbbbbbbb", 15, "regular", 90)).toBe(3);
    expect(linesOf("x/1234567890123456", 15, "regular", 90)).toBe(2);
    expect(linesOf("double-wall boxes", 15, "regular", 1000)).toBe(1);
  });

  test("a row label's column widens to its longest word, so an address stays whole", () => {
    const bars = {
      type: "bars" as const,
      items: [
        { label: "noreply@shopify.com", value: 12 },
        { label: "Ana", value: 3 },
      ],
    };
    const width = rowLabelWidth(bars);
    expect(width).toBeGreaterThan(ROW_LABEL_WIDTH);
    expect(widthOf("noreply@shopify.com", 13, "regular")).toBeLessThanOrEqual(
      width,
    );
    expect(
      rowLabelWidth({ ...bars, items: [{ label: "Mon", value: 1 }] }),
    ).toBe(ROW_LABEL_WIDTH);
  });

  test("Latin Extended, Greek and Cyrillic count at an em or more, so a word in them never reads short", () => {
    for (let code = 0x0100; code <= 0x052f; code++) {
      if (code >= 0x0300 && code <= 0x036f) continue;
      expect(
        widthOf(String.fromCodePoint(code), 13, "regular"),
      ).toBeGreaterThanOrEqual(13);
    }
    expect(widthOf("é", 13, "regular")).toBeLessThan(13);
  });

  test("more words make a taller slide, never a shorter one", () => {
    const short = slideHeight({
      title: "Orders",
      blocks: [{ type: "text", text: "Weekends grew." }],
    });
    const long = slideHeight({
      title: "Orders",
      blocks: [{ type: "text", text: "Weekends grew. ".repeat(12) }],
    });
    expect(long).toBeGreaterThan(short);
  });
});

describe("what the model is offered, and what it reads back", () => {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, inner]) => [key, canonical(inner)]),
          )
        : value;

  const tool = (save: (input: PageInput) => Promise<PageRecord>) => {
    const [only] = pageTools({ save, initiator: { kind: "person" } });
    if (!only) throw new Error("no tool");
    return only;
  };
  const record = (input: PageInput): PageRecord => ({
    checklistRevision: "a".repeat(64),
    id: "deck-1",
    botId: "openduet",
    kind: input.kind,
    title: input.title,
    summary: null,
    createdAt: "2026-10-22T12:52:00.000Z",
    updatedAt: "2026-10-22T12:52:00.000Z",
    slideCount: input.slides?.length ?? 0,
    preview: { blocks: [] },
    content: { slides: input.slides ?? [] },
  });

  test("the offered schema states exactly the limits the parser enforces", () => {
    expect(tool(async (input) => record(input)).parameters).toBe(
      offeredInputSchema,
    );
    for (const io of ["input", "output"] as const) {
      const offered = z.toJSONSchema(offeredInputSchema, { io });
      const enforced = z.toJSONSchema(pageInputSchema, { io });
      expect(canonical(offered)).toEqual(canonical(enforced));
    }
  });

  test("a deck that continues is saved in one call, and the result says to give only the count", async () => {
    const seen: PageInput[] = [];
    const answer = await tool(async (input) => {
      seen.push(input);
      return record(input);
    }).execute(deck(whatNeedsADecision));
    expect(seen).toHaveLength(1);
    const result = JSON.parse(answer);
    const count = seen[0]?.slides?.length ?? 0;
    expect(count).toBeGreaterThan(1);
    expect(result.slideCount).toBe(count);
    expect(result.note).toBe(
      `Saved as ${count} slides: what ran past a phone screen continued onto the next slide. Tell the person only how many slides it has, such as "It's ${count} slides.", and never why.`,
    );
  });

  test("the tool's description says a slide continues by itself, and to give only the count", () => {
    const description = tool(async (input) => record(input)).description;
    expect(description).toContain(
      "make_page carries the rest onto the next slide by itself",
    );
    expect(description).toContain(
      "never leave anything out or call again to make it fit",
    );
    expect(description).toContain(
      'Say only how many slides a deck has, such as "It\'s 3 slides.", never why',
    );
    expect(FIX_SILENTLY).toContain(
      "write nothing to them until the retry is saved",
    );
  });
});
