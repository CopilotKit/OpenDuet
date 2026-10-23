import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  applyTheme,
  LEGACY_THEME_STORAGE_KEY,
  parseThemePreference,
  resolveTheme,
  SYSTEM_DARK_QUERY,
  THEME_STORAGE_KEY,
} from "../src/lib/theme";

/**
 * The app follows the phone unless the person chose otherwise (parity-spec 2.1): "Match phone",
 * "Light" or "Dark", with "Match phone" the default, decided before the first paint.
 */
describe("theme preference", () => {
  test("nothing stored follows the phone", () => {
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("nonsense")).toBe("system");
  });

  test("a stored choice is kept", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
  });

  test("OpenBot's old switch counts only when it was turned on", () => {
    // It wrote "light" on every load whether or not anybody chose it.
    expect(parseThemePreference(null, "light")).toBe("system");
    expect(parseThemePreference(null, "dark")).toBe("dark");
    // A choice made since wins over it.
    expect(parseThemePreference("light", "dark")).toBe("light");
  });

  test("following the phone draws what the phone is set to", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("drawing a theme sets the class and the colour scheme", () => {
    const toggles: Array<[string, boolean]> = [];
    const schemes: string[] = [];
    applyTheme("dark", {
      toggleRootClass: (name, force) => toggles.push([name, force]),
      setRootColorScheme: (scheme) => schemes.push(scheme),
    });
    applyTheme("light", {
      toggleRootClass: (name, force) => toggles.push([name, force]),
      setRootColorScheme: (scheme) => schemes.push(scheme),
    });
    expect(toggles).toEqual([
      ["dark", true],
      ["dark", false],
    ]);
    expect(schemes).toEqual(["dark", "light"]);
  });
});

describe("pre-paint theme boot", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const boot = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);

  test("the boot script runs before the first paint", () => {
    expect(boot).not.toBeNull();
    expect(boot?.[0]).not.toContain("module");
    expect(boot?.[0]).not.toContain("defer");
  });

  /** Runs the inline script against a stand-in document, storage and phone setting. */
  function bootWith(
    stored: Record<string, string>,
    phoneDark: boolean,
    storageThrows = false,
  ) {
    const classes = new Set<string>();
    const style: { colorScheme?: string } = {};
    const queries: string[] = [];
    runInNewContext(boot?.[1] ?? "", {
      window: {
        localStorage: {
          getItem: (key: string) => {
            if (storageThrows) throw new Error("denied");
            return stored[key] ?? null;
          },
        },
        matchMedia: (query: string) => {
          queries.push(query);
          return { matches: phoneDark };
        },
      },
      document: {
        documentElement: {
          classList: {
            toggle: (name: string, force: boolean) =>
              force ? classes.add(name) : classes.delete(name),
          },
          style,
        },
      },
    });
    return { dark: classes.has("dark"), scheme: style.colorScheme, queries };
  }

  test("with nothing chosen it follows the phone", () => {
    expect(bootWith({}, true)).toMatchObject({ dark: true, scheme: "dark" });
    expect(bootWith({}, false)).toMatchObject({ dark: false, scheme: "light" });
    expect(bootWith({}, true).queries).toEqual([SYSTEM_DARK_QUERY]);
  });

  test("it reads the keys the app writes, and a choice beats the phone", () => {
    expect(bootWith({ [THEME_STORAGE_KEY]: "light" }, true).dark).toBe(false);
    expect(bootWith({ [THEME_STORAGE_KEY]: "dark" }, false).dark).toBe(true);
    expect(bootWith({ [THEME_STORAGE_KEY]: "system" }, true).dark).toBe(true);
    expect(bootWith({ [LEGACY_THEME_STORAGE_KEY]: "dark" }, false).dark).toBe(
      true,
    );
    expect(bootWith({ [LEGACY_THEME_STORAGE_KEY]: "light" }, true).dark).toBe(
      true,
    );
  });

  test("storage that throws still follows the phone", () => {
    expect(bootWith({}, true, true)).toMatchObject({ dark: true });
  });
});

describe("color scheme", () => {
  const styles = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );

  test("both themes tell the browser which one they are", () => {
    expect(styles).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light/);
    expect(styles).toMatch(/\.dark\s*\{[\s\S]*?color-scheme:\s*dark/);
  });
});
