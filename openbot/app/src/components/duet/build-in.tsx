import { motion } from "motion/react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useReplyHold } from "@/components/channels/reply-hold";
import { EASE_OUT } from "@/lib/motion";
import { useReducedMotionPreference } from "@/lib/reduced-motion";

/**
 * A generated card building itself in, a piece at a time, when it arrives live.
 *
 * WHY. A tool's result lands whole. Drawn in one frame, a brief of eight rows replaced the line
 * that said it was reading the mail, and the live demo read as "very fast and hard to follow": the
 * eye had nowhere to start. Each piece rising a beat after the one above gives it an order to read
 * in, the way the Bot's words arrive as they are written.
 *
 * ONLY LIVE. A card read back from history, or drawn again, is drawn whole: replaying its entrance
 * on every open would be decoration on something the person is trying to read. `useArrivedLive`
 * decides that once per card.
 *
 * OPACITY AND TRANSFORM ONLY. Every piece takes its full height from the first frame, so the card
 * is its final size as soon as it appears and the scroller never measures it growing.
 */
export const BUILD_IN = {
  /** Seconds between one piece and the next. */
  step: 0.07,
  /** How long each piece takes to arrive. */
  seconds: 0.26,
  /** How far a piece rises, in pixels. */
  rise: 6,
} as const;

const Building = createContext(false);

/** Marks what is under it as a card arriving live, so its `BuildIn` pieces play. */
export const BuildInProvider = Building.Provider;

/**
 * Whether this card arrived live: its tool was still running when it was first drawn here, or the
 * Bot's turn was still being written. Decided once and kept, so a card never replays its entrance.
 */
export function useArrivedLive(running: boolean): boolean {
  const held = useReplyHold();
  const [live, setLive] = useState(running || held);
  if (running && !live) setLive(true);
  return live;
}

/**
 * One piece of a card, arriving `order` beats after the card does. Outside a live card it is drawn
 * as it is. Reduced motion keeps the fade and drops the rise and the queue: a cascade is movement
 * too, only spread over time.
 */
export function BuildIn({
  order,
  className,
  children,
}: {
  order: number;
  className?: string;
  children: ReactNode;
}) {
  const live = useContext(Building);
  const reduced = useReducedMotionPreference();
  if (!live)
    return className ? <div className={className}>{children}</div> : children;
  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      className={className}
      data-build-in={order}
      initial={{
        opacity: 0,
        transform: reduced ? "none" : `translateY(${BUILD_IN.rise}px)`,
      }}
      transition={{
        delay: reduced ? 0 : order * BUILD_IN.step,
        duration: BUILD_IN.seconds,
        ease: EASE_OUT,
      }}
    >
      {children}
    </motion.div>
  );
}
