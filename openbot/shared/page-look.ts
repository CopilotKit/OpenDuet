/** The six kinds shown by Make, including the legacy `page` value for Web page. */
export const PAGE_KINDS = [
  "page",
  "slides",
  "dashboard",
  "doc",
  "design",
  "design-system",
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];
export const PAGE_THEMES = [
  "classic",
  "studio",
  "earth",
  "ocean",
  "editorial",
] as const;
export type PageTheme = (typeof PAGE_THEMES)[number];
export const PAGE_KIND_LABELS: Record<PageKind, string> = {
  page: "Web page",
  slides: "Slides",
  dashboard: "Dashboard",
  doc: "Docs",
  design: "Design",
  "design-system": "Design System",
};
export const PAGE_KIND_COLOURS: Record<PageKind, string> = {
  page: "var(--duet-red)",
  slides: "var(--duet-amber)",
  dashboard: "var(--duet-violet)",
  doc: "var(--duet-blue)",
  design: "var(--duet-violet)",
  "design-system": "var(--duet-green)",
};
