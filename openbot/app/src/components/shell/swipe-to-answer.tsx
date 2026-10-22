import {
  type AnimationPlaybackControls,
  animate,
  type MotionValue,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
} from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { DuetIcon } from "@/components/duet/icons";
import { EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** How much of the card's width a finger has to drag it before letting go answers. */
const THRESHOLD_SHARE = 0.35;
/** The least distance that answers, for a card too narrow (or not yet measured) for the share. */
const MIN_THRESHOLD = 96;
/**
 * How far a finger or a mouse moves before the drag is read as sideways or not. Until then nothing
 * moves, so a click that shifts a pixel or two is still a click.
 */
const SLOP = 8;
/** The card's tilt at the threshold and past it, in degrees. */
const MAX_TILT = 8;
/** How long a card answered by a drag takes to leave, before the answer is sent. */
const FLY_SECONDS = 0.28;
/** Back to rest from a drag let go short. Firm, with a little give, so it reads as a spring. */
const SPRING_BACK = { type: "spring", stiffness: 520, damping: 34 } as const;
/** Half the width of a mark's disc, so the disc can be centred in the space the card uncovers. */
const MARK_HALF = 22;
/** How far the card moves before the frosted space under it is fully drawn. */
const TRAY_FADE = 24;

type Answer = "start" | "hide";

/**
 * A card a finger or a mouse can slide off sideways. Right uncovers Start and left uncovers Hide; let go past
 * the threshold and the card flies off that way and answers. Let go short and it springs back.
 *
 * The card follows the finger and tilts toward where it is going, about its bottom edge, like a
 * playing card slid off a table. The mark it uncovers grows and fills in with the drag, and is at
 * full strength at the threshold, so the person can tell that letting go will do it.
 *
 * Touch, a pen and a mouse's main button all drag it, by the same rules. The card keeps vertical
 * panning (`touch-pan-y`) and gives up a drag that starts mostly vertical, so scrolling Chat never
 * moves it. A drag that begins on a button or a link is left to that control. Once a drag is
 * sideways the card holds the pointer, so a mouse that outruns it still drags it, and text can't be
 * selected until it is let go. The buttons stay the way to answer from a keyboard or a screen
 * reader; the marks are drawn for the eye only.
 *
 * With reduced motion the card does not tilt or fly: past the threshold it answers where it is let
 * go, and short of it it snaps back.
 */
export function SwipeToAnswer({
  children,
  disabled,
  onStart,
  onHide,
}: {
  children: ReactNode;
  /** True while an answer is on its way, from either a drag or a button. */
  disabled: boolean;
  /** The card was let go past the threshold to the right. `comeBack` returns it if starting fails. */
  onStart: (comeBack: () => void) => void;
  /** The card was let go past the threshold to the left. `comeBack` returns it if hiding fails. */
  onHide: (comeBack: () => void) => void;
}) {
  const reduceMotion = useReducedMotion();
  const x = useMotionValue(0);
  const card = useRef<HTMLDivElement>(null);
  const threshold = useRef(MIN_THRESHOLD);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    /** Where the card was when the finger landed: a card caught mid-spring carries on from there. */
    from: number;
    /** Set once the finger has moved far enough to tell a sideways drag from a scroll. */
    sideways: boolean;
  } | null>(null);
  const flight = useRef<AnimationPlaybackControls | null>(null);
  const landing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Off the card's edge and on its way out: nothing can drag it until it comes back.
  const [leaving, setLeaving] = useState(false);
  const [reached, setReached] = useState<Answer | null>(null);
  // A sideways drag is under way: no text selection, and a closed hand for a mouse.
  const [dragging, setDragging] = useState(false);

  useEffect(
    () => () => {
      flight.current?.stop();
      clearTimeout(landing.current);
    },
    [],
  );

  const strength = (value: number) =>
    Math.min(1, Math.abs(value) / threshold.current);
  const rotate = useTransform(
    x,
    (value) => Math.sign(value) * strength(value) * MAX_TILT,
  );
  const startStrength = useTransform(x, (value) =>
    value > 0 ? strength(value) : 0,
  );
  const hideStrength = useTransform(x, (value) =>
    value < 0 ? strength(value) : 0,
  );
  // The middle of the space the card has uncovered, held still once the drag is past the threshold.
  const uncovered = useTransform(
    x,
    (value) => Math.min(Math.abs(value), threshold.current) / 2,
  );
  const tray = useTransform(x, (value) =>
    Math.min(1, Math.abs(value) / TRAY_FADE),
  );
  useMotionValueEvent(x, "change", (value) => {
    setReached(
      value >= threshold.current
        ? "start"
        : value <= -threshold.current
          ? "hide"
          : null,
    );
  });

  const letGo = () => {
    drag.current = null;
    setDragging(false);
  };

  const settle = () => {
    if (reduceMotion) x.jump(0);
    else flight.current = animate(x, 0, SPRING_BACK);
  };

  const answer = (side: Answer) => {
    const send = side === "start" ? onStart : onHide;
    const comeBack = () => {
      setLeaving(false);
      settle();
    };
    if (reduceMotion) {
      x.jump(0);
      send(comeBack);
      return;
    }
    setLeaving(true);
    const away =
      (side === "start" ? 1 : -1) *
      (window.innerWidth + (card.current?.offsetWidth ?? 0));
    flight.current = animate(x, away, {
      duration: FLY_SECONDS,
      ease: EASE_OUT,
    });
    // On a timer of the same length, not on the animation's end: motion only finishes on an
    // animation frame, and a tab in the background gets none, so a card flung just before the
    // person switched away would never answer.
    landing.current = setTimeout(() => send(comeBack), FLY_SECONDS * 1000);
  };

  return (
    <div
      className={cn(
        "relative mb-2.5",
        dragging && "cursor-grabbing select-none",
      )}
    >
      {/*
       * The space the card leaves, frosted like the rest of the dock. Chat scrolls under the dock,
       * and without it a mark's word would sit over whatever message was passing behind.
       */}
      <motion.div
        aria-hidden
        className="duet-veil pointer-events-none absolute inset-0 rounded-[22px] shadow-[inset_0_0_0_1px_var(--duet-hair-2)]"
        style={{ opacity: tray }}
      />
      <Mark
        reached={reached === "start"}
        side="start"
        strength={startStrength}
        uncovered={uncovered}
      />
      <Mark
        reached={reached === "hide"}
        side="hide"
        strength={hideStrength}
        uncovered={uncovered}
      />
      <motion.div
        className="relative origin-bottom touch-pan-y"
        onPointerCancel={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          letGo();
          settle();
        }}
        onPointerDown={(event) => {
          if (
            disabled ||
            leaving ||
            event.button !== 0 ||
            (event.target as Element).closest("a, button")
          )
            return;
          flight.current?.stop();
          threshold.current = Math.max(
            MIN_THRESHOLD,
            (card.current?.offsetWidth ?? 0) * THRESHOLD_SHARE,
          );
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            from: x.get(),
            sideways: false,
          };
        }}
        onPointerMove={(event) => {
          const held = drag.current;
          if (held?.pointerId !== event.pointerId) return;
          const dx = event.clientX - held.x;
          const dy = event.clientY - held.y;
          if (!held.sideways) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP) return;
            if (Math.abs(dy) > Math.abs(dx) || disabled) {
              letGo();
              settle();
              return;
            }
            held.sideways = true;
            setDragging(true);
            // Touch holds the pointer already. A mouse would otherwise lose the card the moment it
            // moved faster than the card could follow, and keep selecting text on the way.
            event.currentTarget.setPointerCapture?.(event.pointerId);
            window.getSelection()?.removeAllRanges();
          }
          x.set(held.from + dx);
        }}
        onPointerUp={(event) => {
          const held = drag.current;
          if (held?.pointerId !== event.pointerId) return;
          letGo();
          const value = x.get();
          // A tap is not a drag, even on a card still springing back from past the threshold.
          if (!held.sideways || disabled) settle();
          else if (value >= threshold.current) answer("start");
          else if (value <= -threshold.current) answer("hide");
          else settle();
        }}
        ref={card}
        style={{ x, rotate: reduceMotion ? 0 : rotate }}
      >
        {children}
      </motion.div>
    </div>
  );
}

/**
 * What letting go will do, in the space the card uncovers: a green disc with a play glyph on the
 * left for Start, and a quieter grey one with a cross on the right for Hide. Each grows and fills
 * in with the drag, reaching full strength at the threshold.
 */
function Mark({
  side,
  strength,
  uncovered,
  reached,
}: {
  side: Answer;
  strength: MotionValue<number>;
  uncovered: MotionValue<number>;
  /** The drag is past the threshold on this side: letting go will do it. */
  reached: boolean;
}) {
  const scale = useTransform(strength, [0, 1], [0.6, 1]);
  const offset = useTransform(uncovered, (centre) =>
    side === "start" ? centre - MARK_HALF : MARK_HALF - centre,
  );
  const start = side === "start";
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-y-0 flex items-center",
        start ? "left-0" : "right-0",
      )}
    >
      <motion.div
        className="flex w-11 flex-col items-center gap-1"
        style={{ x: offset, opacity: strength, scale }}
      >
        <span
          className={cn(
            "grid size-11 place-items-center rounded-full transition-[color,box-shadow] duration-150 motion-reduce:transition-none",
            start
              ? [
                  "bg-duet-green text-duet-card",
                  reached && "shadow-[0_0_0_5px_var(--duet-green-soft)]",
                ]
              : [
                  "bg-duet-tile shadow-[inset_0_0_0_1px_var(--duet-hair)]",
                  reached ? "text-duet-ink-2" : "text-duet-ink-3",
                ],
          )}
        >
          {start ? <Play /> : <DuetIcon name="x" size={20} stroke={2.2} />}
        </span>
        <span
          className={cn(
            "font-semibold text-[13px] leading-4",
            start ? "text-duet-green" : "text-duet-ink-3",
          )}
        >
          {start ? "Start" : "Hide"}
        </span>
      </motion.div>
    </div>
  );
}

/** A play glyph. The icon set has none; this is drawn on its 24-unit grid with its round joins. */
function Play() {
  return (
    <svg
      aria-hidden
      fill="currentColor"
      height={20}
      style={{ display: "block", flex: "none" }}
      viewBox="0 0 24 24"
      width={20}
    >
      <path d="M8.5 5.6v12.8a1.1 1.1 0 0 0 1.68.94l10.24-6.4a1.1 1.1 0 0 0 0-1.88L10.18 4.66A1.1 1.1 0 0 0 8.5 5.6Z" />
    </svg>
  );
}
