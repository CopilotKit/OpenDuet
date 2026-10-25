import type { PageTheme } from "@openbot/shared/page-look";
import type { CSSProperties } from "react";

const ACCENT: Record<PageTheme, string> = {
  classic: "var(--duet-ink)",
  studio: "var(--duet-violet)",
  earth: "var(--duet-green)",
  ocean: "var(--duet-blue)",
  editorial: "var(--duet-amber)",
};
export function pageThemeStyle(theme: PageTheme = "classic"): CSSProperties {
  const accent = ACCENT[theme];
  return {
    "--page-accent": accent,
    background: `color-mix(in srgb, ${accent} 5%, var(--duet-surface))`,
    fontFamily: theme === "editorial" ? "Georgia, serif" : undefined,
  } as CSSProperties;
}
