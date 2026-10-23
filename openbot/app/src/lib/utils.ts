import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The five sizes of the type scale (`styles.css`), and the film's older names for them.
 *
 * Each sets a font size, a line height and tracking. `tailwind-merge` only knows Tailwind's own
 * utilities, so without this it kept `text-sm` beside `type-body` and the stylesheet's order picked
 * `text-sm`: every message bubble drew at 14px. Registered as font sizes, a `type-*` given later
 * replaces an earlier `text-*` size, and drops the `leading-*` that came with it.
 */
export const TYPE_SCALE_CLASSES = [
  "type-display",
  "type-nav",
  "type-body",
  "type-sub",
  "type-caption",
  "type-big",
  "type-title",
  "type-row",
  "type-label",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { type: TYPE_SCALE_CLASSES.map((name) => name.slice("type-".length)) },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
