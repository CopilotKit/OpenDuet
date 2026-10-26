/** A deliberately small SVG language: static shapes and text only; no CSS, links or resources. */
export const MAX_THUMBNAIL_BYTES = 4096;
const ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
]);
const ATTRIBUTES = new Set([
  "xmlns",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "fill-rule",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "transform",
  "font-size",
  "font-weight",
  "font-family",
  "text-anchor",
  "dominant-baseline",
  "dx",
  "dy",
]);
const PAINT =
  /^(?:none|currentColor|transparent|#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(?:rgb|rgba|hsl|hsla)\([\d.,%\s+-]+\)|var\(--duet-[a-z-]+\))$/;
const TEXT_ENTITIES = /&(?!(?:amp|lt|gt|quot|apos);)/;

/** Fail closed, retaining nothing from an invalid SVG. Runs before every save and at the renderer. */
export function sanitizeThumbnail(input: unknown): string | null {
  if (
    typeof input !== "string" ||
    input.length > MAX_THUMBNAIL_BYTES ||
    new TextEncoder().encode(input).length > MAX_THUMBNAIL_BYTES
  )
    return null;
  const svg = input.trim();
  if (
    !svg.startsWith("<svg") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject XML control characters at the SVG security boundary.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg)
  )
    return null;
  const stack: string[] = [];
  let position = 0;
  let root = false;
  while (position < svg.length) {
    if (svg[position] !== "<") {
      const next = svg.indexOf("<", position);
      if (next < 0) return null;
      const text = svg.slice(position, next);
      if (
        TEXT_ENTITIES.test(text) ||
        (text.trim() &&
          !["text", "tspan", "title", "desc"].includes(stack.at(-1) ?? ""))
      )
        return null;
      position = next;
      continue;
    }
    const end = svg.indexOf(">", position);
    if (end < 0) return null;
    const tag = svg.slice(position + 1, end);
    if (tag.startsWith("/")) {
      if (!/^\/[A-Za-z]+$/.test(tag) || stack.pop() !== tag.slice(1))
        return null;
    } else {
      const match = /^([A-Za-z]+)([\s\S]*?)(\/?)$/.exec(tag);
      if (!match) return null;
      const name = match[1] ?? "";
      if (
        !ELEMENTS.has(name) ||
        (name === "svg" && root) ||
        (!root && name !== "svg")
      )
        return null;
      if (!stack.length && root) return null;
      root = true;
      let attrs = match[2] ?? "";
      const seen = new Set<string>();
      while (attrs.length) {
        if (/^\s*$/.test(attrs)) break;
        const attr =
          /^\s+([A-Za-z][A-Za-z0-9:-]*)\s*=\s*(["'])([^<>]*?)\2/.exec(attrs);
        if (!attr) return null;
        const key = attr[1] ?? "";
        const value = attr[3] ?? "";
        if (!ATTRIBUTES.has(key) || seen.has(key) || /[&\\]/.test(value))
          return null;
        if (
          key === "xmlns"
            ? value !== "http://www.w3.org/2000/svg"
            : /(?:url\s*\(|https?:|data:|javascript:|@)/i.test(value)
        )
          return null;
        if ((key === "fill" || key === "stroke") && !PAINT.test(value))
          return null;
        seen.add(key);
        attrs = attrs.slice(attr[0].length);
      }
      if (!match[3]) stack.push(name);
    }
    position = end + 1;
  }
  return root && stack.length === 0 ? svg : null;
}

export const THUMBNAIL_GUIDANCE =
  'Also write thumbnail: a self-contained SVG no more than 4096 UTF-8 bytes that makes THIS card recognisable from its actual content (its key number, people, dates, chart shape or topic motif), never a generic icon. Use static svg/g/path/rect/circle/ellipse/line/polyline/polygon/text/tspan shapes, no scripts, style, links, images, URLs or external resources. Use viewBox="0 0 320 180" and fill/stroke="var(--duet-ink)" or other --duet-* tokens so it works in both themes. Light/dark colour values: --duet-ink #18181b/#f4f4f5; --duet-surface #f6f6f8/#111113; --duet-ink-3 #6b6b75/#8e8e98; --duet-tile #f1f1f4/#26262b. The one accent, light/dark: --duet-violet #6430ab/#b49ae8. Use token references so the colours adapt. Keep it neutral: no background fill or tinted panel (the card supplies the surface), ink and --duet-ink-3 greys for everything, and --duet-violet only on the one thing it marks, such as the highlighted bar. Draw the key content in the thumbnail and keep text short.';
