import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { DURATION, EASE_OUT } from "@/lib/motion";
import { OnboardingFrame } from "./onboarding-frame";

/**
 * One step: an id that outlives the list changing around it, what it shows, and what its buttons
 * say and do. Ids are this app's own fixed words, which is what lets them sit in a selector
 * unescaped.
 *
 * The buttons are the frame's, so a step describes them rather than drawing them: the pinned
 * button's words where the step has its own action ("Continue", "Turn on notifications"), what that
 * action does given the move to the next step, and, on an optional step, a second button such as
 * "Not now" that moves on and writes nothing.
 */
export type OnboardingStep = {
  id: string;
  render: () => ReactNode;
  /** The pinned button's words here. "Next" when absent; the last step's are `finishLabel`. */
  primaryLabel?: string;
  /** What the pinned button does, given the move to the next step. Moving on when absent. */
  onPrimary?: (next: () => void) => void;
  /** The pinned button reads as done, green with a check. */
  primaryDone?: boolean;
  /** The pinned button is waiting on something, such as the browser's permission prompt. */
  primaryPending?: boolean;
  primaryDisabled?: boolean;
  /** An optional step's way past it, under the primary. Moves on when it has no action of its own. */
  secondary?: { label: string; onClick?: (next: () => void) => void };
  /**
   * An optional step keeps the second button's place even while it has none, so the primary stays
   * one button higher for the whole step: Get notified drops Not now once the browser has answered.
   */
  optional?: boolean;
  /** A line about the step, above the button. */
  footnote?: ReactNode;
  /** Something the step has to say right above its buttons, such as why the button became Next. */
  notice?: ReactNode;
};

/**
 * A pane crossfades with a short travel toward the way the journey is going: the chrome around it
 * stays still, so only the content moves, and never by more than 24 px.
 */
const variants = {
  initial: (direction: number) => ({ x: 24 * direction, opacity: 0 }),
  active: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: -24 * direction, opacity: 0 }),
};

/**
 * The steps, moved through one at a time inside {@link OnboardingFrame}.
 *
 * WHERE SOMEBODY IS, BY ID. The list grows after it first draws: the three local-evaluation steps
 * join once the server says this is somebody trying OpenDuet alone, and that answer can arrive while
 * they are on step two. Held as an index, their place would slide by three; held as an id, the step
 * they are on stays the step they are on, and only the dashes around it change.
 *
 * WHO HOLDS THE ID. The route does, through `stepId` and `onMove`, because the step lives in the
 * address (`?step=`) so that a reload, browser Back and an OAuth return all land on the right one.
 * Without `onMove` the wizard keeps the id itself, from `initialStepId`.
 *
 * FOCUS FOLLOWS THE STEP. A change of step replaces everything between the dashes and the button,
 * so the element that had focus (Back, or the button) either vanished or now means something else.
 * Focus moves to the new step's heading, which a screen reader then reads, and the first draw leaves
 * focus alone. Motion respects the reader's reduced-motion setting: the movement becomes a fade.
 */
export function OnboardingWizard({
  steps,
  stepId: heldStepId,
  onMove,
  initialStepId,
  finishLabel,
  finishing = false,
  notice,
  onFinish,
}: {
  steps: OnboardingStep[];
  /** The step to show, when the caller holds it. */
  stepId?: string;
  /** Asked to move to another step, when the caller holds it. */
  onMove?: (to: string, way: "forward" | "back") => void;
  initialStepId?: string;
  /** What the last step's button says. Every other step's says its own words, or Next. */
  finishLabel: string;
  /** While the finish is being saved: the button says so and does nothing. */
  finishing?: boolean;
  notice?: ReactNode;
  onFinish: () => void;
}) {
  const [own, setOwn] = useState(() => initialStepId ?? steps[0]?.id ?? "");
  const current = heldStepId ?? own;
  const container = useRef<HTMLDivElement>(null);

  // A step that left the list (the server's answer changed) falls back to the first, never to nothing.
  const found = steps.findIndex((step) => step.id === current);
  const index = found === -1 ? 0 : found;
  const step = steps[index];
  const last = index === steps.length - 1;

  // The way the journey is going, for the motion: toward a later step, or back to an earlier one.
  const shown = useRef(index);
  const way = useRef(1);
  if (index !== shown.current) {
    way.current = index > shown.current ? 1 : -1;
    shown.current = index;
  }
  const direction = way.current;

  const go = (to: number) => {
    const target = steps[to];
    if (!target) return;
    if (onMove) onMove(target.id, to > index ? "forward" : "back");
    else setOwn(target.id);
  };
  /*
   * On from the step this was handed to, not from whichever step is current when it runs: a step
   * that moves on after a beat (Get notified, once the browser said yes) must not skip a step if
   * the person pressed Back or Next during that beat.
   */
  const showing = useRef(step?.id);
  showing.current = step?.id;
  const from = step?.id;
  const next = () => {
    if (showing.current !== from) return;
    go(index + 1);
  };

  /*
   * Keyed on the id, not the step object: the list is rebuilt on every render of the route, and a
   * fresh object would pull focus back to the heading each time anything on the page changed, such
   * as the checklist's answer arriving while somebody tabs through it. The first draw is skipped,
   * so arriving on a page leaves focus where the browser put it.
   */
  const stepId = step?.id;
  const arrivedOn = useRef(stepId);
  const moved = useRef(false);
  useEffect(() => {
    if (!stepId) return;
    if (!moved.current && stepId === arrivedOn.current) return;
    moved.current = true;
    // The frame keeps its scroll container between steps; the new heading starts at the top.
    const main = container.current?.closest("main");
    if (main) main.scrollTop = 0;
    const heading = container.current?.querySelector<HTMLElement>(
      `[data-step="${stepId}"] h1`,
    );
    if (!heading) return;
    // Focusable by script only, so it is not a stop when tabbing through the page.
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [stepId]);

  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: DURATION.enter, ease: EASE_OUT }}
    >
      <OnboardingFrame
        footnote={step?.footnote}
        index={index}
        notice={
          step?.notice || notice ? (
            <>
              {step?.notice}
              {notice}
            </>
          ) : undefined
        }
        onBack={() => go(index - 1)}
        primary={{
          label: last
            ? finishing
              ? "Saving…"
              : finishLabel
            : (step?.primaryLabel ?? "Next"),
          disabled:
            (last && finishing) ||
            step?.primaryDisabled === true ||
            step?.primaryPending === true,
          done: step?.primaryDone === true,
          pending: step?.primaryPending === true,
          onClick: () => {
            if (last) return onFinish();
            if (step?.onPrimary) return step.onPrimary(next);
            next();
          },
        }}
        reserveSecondary={step?.optional === true}
        secondary={
          step?.secondary
            ? {
                label: step.secondary.label,
                onClick: () =>
                  step.secondary?.onClick
                    ? step.secondary.onClick(next)
                    : next(),
              }
            : undefined
        }
        total={steps.length}
      >
        <div className="relative w-full" ref={container}>
          <AnimatePresence custom={direction} initial={false} mode="popLayout">
            <motion.div
              animate="active"
              custom={direction}
              data-step={step?.id}
              exit="exit"
              initial="initial"
              key={step?.id}
              variants={variants}
            >
              {step?.render()}
            </motion.div>
          </AnimatePresence>
        </div>
      </OnboardingFrame>
    </MotionConfig>
  );
}
