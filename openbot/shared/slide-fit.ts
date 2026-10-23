/**
 * How a slide of a deck is laid out and how tall it stands, declared once and read from both sides.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES. The server refuses, at save, a slide that would not show in
 * full (`slideFitIssues` in server/src/openduet/page-content.ts), and the app draws the slide
 * (`SlideCard` in app/src/components/duet/page-view.tsx). Both have to agree on more than the type
 * sizes: on whether a chart's bars stand in columns or lie in rows, and on how many tiles a row of
 * figures holds. Two copies of that rule would be a contract with two authors.
 *
 * ONE DESIGN WIDTH. A slide is laid out at 330px wide, whatever the phone, and the app scales the
 * whole card to the width it is given (about 0.85x at 320, 1x at 390, 1.13x at 430). So a slide
 * wraps its words in the same places at every width, and a measure taken here at 330 holds wherever
 * it is drawn. A slide that reflowed instead would wrap differently at 320 than the check measured,
 * and break a figure the check had passed.
 *
 * THE MEASURE. Words are laid out line by line from each character's advance in Inter and in the
 * system font (San Francisco), whichever is wider, measured in Chrome. So the measure reads a little
 * long, never short. Outside ASCII and Latin-1 each block of Unicode is counted at its widest glyph.
 */

/** A slide's width as it is laid out, before the app scales it to the phone. */
export const SLIDE_WIDTH = 330;
/** The card's padding, each side. */
export const SLIDE_PADDING = 16;
/** The width a slide's words have: 330 less the padding. */
export const SLIDE_CONTENT_WIDTH = SLIDE_WIDTH - 2 * SLIDE_PADDING;
/**
 * The most a slide's content may stand: as tall as it is wide, so the card is a square at most.
 *
 * A square is the tallest a slide gets and still sits whole on a 390x664 screen (a phone browser
 * with its bars showing) with the sheet's header and the deck's arrows. What fits a square at these
 * sizes also fits a 16:9 slide held sideways, which is wider and barely shorter.
 */
export const SLIDE_FIT_HEIGHT = SLIDE_CONTENT_WIDTH;

/** Space between a slide's title and its first block, and between blocks. */
export const SLIDE_BLOCK_GAP = 12;

/*
 * The type, as [size, line height] in px at the design width. The app draws these sizes; change one
 * there and it no longer agrees with the measure here.
 */
const TITLE = [18, 22] as const;
const BODY = [15, 20] as const;
const FIGURE = [18, 22] as const;
const CAPTION = [13, 16] as const;

/** Between two tiles of figures, across and down. Each tile has 10px of padding across and 8px down. */
const TILE_GAP = 8;
/** Between two bars standing in columns. */
const BAR_GAP = 6;
/** The height every bar in columns shares, so the bars compare. */
export const BAR_PLOT = 72;
/** In rows, the widest a label may be before it wraps, and the space a figure takes at the end. */
export const ROW_LABEL_WIDTH = 128;
/** Between two bars lying in rows. */
const ROW_GAP = 6;
/** A list row's least height: a 44px tap target at the design width. */
const LIST_ROW = 44;

/*
 * Each printable ASCII character's advance, in thousandths of an em, from " " (32) to "~" (126):
 * the wider of Inter and San Francisco. Digits all take the widest digit, since figures are drawn
 * in tabular numerals. Weight 600 stands in for 500 too.
 */
const REGULAR = [
  282, 288, 466, 634, 642, 982, 669, 300, 365, 365, 501, 662, 289, 460, 289,
  361, 646, 646, 646, 646, 646, 646, 646, 646, 646, 646, 289, 302, 662, 662,
  662, 512, 966, 690, 655, 731, 722, 602, 591, 747, 744, 269, 571, 672, 566,
  904, 754, 765, 639, 765, 644, 642, 646, 745, 690, 986, 683, 679, 629, 365,
  361, 365, 605, 527, 500, 562, 613, 572, 613, 584, 371, 614, 592, 243, 243,
  549, 243, 876, 591, 600, 613, 613, 377, 528, 328, 592, 563, 819, 546, 563,
  553, 427, 333, 427, 662,
];
const BOLD = [
  282, 322, 523, 644, 651, 1005, 691, 326, 374, 374, 540, 674, 319, 466, 319,
  379, 667, 667, 667, 667, 667, 667, 667, 667, 667, 667, 319, 330, 674, 674,
  674, 544, 1000, 728, 660, 737, 723, 606, 589, 750, 746, 277, 580, 704, 566,
  923, 760, 769, 645, 773, 653, 651, 661, 737, 728, 1021, 720, 714, 653, 374,
  379, 374, 633, 560, 500, 575, 625, 583, 625, 592, 389, 626, 613, 262, 262,
  570, 262, 901, 612, 609, 625, 625, 398, 550, 354, 613, 588, 840, 569, 589,
  566, 455, 359, 455, 674,
];
/** Latin-1, U+00A0 to U+00FF, the widest of both fonts at both weights: é, ñ, ü, ß and the rest. */
const LATIN_1 = [
  282, 322, 633, 633, 750, 633, 316, 620, 612, 915, 461, 646, 674, 0, 667, 500,
  459, 674, 454, 464, 500, 615, 620, 319, 500, 324, 488, 646, 832, 870, 908,
  544, 728, 728, 728, 728, 728, 728, 1013, 737, 606, 606, 606, 606, 277, 277,
  277, 277, 752, 760, 769, 769, 769, 769, 769, 674, 769, 745, 745, 745, 745,
  714, 658, 644, 575, 575, 575, 575, 575, 575, 918, 583, 592, 592, 592, 592,
  262, 262, 262, 262, 594, 612, 609, 609, 609, 609, 609, 674, 609, 613, 613,
  613, 613, 589, 625, 589,
];
/**
 * Every other block of Unicode at its widest glyph, in ems, measured the same way: [first, last,
 * width]. Cyrillic, Greek and Latin Extended run to a full em and past it, so a word in them counts
 * at that. Anything not listed (an emoji, a rare ligature) counts at 1.3em.
 */
const BLOCKS: readonly (readonly [number, number, number])[] = [
  [0x0100, 0x024f, 1.32],
  [0x0250, 0x02ff, 1.26],
  [0x0300, 0x036f, 0],
  [0x0370, 0x03ff, 1.1],
  [0x0400, 0x045f, 1.09],
  [0x0460, 0x048f, 1.34],
  [0x0490, 0x052f, 1.12],
  [0x2000, 0x206f, 1.57],
  [0x2070, 0x214f, 1.18],
  [0x2150, 0x218f, 1.81],
  [0x2190, 0x2bff, 1.62],
  [0x2e80, 0x2fff, 1.01],
  [0x3000, 0x30ff, 1.61],
  [0x3100, 0x9fff, 1.01],
  [0xac00, 0xd7a3, 1],
];
type Face = "regular" | "bold";

/** A character's advance in ems. */
function advance(character: string, face: Face): number {
  const code = character.codePointAt(0) ?? 0;
  if (code >= 32 && code < 127)
    return ((face === "bold" ? BOLD : REGULAR)[code - 32] ?? 1000) / 1000;
  if (code >= 0xa0 && code <= 0xff)
    return (LATIN_1[code - 0xa0] ?? 1000) / 1000;
  for (const [first, last, width] of BLOCKS)
    if (code >= first && code <= last) return width;
  return 1.3;
}

/** How wide a run of text draws, in px. */
export function widthOf(text: string, size: number, face: Face): number {
  let width = 0;
  for (const character of text) width += advance(character, face);
  return width * size;
}

/** The words of a run of text, as the browser breaks it. */
function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * How many lines a run of text takes in `width`: breaking at spaces, and inside a word only when the
 * word alone is wider than the line (`overflow-wrap: anywhere`). With `preLine`, a newline starts a
 * line, as `white-space: pre-line` does; otherwise it is a space.
 */
export function linesOf(
  text: string,
  size: number,
  face: Face,
  width: number,
  preLine = false,
): number {
  const space = widthOf(" ", size, face);
  let lines = 0;
  for (const paragraph of preLine ? text.split("\n") : [text]) {
    lines += 1;
    let x = 0;
    for (const word of wordsOf(paragraph)) {
      const wide = widthOf(word, size, face);
      if (x > 0 && x + space + wide <= width) {
        x += space + wide;
        continue;
      }
      if (x > 0) lines += 1;
      x = 0;
      for (const character of word) {
        const step = advance(character, face) * size;
        if (x > 0 && x + step > width) {
          lines += 1;
          x = 0;
        }
        x += step;
      }
    }
  }
  return lines;
}

/** Whether every word of `text` fits `width` whole, so none has to break. */
function wordsFit(text: string, size: number, face: Face, width: number) {
  return wordsOf(text).every((word) => widthOf(word, size, face) <= width);
}

/** The blocks a slide holds, by shape: the app's and the server's types both fit it. */
export type SlideBlockShape =
  | { type: "heading"; text: string }
  | { type: "text"; text: string }
  | { type: "bullets"; items: readonly string[] }
  | {
      type: "metrics";
      items: readonly {
        label: string;
        value: string;
        note?: string | undefined;
      }[];
    }
  | {
      type: "bars";
      label?: string | undefined;
      items: readonly { label: string; value: number }[];
    }
  | {
      type: "list";
      title?: string | undefined;
      items: readonly { text: string; note?: string | undefined }[];
    };
export type SlideShape = { title: string; blocks: readonly SlideBlockShape[] };

/** 12, 1.5K, 2.1M: a bar's figure on a slide, the same on both sides. */
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
export function barFigure(value: number): string {
  return compact.format(value);
}

/** The width of each column of a chart with `count` bars standing in columns. */
const columnWidth = (count: number) =>
  (SLIDE_CONTENT_WIDTH - BAR_GAP * (count - 1)) / count;

/**
 * How a chart's bars are drawn: standing in columns, figure over and label under, when every figure
 * and every word of every label fits its column; lying in rows, label, bar and figure, when one does
 * not. A row has room for "Wednesday" where a seventh of a slide does not, so a chart is laid out
 * rather than refused.
 */
export function barsLayout(
  block: Extract<SlideBlockShape, { type: "bars" }>,
): "columns" | "rows" {
  const column = columnWidth(block.items.length);
  const fits = block.items.every(
    (item) =>
      widthOf(barFigure(item.value), CAPTION[0], "bold") <= column &&
      wordsFit(item.label, CAPTION[0], "regular", column),
  );
  return fits ? "columns" : "rows";
}

/** The width of the words in a tile of figures, in a row of `columns` tiles. */
const tileText = (columns: number) =>
  (SLIDE_CONTENT_WIDTH - TILE_GAP * (columns - 1)) / columns - 20;

/**
 * How many tiles a row of figures holds: two, unless a figure has a word too wide for half the
 * slide, when each tile takes the whole width rather than break the figure.
 */
export function metricColumns(
  block: Extract<SlideBlockShape, { type: "metrics" }>,
): 1 | 2 {
  if (block.items.length < 2) return 1;
  return block.items.every((metric) =>
    wordsFit(metric.value, FIGURE[0], "bold", tileText(2)),
  )
    ? 2
    : 1;
}

/**
 * The figures a slide cannot draw without breaking one mid-number: a word wider than a whole-width
 * tile. Words in sentences may wrap mid-word; a figure may not, since "2 of 4 cr" over "acked" reads
 * as a different number.
 */
export function figuresTooWide(
  block: Extract<SlideBlockShape, { type: "metrics" }>,
): number[] {
  return block.items.flatMap((metric, index) =>
    wordsFit(metric.value, FIGURE[0], "bold", tileText(1)) ? [] : [index],
  );
}

const lines = (
  text: string,
  [size, height]: readonly [number, number],
  face: Face,
  width: number,
  preLine = false,
) => linesOf(text, size, face, width, preLine) * height;

/** How tall one block draws on a slide, in px at the design width. */
export function blockHeight(block: SlideBlockShape): number {
  const W = SLIDE_CONTENT_WIDTH;
  switch (block.type) {
    case "heading":
      return lines(block.text, BODY, "bold", W);
    case "text":
      return lines(block.text, BODY, "regular", W, true);
    case "bullets":
      // Each bullet's words sit 12px in, past the dot and its gap, and 4px under the one before.
      return (
        block.items.reduce(
          (sum, item) => sum + lines(item, BODY, "regular", W - 12),
          0,
        ) +
        4 * (block.items.length - 1)
      );
    case "metrics": {
      const columns = metricColumns(block);
      const inner = tileText(columns);
      const tiles = block.items.map(
        (metric) =>
          16 +
          lines(metric.value, FIGURE, "bold", inner) +
          lines(metric.label, CAPTION, "bold", inner) +
          (metric.note ? 2 + lines(metric.note, CAPTION, "regular", inner) : 0),
      );
      let height = 0;
      for (let row = 0; row < tiles.length; row += columns)
        height +=
          Math.max(...tiles.slice(row, row + columns)) +
          (row > 0 ? TILE_GAP : 0);
      return height;
    }
    case "bars": {
      const caption = block.label
        ? lines(block.label, CAPTION, "bold", W) + 6
        : 0;
      if (barsLayout(block) === "rows")
        return (
          caption +
          block.items.reduce(
            (sum, item) =>
              sum + lines(item.label, CAPTION, "regular", ROW_LABEL_WIDTH),
            0,
          ) +
          ROW_GAP * (block.items.length - 1)
        );
      const column = columnWidth(block.items.length);
      const labels = Math.max(
        ...block.items.map((item) =>
          lines(item.label, CAPTION, "regular", column),
        ),
      );
      return caption + CAPTION[1] + 2 + BAR_PLOT + 4 + labels;
    }
    case "list": {
      // A row's words leave room for its chevron and the gap before it.
      const title = block.title ? lines(block.title, BODY, "bold", W) + 4 : 0;
      return (
        title +
        block.items.reduce(
          (sum, item) =>
            sum +
            Math.max(
              LIST_ROW,
              8 +
                lines(item.text, BODY, "bold", W - 24) +
                (item.note ? lines(item.note, CAPTION, "regular", W - 24) : 0),
            ),
          0,
        ) +
        (block.items.length - 1)
      );
    }
  }
}

/** How tall a slide's title draws, in px at the design width. */
export function titleHeight(title: string): number {
  return lines(title, TITLE, "bold", SLIDE_CONTENT_WIDTH);
}

/** How tall a slide's content draws at the design width: its title, then each block 12px apart. */
export function slideHeight(slide: SlideShape): number {
  return (
    titleHeight(slide.title) +
    slide.blocks.reduce(
      (sum, block) => sum + SLIDE_BLOCK_GAP + blockHeight(block),
      0,
    )
  );
}
