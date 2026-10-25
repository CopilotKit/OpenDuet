import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { PageBlocks, SlideCard } from "@/components/duet/page-view";
import { blockHeight } from "../../shared/slide-fit";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const table = {
  type: "table" as const,
  columns: ["Item", "Expected yearly subscription cash revenue"],
  rows: Array.from({ length: 3 }, () => ["November total", "November total"]),
};

test("slide tables keep the equal column widths used to measure wrapping", () => {
  const view = render(<SlideCard slide={{ title: "Plan", blocks: [table] }} />);
  const element = view.getByRole("table");
  // Auto layout made this accepted 216px slide 248px tall by narrowing its first column.
  expect(element.style.tableLayout).toBe("fixed");
  expect(element.style.width).toBe("230px");
  expect(blockHeight(table)).toBe(182);

  for (const count of [1, 3, 8]) {
    view.rerender(
      <SlideCard
        slide={{
          title: "Plan",
          blocks: [
            {
              type: "table",
              columns: Array.from(
                { length: count },
                (_, index) => `Column ${index}`,
              ),
              rows: [Array.from({ length: count }, () => "November total")],
            },
          ],
        }}
      />,
    );
    expect(element.style.tableLayout).toBe("fixed");
    expect(element.style.width).toBe(`${count === 1 ? 230 : count * 100}px`);
    expect(element.parentElement?.className).toContain("overflow-x-auto");
    expect(view.getAllByRole("columnheader")[0]?.className).toContain(
      "sticky left-0",
    );
    expect(view.getByRole("rowheader").className).toContain("sticky left-0");
  }
});

test("table measurement accounts for the wrapper borders before wrapping text", () => {
  expect(
    blockHeight({
      type: "table",
      columns: ["Item"],
      // 215.77px at the conservative semibold measure: fits 216px, but not the actual 214px.
      rows: [["WWWWWWWWWWWWWWWWi"]],
    }),
  ).toBe(84);
});

test("wide slide table cells keep the estimator's equal column allocation", () => {
  const view = render(
    <SlideCard
      slide={{
        title: "Plan",
        blocks: [
          {
            type: "table",
            columns: ["Item", "Expected yearly subscription cash revenue"],
            rows: [["September subscription renewals", "November total"]],
          },
        ],
      }}
    />,
  );
  const element = view.getByRole("table");
  expect(element.style.tableLayout).toBe("fixed");
  expect(element.style.width).toBe("230px");
  expect(view.getByRole("rowheader").textContent).toBe(
    "September subscription renewals",
  );
});

test("page tables retain content-based widths, horizontal scrolling and sticky row labels", () => {
  const view = render(<PageBlocks blocks={[table]} />);
  const element = view.getByRole("table");
  expect(element.style.tableLayout).toBe("");
  expect(element.style.width).toBe("");
  expect(element.className).toContain("w-full");
  expect(element.parentElement?.className).toContain("overflow-x-auto");
  expect(view.getAllByRole("columnheader")[0]?.className).toContain(
    "sticky left-0",
  );
  for (const cell of view.getAllByRole("rowheader")) {
    expect(cell.className).toContain("sticky left-0");
    expect(cell.className).toContain("min-w-[100px]");
  }
});
