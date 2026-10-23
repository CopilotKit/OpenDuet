import { describe, expect, test } from "bun:test";
import { barsLayout, metricColumns, widthOf } from "@openbot/shared/slide-fit";
import { z } from "zod";
import {
  FIX_SILENTLY,
  MAX_BARS,
  MAX_BULLETS,
  MAX_LIST,
  MAX_METRICS,
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
  pageInputSchema,
  type PageRecord,
  pageTools,
  parsePageInput,
} from "../src/openduet/pages";

/*
 * A deck is only worth saving if every slide can be read in full on a phone. These tests hold the
 * tool to that: what a slide can't show is refused at save, with a line the model can act on, and
 * a deck split the way the refusal asks is saved whole.
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

function refusal(input: unknown): string {
  const parsed = parsePageInput(input);
  if (parsed.ok) throw new Error("expected the tool to refuse this");
  return parsed.refusal;
}

describe("a deck the review made, which the viewer cut short", () => {
  test("the slide with four figures and two lines of text is refused, saying how to split it", () => {
    const answer = refusal(deck(ordersAtAGlance));
    expect(answer).toStartWith("Refused. make_page could not save this.");
    expect(answer).toContain("slides.0: ");
    expect(answer).toContain("too full to read on a phone");
    expect(answer).toContain("new slide");
    expect(answer).toContain("Use more slides rather than leave anything out.");
    expect(answer).toEndWith(
      `Fix it and call make_page again. ${FIX_SILENTLY}`,
    );
    // Said once, though the slide's own message carries it too.
    expect(answer.split(FIX_SILENTLY)).toHaveLength(2);
  });

  test("every slide that doesn't fit is named in one refusal, so the deck is fixed in one retry", () => {
    const answer = refusal(deck(ordersAtAGlance, hearth));
    expect(answer).toContain("slides.0: ");
    expect(answer).toContain("slides.1: ");
  });

  test("seven decision rows on one slide are refused, naming the most a slide holds", () => {
    const answer = refusal(deck(whatNeedsADecision));
    expect(answer).toContain("slides.0.blocks.0.items: ");
    expect(answer).toContain(`${SLIDE_MAX_LIST}`);
  });

  test("the same content split across more slides saves whole, with nothing dropped", () => {
    const [summary, metrics, source] = ordersAtAGlance.blocks;
    const split = deck(
      { title: "Orders at a glance", blocks: [summary] },
      { title: "Where each order stands", blocks: [metrics] },
      { title: "Where this comes from", blocks: [source] },
      { title: "Hearth & Co: 120 now, 200 asked", blocks: [mugsChart] },
      { title: "What that means for Friday", blocks: [mugsBullets] },
      {
        title: "What needs a decision",
        blocks: [{ type: "list", items: decisions.slice(0, 4) }],
      },
      {
        title: "Also waiting on you",
        blocks: [{ type: "list", items: decisions.slice(4) }],
      },
    );
    const parsed = parsePageInput(split);
    if (!parsed.ok) throw new Error(parsed.refusal);
    const saved = parsed.value.slides ?? [];
    expect(saved).toHaveLength(7);
    // Every figure, bullet and row the model wrote is still there.
    const all = JSON.stringify(saved);
    for (const metric of ordersAtAGlance.blocks[1]?.items ?? [])
      expect(all).toContain(JSON.stringify(metric.note));
    for (const bullet of mugsBullets.items)
      expect(all).toContain(JSON.stringify(bullet));
    for (const row of decisions)
      expect(all).toContain(JSON.stringify(row.text));
  });
});

describe("what one slide holds", () => {
  const one = (block: unknown) =>
    deck({ title: "Orders by day", blocks: [block] });
  const many = <T>(count: number, make: (index: number) => T) =>
    Array.from({ length: count }, (_, index) => make(index));

  test("a slide takes up to its caps of each block, short items fitting", () => {
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
          label: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Mon"][i],
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
      const parsed = parsePageInput(one(block));
      if (!parsed.ok) throw new Error(parsed.refusal);
    }
  });

  test("one more than a slide's cap is refused at that block's items, though a page takes it", () => {
    const over = [
      {
        type: "metrics",
        items: many(SLIDE_MAX_METRICS + 1, () => ({ label: "a", value: "1" })),
      },
      {
        type: "bars",
        items: many(SLIDE_MAX_BARS + 1, (i) => ({ label: `${i}`, value: i })),
      },
      { type: "bullets", items: many(SLIDE_MAX_BULLETS + 1, () => "a") },
      { type: "list", items: many(SLIDE_MAX_LIST + 1, () => ({ text: "a" })) },
    ];
    for (const block of over) {
      expect(refusal(one(block))).toContain("slides.0.blocks.0.items: ");
      const page = parsePageInput({
        kind: "page",
        title: "A page",
        blocks: [block],
      });
      expect(page.ok).toBe(true);
    }
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
    expect(parsePageInput(one(wide)).ok).toBe(true);
    expect(
      metricColumns({ type: "metrics", items: [wide.items[1], wide.items[1]] }),
    ).toBe(2);
  });

  test("a figure too wide for even a whole-width tile is refused rather than broken mid-number", () => {
    // Cyrillic counts at its widest glyph, about an em: 15 of these run past a whole tile.
    const value = "Ж".repeat(15);
    expect(widthOf(value, 18, "bold")).toBeGreaterThan(278);
    const answer = refusal(
      one({ type: "metrics", items: [{ label: "Revenue", value }] }),
    );
    expect(answer).toContain(`slides.0.blocks.0.items.0.value: "${value}"`);
    expect(answer).toEndWith(FIX_SILENTLY);
  });

  test("a weekday chart with full day names is laid out in rows, not refused", () => {
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
    // At seven columns each is about 38px: "Mon" fits, "Wednesday" doesn't, so the bars lie in rows.
    expect(barsLayout(week)).toBe("rows");
    expect(
      barsLayout({
        ...week,
        items: week.items.map((item) => ({
          ...item,
          label: item.label.slice(0, 3),
        })),
      }),
    ).toBe("columns");
    const parsed = parsePageInput(one(week));
    if (!parsed.ok) throw new Error(parsed.refusal);
    // Rows are taller than columns, and the measure counts them as rows.
    expect(
      slideHeight({ title: "Orders by day", blocks: [week] }),
    ).toBeGreaterThan(
      slideHeight({
        title: "Orders by day",
        blocks: [
          {
            ...week,
            items: week.items.map((item) => ({
              ...item,
              label: item.label.slice(0, 3),
            })),
          },
        ],
      }),
    );
  });

  test("a long title wraps rather than being refused, up to the 80-character cap", () => {
    const parsed = parsePageInput(
      deck({ title: "x ".repeat(40).trim(), blocks: [] }),
    );
    expect(parsed.ok).toBe(true);
  });
});

describe("the fit check's measure", () => {
  test("a title alone is one line, and a slide is at most as tall as it is wide", () => {
    expect(slideHeight({ title: "Orders", blocks: [] })).toBe(22);
    expect(SLIDE_FIT_HEIGHT).toBeLessThanOrEqual(298);
  });

  test("Latin Extended, Greek and Cyrillic count at an em or more, so a word in them never reads short", () => {
    for (let code = 0x0100; code <= 0x052f; code++) {
      // Combining marks take no room of their own.
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

describe("what the model is offered, and what it reads when it is refused", () => {
  /** A JSON Schema with every object's keys in order, so two can be compared as they mean. */
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

  test("the offered schema states exactly the limits the parser enforces", () => {
    const tool = pageTools({
      save: async () => {
        throw new Error("not saved");
      },
      initiator: { kind: "person" },
    })[0];
    expect(tool?.parameters).toBe(offeredInputSchema);
    for (const io of ["input", "output"] as const) {
      const offered = z.toJSONSchema(offeredInputSchema, { io });
      const enforced = z.toJSONSchema(pageInputSchema, { io });
      expect(JSON.stringify(canonical(offered))).toContain('"maxItems":5');
      expect(canonical(offered)).toEqual(canonical(enforced));
    }
  });

  test("a call over a slide's limits passes the offered schema, so the tool's own refusal is what the model reads", async () => {
    const tooMany = deck({
      title: "What needs a decision",
      blocks: [
        {
          type: "list",
          items: Array.from({ length: 7 }, (_, i) => ({ text: `Row ${i}` })),
        },
      ],
    });
    expect(offeredInputSchema.safeParse(tooMany).success).toBe(true);
    const saved: PageInput[] = [];
    const [tool] = pageTools({
      save: async (input) => {
        saved.push(input);
        return {} as PageRecord;
      },
      initiator: { kind: "person" },
    });
    const answer = await tool?.execute(tooMany);
    expect(saved).toEqual([]);
    expect(answer).toStartWith("Refused. make_page could not save this.");
    expect(answer).toContain(
      `slides.0.blocks.0.items: A slide shows at most ${SLIDE_MAX_LIST} rows. Put the rest on a new slide.`,
    );
    expect(answer).toEndWith(FIX_SILENTLY);
    expect(FIX_SILENTLY).toContain(
      "never mention a limit, a split, what fits or a retry",
    );
    expect(FIX_SILENTLY).toContain(
      "write nothing to them until the retry is saved",
    );
    expect(FIX_SILENTLY).toContain(
      'say only how many slides it has, such as "It\'s 3 slides.", and never why',
    );
    expect(FIX_SILENTLY).toContain("a deck stays a deck");
  });

  test("the tool's description tells the model to retry silently and keep to a deck", () => {
    const [tool] = pageTools({
      save: async () => ({}) as PageRecord,
      initiator: { kind: "person" },
    });
    expect(tool?.description).toContain(
      "never tell them about a limit, a split, what fits on a slide or a retry",
    );
    expect(tool?.description).toContain(
      "use more slides rather than leave anything out",
    );
  });
});
