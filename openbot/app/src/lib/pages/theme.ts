import type { PageTheme } from "@openbot/shared/page-look";
import type { CSSProperties } from "react";

const ACCENT: Record<PageTheme, string> = {
  classic: "var(--duet-ink)",
  studio: "var(--duet-violet)",
  earth: "var(--duet-green)",
  ocean: "var(--duet-blue)",
  editorial: "var(--duet-amber)",
};
/**
 * A saved page's theme: its accent, for what a page marks (a timeline's dots, a decision's pick),
 * and the editorial face. Never a background: an opened page sits on the app's own neutral surface,
 * the same as its card, so a theme cannot tint it green or lavender.
 */
export function pageThemeStyle(theme: PageTheme = "classic"): CSSProperties {
  return {
    "--page-accent": ACCENT[theme],
    fontFamily: theme === "editorial" ? "Georgia, serif" : undefined,
  } as CSSProperties;
}
