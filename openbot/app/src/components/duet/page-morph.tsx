import { motion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PageSummary } from "@/lib/pages/queries";
import { useReducedMotionPreference } from "@/lib/reduced-motion";

/*
 * Opening something the Bot made from its card: the card grows into the sheet, and closing shrinks
 * the sheet back into the card it came from. A shared-element transition, done as a FLIP with one
 * stand-in: a copy of the card's face, drawn over the veil at the card's rectangle and moved to the
 * sheet's, after which the sheet shows and the stand-in fades. Closing runs it the other way to
 * wherever the card is now, which can be a different place if the list moved underneath.
 *
 * The stand-in's size is what animates, not a scale, so its preview and title stay sharp and never
 * stretch. With reduced motion, or with no card on screen to come from (a link opened on its own),
 * the sheet fades in and out instead.
 */

/** How long the card takes to become the sheet, and the sheet the card. */
export const MORPH_SECONDS = 0.36;
/** The fade that replaces it, and the one at its end where the sheet takes over from the stand-in. */
export const FADE_MS = 160;
/** iOS's own sheet curve: quick away, long settle. */
const EASE = [0.32, 0.72, 0, 1] as const;

export type CardSize = "row" | "grid";

type Opened = {
  pageId: string;
  element: HTMLElement;
  page: PageSummary;
  size: CardSize;
};

/** The card last pressed, so the sheet it opens knows where it came from and what it looked like. */
let opened: Opened | null = null;
/** Every card on screen, by page, so closing finds one even when it was opened some other way. */
const cards = new Map<
  string,
  Map<HTMLElement, { page: PageSummary; size: CardSize }>
>();

/** A card was pressed: remember it until its sheet has read it. */
export function rememberOpenedFrom(
  element: HTMLElement,
  page: PageSummary,
  size: CardSize,
): void {
  opened = { pageId: page.id, element, page, size };
}

/** A card is on screen. Returns its removal, for the ref's cleanup. */
export function registerCard(
  element: HTMLElement,
  page: PageSummary,
  size: CardSize,
): () => void {
  let forPage = cards.get(page.id);
  if (!forPage) {
    forPage = new Map();
    cards.set(page.id, forPage);
  }
  forPage.set(element, { page, size });
  return () => {
    const current = cards.get(page.id);
    current?.delete(element);
    if (current?.size === 0) cards.delete(page.id);
  };
}

export type Box = { top: number; left: number; width: number; height: number };

function boxOf(element: Element): Box | null {
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return null;
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

/** Where a page's card is now, and how it looks: the one pressed if it is still there, else any. */
export function cardFor(
  pageId: string,
): { box: Box; page: PageSummary; size: CardSize } | null {
  const candidates: {
    element: HTMLElement;
    page: PageSummary;
    size: CardSize;
  }[] = [];
  if (opened?.pageId === pageId) candidates.push(opened);
  for (const [element, card] of cards.get(pageId) ?? [])
    candidates.push({ element, ...card });
  for (const candidate of candidates) {
    if (!candidate.element.isConnected) continue;
    const box = boxOf(candidate.element);
    if (box) return { box, page: candidate.page, size: candidate.size };
  }
  return null;
}

/** For tests: forget every card and the last one pressed. */
export function forgetCards(): void {
  opened = null;
  cards.clear();
}

type Ghost = {
  from: Box;
  to: Box;
  page: PageSummary;
  size: CardSize;
  /** Out of the card into the sheet, or back. */
  direction: "open" | "close";
  /** Fading away over the sheet that took its place. */
  leaving: boolean;
};

/**
 * The morph for one sheet. `sheetRef` goes on the sheet's card, which is measured once it is laid
 * out: a dialog draws its content a beat after it mounts, so this waits for the card to arrive
 * rather than measuring on mount. The flags say what the sheet itself should draw: hidden while the
 * stand-in moves, shown otherwise, and faded out while it closes without one.
 */
export function useSheetMorph(
  pageId: string,
  onClosed: () => void,
  /** The card's face, as the card draws it, for the stand-in to carry. */
  face: (page: PageSummary, size: CardSize) => ReactNode,
): {
  /** For the sheet's card. */
  sheetRef: (element: HTMLElement | null) => void;
  /** The sheet should draw itself without its own entrance: the stand-in is its entrance. */
  morphing: boolean;
  /** Hide the sheet's card: the stand-in is where it is. */
  hidden: boolean;
  /** Fade the whole sheet out: it is closing with no card to go back to. */
  fading: boolean;
  close: () => void;
  ghost: ReactNode;
} {
  const reduced = useReducedMotionPreference();
  // Decided before the first paint, so the sheet never shows in its place and then jumps.
  const [origin] = useState(() => (reduced ? null : cardFor(pageId)));
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [hidden, setHidden] = useState(origin !== null);
  const [fading, setFading] = useState(false);
  const closing = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const later = useCallback((ms: number, run: () => void) => {
    timers.current.push(setTimeout(run, ms));
  }, []);
  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  const sheet = useRef<HTMLElement | null>(null);
  const [arrived, setArrived] = useState(false);
  const sheetRef = useCallback((element: HTMLElement | null) => {
    sheet.current = element;
    if (element) setArrived(true);
  }, []);
  const started = useRef(false);
  useLayoutEffect(() => {
    if (!arrived || started.current) return;
    started.current = true;
    if (opened?.pageId === pageId) opened = null;
    const to = sheet.current ? boxOf(sheet.current) : null;
    if (!origin || !to) {
      setHidden(false);
      return;
    }
    setGhost({
      from: origin.box,
      to,
      page: origin.page,
      size: origin.size,
      direction: "open",
      leaving: false,
    });
  }, [arrived, origin, pageId]);

  /** The stand-in reached the sheet: show the sheet and let the stand-in go. */
  const landed = useCallback(() => {
    setGhost((current) =>
      current && current.direction === "open" && !current.leaving
        ? { ...current, leaving: true }
        : current,
    );
    setHidden(false);
    later(FADE_MS, () => setGhost(null));
  }, [later]);

  // A stand-in that never reports its end (a hidden tab, a test's DOM) still hands over.
  useEffect(() => {
    if (ghost?.direction !== "open" || ghost.leaving) return;
    const timer = setTimeout(landed, MORPH_SECONDS * 1000 + 120);
    return () => clearTimeout(timer);
  }, [ghost, landed]);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const from = sheet.current ? boxOf(sheet.current) : null;
    const back = reduced ? null : cardFor(pageId);
    if (!from || !back) {
      setFading(true);
      later(FADE_MS, () => onClosedRef.current());
      return;
    }
    setHidden(true);
    setGhost({
      from,
      to: back.box,
      page: back.page,
      size: back.size,
      direction: "close",
      leaving: false,
    });
    later(MORPH_SECONDS * 1000 + 60, () => onClosedRef.current());
  }, [later, pageId, reduced]);

  return {
    sheetRef,
    morphing: origin !== null,
    hidden,
    fading,
    close,
    ghost: ghost ? (
      <MorphGhost
        ghost={ghost}
        onDone={ghost.direction === "open" ? landed : undefined}
      >
        {face(ghost.page, ghost.size)}
      </MorphGhost>
    ) : null,
  };
}

/**
 * The stand-in: the card's face on the card's own surface, sized from one rectangle to the other.
 * Over the veil and under nothing; it takes no pointer, so a tap during the move lands on the sheet.
 */
function MorphGhost({
  ghost,
  onDone,
  children,
}: {
  ghost: Ghost;
  onDone: (() => void) | undefined;
  children: ReactNode;
}) {
  const open = ghost.direction === "open";
  const radius = (size: CardSize) => (size === "grid" ? 20 : 22);
  return (
    <motion.div
      animate={{
        top: ghost.to.top,
        left: ghost.to.left,
        width: ghost.to.width,
        height: ghost.to.height,
        borderRadius: open ? 28 : radius(ghost.size),
        opacity: ghost.leaving ? 0 : 1,
      }}
      aria-hidden
      className="duet-face pointer-events-none fixed z-[60] overflow-hidden bg-duet-card text-duet-ink shadow-duet-raised"
      data-morph={ghost.direction}
      initial={{
        top: ghost.from.top,
        left: ghost.from.left,
        width: ghost.from.width,
        height: ghost.from.height,
        borderRadius: open ? radius(ghost.size) : 28,
        opacity: 1,
      }}
      onAnimationComplete={() => {
        if (!ghost.leaving) onDone?.();
      }}
      transition={{
        duration: MORPH_SECONDS,
        ease: EASE,
        opacity: { duration: FADE_MS / 1000, ease: "easeOut" },
      }}
    >
      {children}
    </motion.div>
  );
}
