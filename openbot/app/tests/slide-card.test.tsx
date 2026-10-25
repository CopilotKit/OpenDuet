import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { SlideCard } from "@/components/duet/page-view";
import type { PageSlide } from "@/lib/pages/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * One slide of a deck, as the viewer draws it. Whatever the tool saved, the slide shows: every
 * figure with its label and note, every bullet and every row, in full. The slides are the ones the
 * parity review's deck saved on 2026-10-22, which the viewer cut to 3 of 4 figures, 2 of 4 bullets
 * and 3 of 7 rows.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const metrics = [
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
];
const ordersAtAGlance: PageSlide = {
  title: "Orders at a glance",
  blocks: [
    {
      type: "text",
      text: "Only the Hearth & Co order is a big one, and it's at risk. The store is paused too.",
    },
    { type: "metrics", items: metrics },
    {
      type: "text",
      text: "Source: Gmail, read today. Order totals and revenue aren't in your inbox, so none are shown.",
    },
  ],
};

const bullets = [
  "The extra 80 mugs is a 67% jump on the same date.",
  "The kiln is out of service until Monday (Dev Patel, Kilnworks).",
  "I can't see how many mugs are already fired, so check before you promise anything.",
  "Ana needs an answer today. She says she'll confirm the 200 today if you can do it.",
];
const hearth: PageSlide = {
  title: "Hearth & Co: 120 now, 200 asked",
  blocks: [
    {
      type: "bars",
      label: "Mugs for the Friday ship date",
      items: [
        { label: "Current order", value: 120 },
        { label: "Ana's ask", value: 200 },
      ],
    },
    { type: "bullets", items: bullets },
  ],
};

const rows = [
  {
    text: "Hearth: confirm Friday for 120, and say yes or no to 200",
    note: "Ana needs to tell her stores by end of day",
  },
  { text: "Boxes: double-wall or regular", note: "Sam is blocked on packing" },
  {
    text: "Glaze: accept the Oat Satin substitute",
    note: "Rosa Lind needs a reply by end of day; Speckled White is two weeks late",
  },
  {
    text: "Order #1038: refund or replace two bowls",
    note: "Jordan Lee sent photos",
  },
  {
    text: "Shopify: update billing to reopen checkout",
    note: "Store paused for an expired payment method",
  },
  {
    text: "Clayworks invoice #5521: $640 card declined",
    note: "Update payment within 48 hours to keep the supply account",
  },
  {
    text: "Golden Hour Home: send samples by Tuesday",
    note: "Leah Gold, referred by Ana",
  },
];
const whatNeedsADecision: PageSlide = {
  title: "What needs a decision",
  blocks: [{ type: "list", title: "Order-related items", items: rows }],
};

/** Every class in the slide, so a test can say nothing in it is cut off. */
function classesIn(element: Element): string[] {
  return [element, ...element.querySelectorAll("*")].flatMap((node) =>
    (node.getAttribute("class") ?? "").split(/\s+/).filter(Boolean),
  );
}
const CLIPPING = /^(truncate|line-clamp-\d+|overflow-hidden|text-ellipsis)$/;

test("a slide of figures shows every figure with its label and note, and both lines of text", () => {
  const view = render(<SlideCard slide={ordersAtAGlance} />);
  for (const metric of metrics) {
    expect(view.getByText(metric.value)).toBeTruthy();
    expect(view.getByText(metric.label)).toBeTruthy();
    expect(view.getByText(metric.note)).toBeTruthy();
  }
  for (const block of ordersAtAGlance.blocks)
    if (block.type === "text") expect(view.getByText(block.text)).toBeTruthy();
});

test("a chart slide shows its chart and every bullet beside it", () => {
  const view = render(<SlideCard slide={hearth} />);
  expect(view.getByText("Mugs for the Friday ship date")).toBeTruthy();
  expect(view.getByText("Current order")).toBeTruthy();
  expect(view.getByText("Ana's ask")).toBeTruthy();
  expect(view.getByText("120")).toBeTruthy();
  expect(view.getByText("200")).toBeTruthy();
  for (const bullet of bullets) expect(view.getByText(bullet)).toBeTruthy();
});

test("a slide of rows shows every row with its note, and each row is a button to ask about it", () => {
  const asked: string[] = [];
  const view = render(
    <SlideCard
      onListItem={(text) => asked.push(text)}
      slide={whatNeedsADecision}
    />,
  );
  const list = view.getByRole("list", { name: "Order-related items" });
  const buttons = within(list).getAllByRole("button");
  expect(buttons).toHaveLength(rows.length);
  for (const row of rows) {
    expect(view.getByText(row.text)).toBeTruthy();
    expect(view.getByText(row.note)).toBeTruthy();
  }
  const last = buttons.at(-1);
  if (!last) throw new Error("no rows");
  fireEvent.click(last);
  expect(asked).toEqual(["Golden Hour Home: send samples by Tuesday"]);
});

test("nothing on a slide is cut off: no clamp, ellipsis or hidden overflow anywhere in it", () => {
  for (const slide of [ordersAtAGlance, hearth, whatNeedsADecision]) {
    const view = render(<SlideCard onListItem={() => {}} slide={slide} />);
    const clipped = classesIn(view.container).filter((name) =>
      CLIPPING.test(name),
    );
    expect(clipped).toEqual([]);
    cleanup();
  }
});

test("a weekday chart with full day names lies in rows, every label and figure whole", () => {
  const days = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const view = render(
    <SlideCard
      slide={{
        title: "Emails by day",
        blocks: [
          {
            type: "bars",
            items: days.map((label, index) => ({
              label,
              value: 1_200 + index,
            })),
          },
        ],
      }}
    />,
  );
  const chart = view.getByRole("img");
  expect(chart.getAttribute("data-layout")).toBe("rows");
  for (const day of days) expect(view.getByText(day)).toBeTruthy();
  expect(view.getAllByText("1.2K")).toHaveLength(days.length);
  // Three short labels fit the 264px slide's columns; seven abbreviations do not.
  cleanup();
  const short = render(
    <SlideCard
      slide={{
        title: "Emails, Monday to Wednesday",
        blocks: [
          {
            type: "bars",
            items: days.slice(0, 3).map((label, index) => ({
              label: label.slice(0, 3),
              value: 10 + index,
            })),
          },
        ],
      }}
    />,
  );
  expect(short.getByRole("img").getAttribute("data-layout")).toBe("columns");
  for (const day of ["Mon", "Tue", "Wed"])
    expect(short.getByText(day)).toBeTruthy();
});

test("figures too wide for half a slide take a whole-width tile each", () => {
  const view = render(
    <SlideCard
      slide={{
        title: "Cash",
        blocks: [
          {
            type: "metrics",
            items: [
              { label: "Revenue", value: "$1,234,567.89" },
              { label: "Orders", value: "1,204" },
            ],
          },
        ],
      }}
    />,
  );
  const tiles = view.getByText("$1,234,567.89").closest("ul");
  expect(tiles?.className).toContain("grid-cols-1");
});

test("a row keeps a 44px target, and a chart's long label word gets a column wide enough for it", () => {
  const view = render(
    <SlideCard
      onListItem={() => {}}
      slide={{
        title: "Senders",
        blocks: [
          { type: "list", items: [{ text: "Ana" }] },
          {
            type: "bars",
            // Seven bars lie in rows: a seventh of a slide is too narrow for the address.
            items: [
              { label: "noreply@shopify.com", value: 12 },
              ...["Ana", "Sam", "Leo", "Rosa", "Dev", "Maya"].map(
                (label, value) => ({
                  label,
                  value,
                }),
              ),
            ],
          },
        ],
      }}
    />,
  );
  // Unmeasured, the slide is at scale 1, so 44px laid out is 44px on screen.
  expect(view.getByRole("button", { name: "Ana" }).style.minHeight).toBe(
    "44px",
  );
  const label = view.getByText("noreply@shopify.com");
  expect(Number.parseFloat(label.style.maxWidth)).toBeGreaterThan(128);
});
