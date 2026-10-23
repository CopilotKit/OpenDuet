import { describe, expect, test } from "bun:test";
import {
  barsLayout,
  linesOf,
  metricColumns,
  ROW_LABEL_WIDTH,
  rowLabelWidth,
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
};

const mugsChart = {
  type: "bars",
  label: "Mugs for the Friday ship date",
  items: [
    { label: "Current order", value: 120 },
    { label: "Ana's ask", value: 200 },
  ],
};
const mugsBullets = {
  type: "bullets",
  items: [
    "The extra 80 mugs is a 67% jump on the same date.",
    "The kiln is out of service until Monday (Dev Patel, Kilnworks).",
    "I can't see how many mugs are already fired, so check before you promise anything.",
    "Ana needs an answer today. She says she'll confirm the 200 today if you can do it.",
  ],
};
const hearth = {
  title: "Hearth & Co: 120 now, 200 asked",
  blocks: [mugsChart, mugsBullets],
};

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
};

const deck = (...slides: unknown[]) => ({
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
    const want = stringsOf(input.slides as PageSlide[]).filter(Boolean);
    const got = stringsOf(slides).filter(Boolean);
    expect(got.join("\n")).toContain(want.slice(0, 1).join("\n"));
    for (const text of want) expect(got).toContain(text);
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
    for (const list of lists.slice(1))
      expect(list?.type === "list" && list.title).toBeUndefined();
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
    expect(slides.at(-1)?.blocks[0]?.type).toBe("heading");
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
    ]) {
      const parsed = saved(deck({ title: "Orders by day", blocks: [block] }));
      expect(parsed.continued).toBeUndefined();
    }
  });

  test("a slide's lines may run longer than a page's, since they wrap and continue", () => {
    const note = "n".repeat(10).concat(" ").repeat(12).trim(); // 131 characters
    const slideList = { type: "list", items: [{ text: "Hearth & Co", note }] };
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
    const list = { type: "list", items: rows };
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
        items: week.items.map((i) => ({ ...i, label: i.label.slice(0, 3) })),
      }),
    ).toBe("columns");
    expect(
      saved(deck({ title: "Orders by day", blocks: [week] })).continued,
    ).toBeUndefined();
  });
});

describe("a chart is never refused for its height", () => {
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
    expect(rowLabelWidth(block)).toBeGreaterThanOrEqual(Math.ceil(widest));
    const result = saved(deck({ title: "Who writes to you", blocks: [block] }));
    expect(result.value.slides).toHaveLength(1);
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
    expect(slides[0]?.blocks.map((block) => block.type)).toEqual(["text"]);
    const parts = slides
      .slice(1)
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
    const slides = (count: number, items: number) =>
      Array.from({ length: count }, (_, i) => ({
        title: `Slide ${i + 1}`,
        blocks: [{ type: "list", items: rows(items) }],
      }));
    expect(saved(deck(...slides(12, 8))).value.slides).toHaveLength(24);
    expect(saved(deck(...slides(20, 8))).value.slides).toHaveLength(40);
    const parsed = parsePageInput(deck(...slides(20, 12)));
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.refusal).toContain(
      "this deck runs to 60 slides, and a deck has at most 40",
    );
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
