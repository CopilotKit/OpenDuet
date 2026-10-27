/**
 * The app's motion vocabulary, in one place.
 *
 * These values were written out by hand in `detail-panel.tsx` and again in `app-sidebar.tsx`, and
 * the transcript would have been a third copy. Motion that is meant to read as one hand cannot be
 * three sets of magic numbers that happen to agree today.
 *
 * THE SAME NUMBERS AS styles.css. A class animates with `--duet-dur-*` and `--duet-ease-*`; motion's
 * JavaScript cannot read a custom property, so the four durations and two curves are repeated here,
 * and `tests/motion-tokens.test.ts` fails if the two ever disagree.
 */

/** Strong ease-out. The browser's built-in curve is too weak to read as deliberate. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/** Its mirror, for something leaving the screen: it sets off gently and is gone at speed. */
export const EASE_IN = [0.7, 0, 0.84, 0] as const;

/**
 * How long something takes to arrive.
 *
 * Entrances are the one place a curve is watched closely, and anything past ~250ms starts reading
 * as the interface thinking rather than responding.
 */
export const ENTRANCE_SECONDS = 0.2;

/**
 * The four durations, from a press to a sheet. Something that leaves takes the step below the one
 * it arrived with, because by then the person has already moved on.
 */
export const DURATION = {
  /** A press acknowledged, a colour that follows the pointer: `--duet-dur-tap`. */
  tap: 0.12,
  /** One state becoming another in place, a word, an icon, a menu: `--duet-dur-swap`. */
  swap: 0.2,
  /** Something new arriving on the screen: `--duet-dur-enter`. */
  enter: 0.25,
  /** A sheet or a drawer crossing the screen: `--duet-dur-sheet`. */
  sheet: 0.35,
} as const;
