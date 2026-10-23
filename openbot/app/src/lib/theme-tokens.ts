/**
 * OpenDuet's colour tokens as data, for what cannot read the stylesheet: the interface a Bot writes
 * runs in a sandboxed frame with no access to `styles.css`, so the prompt that tells it how to look
 * (`lib/copilot/generative-ui.ts`) is built from these.
 *
 * The values are the stylesheet's own. `tests/visual-system.test.ts` reads `src/styles.css` and
 * fails when any value here differs from the `--duet-<name>` it stands for, so the two cannot drift.
 */
export type ThemeTokens = {
  surface: string;
  card: string;
  bubble: string;
  tile: string;
  ink: string;
  "ink-2": string;
  "ink-3": string;
  hair: string;
  accent: string;
  "accent-soft": string;
  "on-accent": string;
  "status-done": string;
  "status-needs": string;
  "status-working": string;
  "status-problem": string;
  black: string;
  "on-black": string;
};

export const LIGHT_TOKENS: ThemeTokens = {
  surface: "#f6f6f8",
  card: "#ffffff",
  bubble: "#ececf0",
  tile: "#f1f1f4",
  ink: "#18181b",
  "ink-2": "#55555e",
  "ink-3": "#6b6b75",
  hair: "rgb(24 24 27 / 9%)",
  accent: "#6430ab",
  "accent-soft": "#f0ebfa",
  "on-accent": "#ffffff",
  "status-done": "#147a3a",
  "status-needs": "#a34a06",
  "status-working": "#1d4ed8",
  "status-problem": "#b91c1c",
  black: "#111114",
  "on-black": "#ffffff",
};

export const DARK_TOKENS: ThemeTokens = {
  surface: "#111113",
  card: "#1c1c1f",
  bubble: "#26262b",
  tile: "#26262b",
  ink: "#f4f4f5",
  "ink-2": "#a1a1aa",
  "ink-3": "#8e8e98",
  hair: "rgb(255 255 255 / 10%)",
  accent: "#b49ae8",
  "accent-soft": "#2a2140",
  "on-accent": "#1a1033",
  "status-done": "#4ade80",
  "status-needs": "#fbbf24",
  "status-working": "#7aa2ff",
  "status-problem": "#f87171",
  black: "#f4f4f5",
  "on-black": "#111114",
};

/** The type scale in px (parity-spec 2.3), the sizes the app's `type-*` utilities draw at 16px. */
export const TYPE_SCALE = {
  display: { size: 24, line: 28, weight: 600 },
  nav: { size: 18, line: 22, weight: 500 },
  body: { size: 17, line: 23, weight: 400 },
  sub: { size: 15, line: 20, weight: 400 },
  caption: { size: 13, line: 16, weight: 400 },
} as const;

/** The radii (parity-spec 2.4), in px. Pills, chips and buttons are fully round. */
export const RADII = { bubble: 20, card: 20, field: 22, tile: 10 } as const;

/** The declarations for one theme, as `--duet-<name>: <value>;` lines. */
export function tokenDeclarations(tokens: ThemeTokens): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--duet-${name}: ${value};`)
    .join(" ");
}
