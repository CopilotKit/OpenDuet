import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GENERATIVE_UI_DESIGN_SKILL } from "../src/lib/copilot/generative-ui";
import { SANDBOX_THEME_ASK, SANDBOX_THEME_MESSAGE } from "../src/lib/theme";
import { cn, TYPE_SCALE_CLASSES } from "../src/lib/utils";
import {
  DARK_TOKENS,
  LIGHT_TOKENS,
  type ThemeTokens,
} from "../src/lib/theme-tokens";

/**
 * The visual system lives in tokens (parity-spec Part 2), so these tests read the stylesheet itself:
 * every token has a value in both themes, the colours that carry words clear their contrast floor,
 * and the type scale is five sizes in rem.
 */

const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

/** The `--duet-*` declarations directly inside the first block that opens with `selector {`. */
function block(selector: string): Map<string, string> {
  const start = styles.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);
  let depth = 0;
  let end = start;
  for (let at = styles.indexOf("{", start); at < styles.length; at++) {
    if (styles[at] === "{") depth++;
    if (styles[at] === "}") depth--;
    if (depth === 0) {
      end = at;
      break;
    }
  }
  const body = styles.slice(start, end);
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--duet-[\w-]+):\s*([^;]+);/g)) {
    tokens.set(match[1] as string, (match[2] as string).replace(/\s+/g, " "));
  }
  return tokens;
}

const light = block(":root");
const dark = block(".dark");

/** A token's value, following `var(--duet-x)` within the same theme. */
function resolve(theme: Map<string, string>, name: string): string {
  const fallback = theme === dark ? light : undefined;
  let value = theme.get(name) ?? fallback?.get(name);
  for (let hops = 0; value?.startsWith("var(") && hops < 5; hops++) {
    const inner = value.slice(4, -1);
    value = theme.get(inner) ?? fallback?.get(inner);
  }
  if (!value) throw new Error(`${name} has no value`);
  return value;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe("light and dark", () => {
  test("every token the light theme defines has a dark value, glass and veil included", () => {
    const aliases = [...light.entries()]
      .filter(([, value]) => value.startsWith("var(--duet-"))
      .map(([name]) => name);
    const missing = [...light.keys()].filter(
      (name) =>
        !dark.has(name) &&
        !aliases.includes(name) &&
        // Shape and motion are the same in both themes.
        !/^--duet-(radius|target|ease|dur)/.test(name),
    );
    expect(missing).toEqual([]);
    for (const name of ["--duet-glass", "--duet-veil", "--duet-shadow-glass"])
      expect(dark.has(name)).toBe(true);
  });

  test("the names screens were written against are aliases of the roles", () => {
    expect(light.get("--duet-violet")).toBe("var(--duet-accent)");
    expect(light.get("--duet-green")).toBe("var(--duet-status-done)");
    expect(light.get("--duet-amber")).toBe("var(--duet-status-needs)");
    expect(light.get("--duet-blue")).toBe("var(--duet-status-working)");
    expect(light.get("--duet-red")).toBe("var(--duet-status-problem)");
  });
});

describe("one accent and four status colours, contrast checked in both themes", () => {
  const grounds = ["--duet-surface", "--duet-card", "--duet-tile"];
  for (const [themeName, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    test(`text roles clear 4.5:1 on every ground, ${themeName}`, () => {
      for (const ink of [
        "--duet-ink",
        "--duet-ink-2",
        "--duet-ink-3",
        "--duet-accent",
        "--duet-status-done",
        "--duet-status-needs",
        "--duet-status-working",
        "--duet-status-problem",
      ])
        for (const ground of grounds)
          expect({
            ink,
            ground,
            ratio: contrast(resolve(theme, ink), resolve(theme, ground)) >= 4.5,
          }).toEqual({ ink, ground, ratio: true });
    });

    test(`each status word clears 4.5:1 on its own soft fill, ${themeName}`, () => {
      for (const status of ["done", "needs", "working", "problem"])
        expect(
          contrast(
            resolve(theme, `--duet-status-${status}`),
            resolve(theme, `--duet-status-${status}-soft`),
          ),
        ).toBeGreaterThanOrEqual(4.5);
    });

    test(`what sits on the accent clears 4.5:1, ${themeName}`, () => {
      // Dark used to draw white on the lilac at 2.4:1.
      expect(
        contrast(
          resolve(theme, "--duet-on-accent"),
          resolve(theme, "--duet-accent"),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("the type scale", () => {
  test("the root font size is the browser's, so text follows the person's setting", () => {
    const rules = styles.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/html\s*\{\s*font-size/);
    // And nothing pins the page wider than a small phone.
    expect(rules).not.toMatch(/min-width:\s*20rem/);
  });

  test("five sizes, in rem", () => {
    const sizes = new Map<string, string>();
    for (const match of styles.matchAll(
      /@utility (type-[\w-]+)\s*\{\s*font-size:\s*([^;]+);/g,
    ))
      sizes.set(match[1] as string, match[2] as string);
    expect({
      display: sizes.get("type-display"),
      nav: sizes.get("type-nav"),
      body: sizes.get("type-body"),
      sub: sizes.get("type-sub"),
      caption: sizes.get("type-caption"),
    }).toEqual({
      display: "1.5rem",
      nav: "1.125rem",
      body: "1.0625rem",
      sub: "0.9375rem",
      caption: "0.8125rem",
    });
    // The film's older names land on the same five.
    expect(new Set(sizes.values())).toEqual(
      new Set(["1.5rem", "1.125rem", "1.0625rem", "0.9375rem", "0.8125rem"]),
    );
  });
});

describe("merging classes", () => {
  test("a type size given later replaces a primitive's text size and leading", () => {
    // The bubble primitive carries `text-sm leading-relaxed`; left beside `type-body`, the
    // stylesheet picked `text-sm` and every message drew at 14px.
    for (const size of TYPE_SCALE_CLASSES)
      expect(cn("px-3 text-sm leading-relaxed", size)).toBe(`px-3 ${size}`);
    expect(cn("text-base font-medium", "type-display font-semibold")).toBe(
      "type-display font-semibold",
    );
  });

  test("a colour does not knock out a type size", () => {
    expect(cn("type-sub text-duet-ink-2", "text-duet-ink")).toBe(
      "type-sub text-duet-ink",
    );
  });

  test("every type utility in the stylesheet is known to the merge", () => {
    const declared = [...styles.matchAll(/@utility (type-[\w-]+)/g)].map(
      (match) => match[1],
    );
    expect(new Set(declared)).toEqual(new Set(TYPE_SCALE_CLASSES));
  });
});

describe("the tokens the generated-UI prompt is built from", () => {
  for (const [themeName, theme, values] of [
    ["light", light, LIGHT_TOKENS],
    ["dark", dark, DARK_TOKENS],
  ] as const) {
    test(`match the stylesheet, ${themeName}`, () => {
      for (const [name, value] of Object.entries(values) as [
        keyof ThemeTokens,
        string,
      ][])
        expect([name, resolve(theme, `--duet-${name}`)]).toEqual([name, value]);
    });
  }
});

describe("the generated-UI prompt", () => {
  test("hands the Bot OpenDuet's own tokens for both themes", () => {
    expect(GENERATIVE_UI_DESIGN_SKILL).toContain(
      `--duet-accent: ${LIGHT_TOKENS.accent};`,
    );
    expect(GENERATIVE_UI_DESIGN_SKILL).toContain(
      `--duet-accent: ${DARK_TOKENS.accent};`,
    );
    expect(GENERATIVE_UI_DESIGN_SKILL).toContain(
      `--duet-surface: ${LIGHT_TOKENS.surface};`,
    );
  });

  test("names OpenDuet's components and type, not another app's", () => {
    for (const piece of [
      "Row:",
      "Card:",
      "Status line:",
      "Primary button:",
      "Chip:",
    ])
      expect(GENERATIVE_UI_DESIGN_SKILL).toContain(piece);
    expect(GENERATIVE_UI_DESIGN_SKILL).toContain("17px/23px");
    // What it used to say, which described a different app.
    expect(GENERATIVE_UI_DESIGN_SKILL).not.toContain("Body 14px");
    expect(GENERATIVE_UI_DESIGN_SKILL).not.toContain(
      "A purple or blue accent is wrong here",
    );
    expect(GENERATIVE_UI_DESIGN_SKILL).not.toContain("0.55rem");
  });

  test("asks the app for its theme instead of trusting the phone", () => {
    expect(GENERATIVE_UI_DESIGN_SKILL).toContain(SANDBOX_THEME_ASK);
    expect(GENERATIVE_UI_DESIGN_SKILL).toContain(SANDBOX_THEME_MESSAGE);
    expect(GENERATIVE_UI_DESIGN_SKILL).toContain(':root[data-theme="dark"]');
  });
});
