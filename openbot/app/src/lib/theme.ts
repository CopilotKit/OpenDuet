/**
 * Light, dark, or whatever the phone is set to (parity-spec 2.1). The default is the phone's setting,
 * and it follows the phone live, so a phone that turns dark at sunset turns the app dark with it.
 *
 * `index.html` repeats `parseThemePreference` and `resolveTheme` inline, before the first paint, so the app never flashes
 * the wrong theme while the bundle loads. The two read the same keys; a test holds them together.
 */

/** Where the person's choice is kept: "system", "light" or "dark". */
export const THEME_STORAGE_KEY = "openduet-theme";

/**
 * Where OpenBot kept its switch, as "dark" or "light". It wrote "light" on every load whether or not
 * anybody chose it, so only "dark" there means somebody asked for it; "light" there is the old
 * default and now means "follow the phone".
 */
export const LEGACY_THEME_STORAGE_KEY = "openbot-theme";

/** The media query the phone's setting arrives on. */
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "system",
  "light",
  "dark",
];

/**
 * The person's choice, from what is stored under the two keys. Anything not a choice, including
 * nothing at all, is "system".
 */
export function parseThemePreference(
  stored: string | null,
  legacy: string | null = null,
): ThemePreference {
  if (stored === "system" || stored === "light" || stored === "dark")
    return stored;
  return legacy === "dark" ? "dark" : "system";
}

/** The theme to draw: the choice, or the phone's when the choice is to follow it. */
export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

type ThemeEffects = {
  toggleRootClass: (name: string, force: boolean) => void;
  setRootColorScheme: (scheme: ResolvedTheme) => void;
};

/**
 * Draw a theme: the `dark` class the tokens hang off, and the colour scheme the browser draws its
 * own controls and scrollbars in. `index.html` sets the scheme inline before paint, and an inline
 * style outranks the stylesheet, so this has to set it too.
 */
export function applyTheme(theme: ResolvedTheme, effects: ThemeEffects) {
  effects.toggleRootClass("dark", theme === "dark");
  effects.setRootColorScheme(theme);
}

/**
 * The messages a generated interface's sandboxed frame uses to follow the app's theme. It cannot see
 * the app's `dark` class, and `prefers-color-scheme` inside it follows the phone, not the person's
 * choice, so it asks with `SANDBOX_THEME_ASK` and the app answers with `SANDBOX_THEME_MESSAGE`, and
 * sends that again to every frame whenever the theme changes. The prompt that tells a Bot how to
 * draw (`lib/copilot/generative-ui.ts`) gives it the script that does the asking.
 */
export const SANDBOX_THEME_ASK = "openduet:theme?";
export const SANDBOX_THEME_MESSAGE = "openduet:theme";

/** The message that tells a frame which theme to draw. */
export function sandboxThemeMessage(theme: ResolvedTheme) {
  return { type: SANDBOX_THEME_MESSAGE, theme } as const;
}

/** Whether a message is a frame asking which theme to draw. */
export function isSandboxThemeAsk(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === SANDBOX_THEME_ASK
  );
}
