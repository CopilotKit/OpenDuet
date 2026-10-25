/**
 * The unit a person sees as one character.
 *
 * `Array.from` splits on code points, which is right for a plain emoji and wrong for every emoji
 * built out of more than one. A flag is two regional indicators, a family is three people joined by
 * zero-width joiners, a thumbs-up with a skin tone is the thumb plus a modifier, and a keycap is a
 * digit plus a variation selector plus an enclosing mark. Cut between any of those parts and what is
 * left is not a shorter emoji: it is a boxed letter, a dangling joiner, or a bare digit.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The first `limit` UTF-16 code units of `text`, one fewer when the cut would split a character.
 *
 * `slice` counts code units, and every emoji, every astral-plane glyph and every CJK extension
 * character is two of them. A limit landing between the two halves leaves a lone high surrogate as
 * the last unit, which is not a character: `JSON.stringify` sends it as a bare `\ud83d` and UTF-8
 * encodes it as U+FFFD, so whatever reads the cut text — a model, most often — is handed a broken
 * character that was never in the source. `extractDocumentText` guards the same cut on attachments.
 *
 * The orphan is dropped rather than completed, so the result never exceeds the limit it was asked
 * for. It cannot be a lone surrogate that was already in the text and happened to land last: only a
 * high surrogate is dropped, and one followed by its pair in the source is exactly the split case.
 */
export function cutAtCodeUnits(text: string, limit: number): string {
  const sliced = text.slice(0, limit);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * One line a roster can draw: control characters stripped, whitespace collapsed, cut on grapheme
 * clusters so an emoji is never split. The caller supplies the cap; a preview and a title want
 * different ones. An optional JSON byte cap also bounds a cluster made of arbitrarily many
 * combining marks, and includes the quotes and escaping that a notification will serialize.
 */
export function oneLine(
  text: string,
  maxGraphemes: number,
  maxJsonBytes = Number.POSITIVE_INFINITY,
): string {
  if (maxJsonBytes < 5)
    throw new RangeError("A JSON line needs room for an ellipsis.");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  const flattened = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  const collapsed = flattened.replace(/\s+/g, " ");
  // A string can never hold more graphemes than it holds UTF-16 units, so a line this short is
  // already under the cap and needs no segmenting. Nearly everything a roster draws is that short,
  // and segmenting is the expensive part of this function.
  const fitsBytes =
    maxJsonBytes === Number.POSITIVE_INFINITY ||
    Buffer.byteLength(JSON.stringify(collapsed), "utf8") <= maxJsonBytes;
  if (collapsed.length <= maxGraphemes && fitsBytes) return collapsed;
  const graphemes = Array.from(
    GRAPHEMES.segment(collapsed),
    (each) => each.segment,
  );
  if (graphemes.length <= maxGraphemes && fitsBytes) return collapsed;
  let kept = "";
  // The two JSON quotes and the UTF-8 ellipsis are part of the cap.
  let bytes = 5;
  for (const grapheme of graphemes.slice(0, maxGraphemes - 1)) {
    const next = Buffer.byteLength(JSON.stringify(grapheme), "utf8") - 2;
    if (bytes + next > maxJsonBytes) break;
    kept += grapheme;
    bytes += next;
  }
  return `${kept}…`;
}
