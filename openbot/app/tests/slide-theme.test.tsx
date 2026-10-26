import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PAGE_THEMES } from "@openbot/shared/page-look";
import { cleanup, render } from "@testing-library/react";
import { PageBlocks, SlideCard } from "@/components/duet/page-view";
import { pageThemeStyle } from "@/lib/pages/theme";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test.each([...PAGE_THEMES])(
  "%s slides keep the measured font while surrounding page text keeps its theme",
  (theme) => {
    const view = render(
      <div
        style={{ fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}
      >
        <div style={pageThemeStyle(theme)}>
          <h2>Page title</h2>
          <PageBlocks blocks={[{ type: "text", text: "Page body" }]} />
          <SlideCard
            slide={{
              title: "Slide title",
              blocks: [
                { type: "text", text: "Slide body" },
                {
                  type: "metrics",
                  // Fits one line in the measured font, but wraps in Georgia.
                  items: [{ label: "Wide figure", value: "WWWWWWWWWWW" }],
                },
                { type: "table", columns: ["Column"], rows: [["Cell"]] },
              ],
            }}
          />
        </div>
      </div>,
    );
    for (const text of [
      "Slide title",
      "Slide body",
      "WWWWWWWWWWW",
      "Wide figure",
      "Column",
      "Cell",
    ]) {
      const font = getComputedStyle(view.getByText(text)).fontFamily;
      expect(font).toBe("Inter, ui-sans-serif, system-ui, sans-serif");
    }
    for (const text of ["Page title", "Page body"])
      expect(getComputedStyle(view.getByText(text)).fontFamily).toBe(
        theme === "editorial"
          ? "Georgia, serif"
          : "Inter, ui-sans-serif, system-ui, sans-serif",
      );
  },
);

test.each(["WWWWWWWWWWW", "September total"])(
  "editorial figure %s uses the slide's measured font",
  (value) => {
    const view = render(
      <div style={{ ...pageThemeStyle("editorial"), width: 264 }}>
        <SlideCard
          slide={{
            title: "Quarterly plan",
            blocks: [
              {
                type: "metrics",
                items: [{ label: "Projected result", value }],
              },
            ],
          }}
        />
      </div>,
    );
    expect(getComputedStyle(view.getByText(value)).fontFamily).toBe(
      "Inter, ui-sans-serif, system-ui, sans-serif",
    );
    expect(
      getComputedStyle(view.getByText("Projected result")).fontFamily,
    ).toBe("Inter, ui-sans-serif, system-ui, sans-serif");
  },
);

test.each([...PAGE_THEMES])(
  "a %s page sits on the app's neutral surface, with no tint of its own",
  (theme) => {
    expect(pageThemeStyle(theme).background).toBeUndefined();
    expect(pageThemeStyle(theme).backgroundColor).toBeUndefined();
  },
);
