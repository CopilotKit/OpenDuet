import { useSyncExternalStore } from "react";

/*
 * Whether the person asked their system for less motion, read fresh from the media query each time.
 *
 * Not `motion`'s own `useReducedMotion`: that reads the query once per page and keeps the answer, so
 * a screen cannot follow a change, and a test cannot set it. Animations here that have a reduced form
 * (the sheet's morph, Make's fan) ask this instead.
 */

const QUERY = "(prefers-reduced-motion: reduce)";

function mediaQuery(): MediaQueryList | null {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : null;
}

export function prefersReducedMotion(): boolean {
  return mediaQuery()?.matches ?? false;
}

/** The same, kept current while the component is on screen. */
export function useReducedMotionPreference(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const list = mediaQuery();
      list?.addEventListener?.("change", changed);
      return () => list?.removeEventListener?.("change", changed);
    },
    prefersReducedMotion,
    () => false,
  );
}
