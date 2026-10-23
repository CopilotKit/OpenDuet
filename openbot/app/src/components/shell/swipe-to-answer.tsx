import {
  type AnimationPlaybackControls,
  animate,
  type MotionValue,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useReducedMotionConfig,
  useTransform,
} from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { DuetIcon } from "@/components/duet/icons";
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
/** The card's tilt at the threshold and past it, in degrees. A lean, not a spin. */
const MAX_TILT = 4;
/** How blurred the card's content is at the threshold and past it, in pixels: no word survives it. */
const MAX_BLUR = 14;
/**
 * The share of the threshold by which a mark is fully drawn. Early, so the person sees what the
 * drag will do while it is still small, and the mark then fills in when letting go would do it.
 */
const MARK_IN = 0.3;
/**
 * The corner radius of the card this wraps. While the content is blurred it is clipped to it, so the
 * slab keeps its edge instead of the blur spilling past its corners.
 */
const CARD_RADIUS = 22;
/**
 * Within this many pixels of its place the card counts as at rest: no blur, slab, tint or mark. The
 * last stretch of a spring back is drawn as the card at rest, not as a faint hand-off.
 */
const REST = 2;
/** How long a card answered by a drag takes to leave the screen. The answer is sent when it has. */
const FLY_SECONDS = 0.28;
/**
 * How far past the screen's edge the card flies, so its shadow has gone too. Its tilt keeps it
 * inside its own width on the side it trails, so the edge is all there is to clear.
 */
const EXIT_MARGIN = 16;
/**
 * How long past the flight to wait before answering anyway. Motion only moves on an animation
 * frame, and a tab in the background gets none, so a card flung just before the person switched
 * away would otherwise never answer.
 */
const LANDING_GRACE_MS = 120;
/**
 * Back to rest from a drag let go short. Firm and without a bounce: a spring that overshoots
 * carries the card past its place, and the other side's tint and mark would show for a moment.
 */
const SPRING_BACK = { type: "spring", stiffness: 520, damping: 48 } as const;

type Answer = "start" | "hide";

/**
 * A card a finger or a mouse can slide off sideways. Right is Start and left is Hide; let go past
 * the threshold and the card flies off that way and answers. Let go short and it springs back.
 *
 * Once the card moves it stops being something to read and becomes something being handed over. It
 * tilts toward where it is going, about its bottom edge, like a playing card slid off a table. Its
 * content blurs, quickly at first and to nothing legible by the threshold, and it takes on a tint:
 * green toward Start, grey toward Hide. On its top corner, where the eye already is, a mark says what
 * letting go will do: an outlined ring with a play glyph and "Start" (an × and "Hide" the other way),
 * which fills in solid at the threshold. The blur, the tint and the mark all follow the drag, so a
 * card let go short loses them on its way back and comes to rest exactly as it was.
 *
 * The blur is a filter on the card's own content, not on what is behind it. A backdrop filter on a
 * layer that moves and rotates has to resample the page every frame, and comes out soft or smeared
 * where it crosses the screen's edge. While blurred, the card is drawn on an opaque slab of its own
 * colour, because a filter cuts the glass inside it off from what is behind. At rest the filter is
 * `none`, not a zero blur, so the glass is frosted again.
 *
 * Touch, a pen and a mouse's main button all drag it, by the same rules. The card keeps vertical
 * panning (`touch-pan-y`) and gives up a drag that starts mostly vertical, so scrolling Chat never
 * moves it. A drag that begins on a button or a link is left to that control. Once a drag is
 * sideways the card holds the pointer, so a mouse that outruns it still drags it, and text can't be
 * selected until it is let go. The buttons stay the way to answer from a keyboard or a screen
 * reader; the marks are drawn for the eye only.
 *
 * With reduced motion the card does not tilt, blur or fly: the tint and the mark fade in with the
 * drag, past the threshold it answers where it is let go, and short of it it snaps back.
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
  // The device's setting, or a `MotionConfig` above that asks for it. Motion's own default config
  // never reduces, so the config alone would ignore a person who asked their phone for less motion.
  const deviceReducesMotion = useReducedMotion();
  const configReducesMotion = useReducedMotionConfig();
  const reduceMotion = Boolean(deviceReducesMotion || configReducesMotion);
  const x = useMotionValue(0);
  const slot = useRef<HTMLDivElement>(null);
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
  // Strength eased out: most of the way there early, so a card that has just begun to move already
  // reads as on its way, and the last stretch to the threshold changes little.
  const reach = (value: number) => 1 - (1 - strength(value)) ** 2;
  const blur = (value: number) =>
    reduceMotion || Math.abs(value) < REST ? 0 : MAX_BLUR * reach(value);
  const blurred = (value: number) => blur(value) > 0;
  const rotate = useTransform(
    x,
    (value) => Math.sign(value) * strength(value) * MAX_TILT,
  );
  const startReach = useTransform(x, (value) =>
    value >= REST ? reach(value) : 0,
  );
  const hideReach = useTransform(x, (value) =>
    value <= -REST ? reach(value) : 0,
  );
  const presence = (value: number) =>
    Math.min(1, Math.abs(value) / (threshold.current * MARK_IN));
  const startPresence = useTransform(x, (value) =>
    value >= REST ? presence(value) : 0,
  );
  const hidePresence = useTransform(x, (value) =>
    value <= -REST ? presence(value) : 0,
  );
  // `none` at rest, never `blur(0px)`: any filter at all cuts the glass off from what is behind it.
  const filter = useTransform(x, (value) =>
    blurred(value) ? `blur(${blur(value).toFixed(2)}px)` : "none",
  );
  const clipPath = useTransform(x, (value) =>
    blurred(value) ? `inset(0 round ${CARD_RADIUS}px)` : "none",
  );
  const slab = useTransform(x, (value) => (blurred(value) ? 1 : 0));
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
    // Just past the screen's edge, from where the card sits at rest.
    const place = slot.current?.getBoundingClientRect();
    const away =
      side === "start"
        ? window.innerWidth - (place?.left ?? 0) + EXIT_MARGIN
        : -((place?.right ?? 0) + EXIT_MARGIN);
    const from = x.get();
    // The finger's speed toward the edge, against the flight's average. The curve sets off at that
    // speed, so a flick carries on and a card held still sets off from rest, and it ends at the
    // average speed, so it leaves the screen still moving rather than easing to a stop at its edge.
    const average = Math.abs(away - from) / FLY_SECONDS;
    const lead =
      average > 0
        ? Math.min(
            1.5,
            Math.max(0, (x.getVelocity() * Math.sign(away)) / average),
          )
        : 1;
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      clearTimeout(landing.current);
      send(comeBack);
    };
    flight.current = animate(x, away, {
      duration: FLY_SECONDS,
      ease: [0.3, 0.3 * lead, 0.7, 0.7],
      onComplete: land,
    });
    landing.current = setTimeout(land, FLY_SECONDS * 1000 + LANDING_GRACE_MS);
  };

  return (
    <div
      className={cn(
        "relative mb-2.5",
        dragging && "cursor-grabbing select-none",
      )}
      ref={slot}
    >
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
        {/* The slab the blurred card is drawn on, opaque, so nothing behind shows through it. */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[22px] bg-duet-card shadow-duet-glass"
          data-swipe-slab=""
          style={{ opacity: slab }}
        />
        <motion.div
          className="relative"
          data-swipe-content=""
          style={{ filter, clipPath }}
        >
          {children}
        </motion.div>
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[22px] bg-duet-green/10 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--duet-green)_32%,transparent)]"
          data-swipe-tint="start"
          style={{ opacity: startReach }}
        />
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[22px] bg-duet-ink-3/12 shadow-[inset_0_0_0_1px_var(--duet-hair)]"
          data-swipe-tint="hide"
          style={{ opacity: hideReach }}
        />
        <Mark
          presence={startPresence}
          reached={reached === "start"}
          side="start"
        />
        <Mark
          presence={hidePresence}
          reached={reached === "hide"}
          side="hide"
        />
      </motion.div>
    </div>
  );
}

/**
 * What letting go will do, on the card's top corner: the left one for Start, which the card trails
 * as it goes right, and the right one for Hide. It rides on the card, above the blur, so it stays
 * sharp. Short of the threshold it is an outlined ring, green with a play glyph for Start and grey
 * with an × for Hide; at the threshold it fills in solid, because letting go now will do it. It
 * fades in and never grows: the fill is the one change that means something.
 */
function Mark({
  side,
  presence,
  reached,
}: {
  side: Answer;
  /** How much of the mark is drawn: in early in the drag, so it is there before it is needed. */
  presence: MotionValue<number>;
  /** The drag is past the threshold on this side: letting go will do it. */
  reached: boolean;
}) {
  const start = side === "start";
  return (
    <motion.div
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-3 flex flex-col items-center gap-1",
        // The light theme's green is too pale for 13px type over a light slab; a deeper one keeps the
        // word and the ring readable. The dark theme's green already is.
        "[--swipe-green:#166534] dark:[--swipe-green:var(--duet-green)]",
        start ? "left-3.5" : "right-3.5",
      )}
      data-state={reached ? "filled" : "ring"}
      data-swipe-mark={side}
      style={{ opacity: presence }}
    >
      <span
        className={cn(
          "grid size-11 place-items-center rounded-full transition-[background-color,color,box-shadow] duration-150",
          start
            ? reached
              ? "bg-(--swipe-green) text-duet-card"
              : "text-(--swipe-green) shadow-[inset_0_0_0_1.5px_var(--swipe-green)]"
            : reached
              ? "bg-duet-ink-2 text-duet-card"
              : "text-duet-ink-2 shadow-[inset_0_0_0_1.5px_var(--duet-ink-2)]",
        )}
      >
        {start ? <Play /> : <DuetIcon name="x" size={20} stroke={2} />}
      </span>
      <span
        className={cn(
          "font-semibold text-[13px] leading-4",
          start ? "text-(--swipe-green)" : "text-duet-ink-2",
        )}
      >
        {start ? "Start" : "Hide"}
      </span>
    </motion.div>
  );
}

/** A play glyph, outlined. The icon set has none; this is drawn on its 24-unit grid with its round joins. */
function Play() {
  return (
    <svg
      aria-hidden
      fill="none"
      height={20}
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth={2}
      style={{ display: "block", flex: "none" }}
      viewBox="0 0 24 24"
      width={20}
    >
      <path d="M8.5 5.6v12.8a1.1 1.1 0 0 0 1.68.94l10.24-6.4a1.1 1.1 0 0 0 0-1.88L10.18 4.66A1.1 1.1 0 0 0 8.5 5.6Z" />
    </svg>
  );
}
