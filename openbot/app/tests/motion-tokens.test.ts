import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DURATION, EASE_IN, EASE_OUT } from "../src/lib/motion";

/**
 * Motion is written two ways: classes read `--duet-dur-*` and `--duet-ease-*` from the stylesheet,
 * and motion's JavaScript reads `lib/motion.ts`, which cannot read a custom property. These hold the
 * two to one set of numbers, and hold the components to the set.
 */

const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

/** A token's value, as `:root` declares it. */
function token(name: string): string {
  const found = new RegExp(`${name}:\\s*([^;]+);`).exec(styles);
  if (!found?.[1]) throw new Error(`no ${name} in styles.css`);
  return found[1].trim();
}

const bezier = (curve: readonly number[]) =>
  `cubic-bezier(${curve.join(", ")})`;

test("the four durations in lib/motion.ts are the stylesheet's", () => {
  expect(token("--duet-dur-tap")).toBe(`${DURATION.tap * 1000}ms`);
  expect(token("--duet-dur-swap")).toBe(`${DURATION.swap * 1000}ms`);
  expect(token("--duet-dur-enter")).toBe(`${DURATION.enter * 1000}ms`);
  expect(token("--duet-dur-sheet")).toBe(`${DURATION.sheet * 1000}ms`);
});

test("the two curves in lib/motion.ts are the stylesheet's", () => {
  expect(token("--duet-ease-out")).toBe(bezier(EASE_OUT));
  expect(token("--duet-ease-in")).toBe(bezier(EASE_IN));
});

test("a bare transition utility takes the tap duration and the strong ease-out", () => {
  expect(token("--default-transition-duration")).toBe("var(--duet-dur-tap)");
  expect(token("--default-transition-timing-function")).toBe(
    "var(--duet-ease-out)",
  );
});

/** Every source file under src, by path. */
function sources(): string[] {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  return [
    ...glob.scanSync({
      cwd: new URL("../src", import.meta.url).pathname,
    }),
  ].filter((path) => !path.includes("generated/") && !path.endsWith(".gen.ts"));
}

test("nothing animates `all`, which takes layout along with it", () => {
  const offenders = sources().filter((path) => {
    const text = readFileSync(
      new URL(`../src/${path}`, import.meta.url),
      "utf8",
    );
    return /\btransition-all\b|transition:\s*all\b/.test(text);
  });
  expect(offenders).toEqual([]);
});
