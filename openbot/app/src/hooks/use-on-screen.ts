import { type RefObject, useEffect, useState } from "react";

/** Current visibility, so off-screen rows pause reads even after they have been seen. */
export function useOnScreen(
  element: RefObject<HTMLElement | null>,
  /** A row with a summary already has its title and needs no observer. */
  watch: boolean,
): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    setOnScreen(false);
    const target = element.current;
    // Without an observer, a row is never known to be visible.
    if (!watch || !target || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(([entry]) => {
      setOnScreen(Boolean(entry?.isIntersecting));
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [element, watch]);
  return watch && onScreen;
}
