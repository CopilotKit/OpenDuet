import { describe, expect, test } from "bun:test";
import {
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
import { parsePageInput } from "../src/openduet/pages";

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
    expect(answer).toEndWith(
      "Fix it and call make_page again. Don't mention this to the person.",
    );
  });

  test("the chart slide with four long bullets is refused too", () => {
    expect(refusal(deck(hearth))).toContain("slides.0: ");
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

  test("a figure too wide for its tile is refused rather than broken mid-number", () => {
    const answer = refusal(
      one({
        type: "metrics",
        items: [
          { label: "Revenue", value: "$1,234,567.89" },
          { label: "Orders", value: "1,204" },
        ],
      }),
    );
    expect(answer).toContain("slides.0.blocks.0.items.0.value: ");
    expect(answer).toContain("$1,234,567.89");
  });

  test("a bar label too wide for its bar is refused, saying to shorten it or use fewer bars", () => {
    const answer = refusal(
      one({
        type: "bars",
        items: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ].map((label, value) => ({ label, value })),
      }),
    );
    // At seven bars a column is about 37px: "Mon" fits, "Monday" doesn't.
    expect(answer).toContain(
      'slides.0.blocks.0.items.0.label: "Monday" is too wide',
    );
    expect(answer).toContain("fewer bars");
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
