import type { ReactNode } from "react";
import { DuetIcon } from "@/components/duet/icons";
import { cn } from "@/lib/utils";

/**
 * The frame every onboarding step sits in, the way Duet lays one out: a round back chevron at the
 * top left, the steps as dashes across the top, and one full-width button pinned to the bottom.
 *
 * The frame owns where things are, never what a step says. A step is only its content, and what its
 * buttons say; Back, the dashes and the button sit in the same place on every one of them, so
 * moving through onboarding never moves the control somebody is about to press.
 *
 * AN OPTIONAL STEP HAS A SECOND BUTTON. "Not now" goes under the primary, the same size and shape,
 * outlined on the surface, so the primary sits one button higher on those steps, and stays there
 * when the second button goes (`reserveSecondary`). A footnote, where a step has one, sits just
 * above the primary in small grey type.
 */
export function OnboardingFrame({
  index,
  total,
  onBack,
  primary,
  secondary,
  reserveSecondary = false,
  footnote,
  notice,
  children,
}: {
  /** Zero-based. */
  index: number;
  total: number;
  onBack: () => void;
  primary: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    /** Drawn green with a check: what the button asked for has happened. */
    done?: boolean;
    /** Waiting on an answer, such as the browser's prompt: a spinner beside the label. */
    pending?: boolean;
  };
  /** The optional step's way past it, such as Not now. */
  secondary?: { label: string; onClick: () => void };
  /** Keep the second button's place while it has none, so the primary doesn't drop. */
  reserveSecondary?: boolean;
  /** A line about the step, just above the button. */
  footnote?: ReactNode;
  /** Said just above the button, such as a save that failed. */
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="duet-face flex h-svh min-w-0 w-full flex-col bg-duet-surface text-duet-ink">
      <header className="relative flex h-[68px] shrink-0 items-center justify-center px-[76px] pt-[env(safe-area-inset-top)]">
        {/*
         * Not drawn on the first step, rather than drawn disabled: there is nowhere behind it, and a
         * control that does nothing is one more thing a screen reader stops on.
         */}
        {index > 0 ? (
          <button
            aria-label="Back"
            className="duet-glass absolute left-4 grid size-[44px] place-items-center rounded-full text-duet-ink shadow-duet-glass outline-none transition-transform focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-95"
            data-onboarding-back=""
            onClick={onBack}
            type="button"
          >
            <DuetIcon name="chevronLeft" size={22} stroke={2.2} />
          </button>
        ) : null}
        <StepDashes index={index} total={total} />
      </header>

      {/*
       * Anchored to the top, not centred: every step's heading starts at the same height, about
       * 40 px under the dashes as Duet's do, so the heading never jumps when a step is taller or
       * shorter than the last one.
       */}
      <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div
          className="mx-auto flex min-h-full w-full min-w-0 max-w-2xl flex-col justify-start px-4 pt-1.5 pb-6"
          data-onboarding-content=""
        >
          {children}
        </div>
      </main>

      {/*
       * A step taller than the screen scrolls under the button rather than being cut at it: the
       * fade above the footer says there is more, the way the film's tab bar does over Chat.
       */}
      <footer className="relative shrink-0 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),20px)] before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-linear-to-t before:from-duet-surface before:to-transparent">
        <div className="mx-auto flex w-full max-w-md flex-col gap-3">
          {notice}
          {footnote ? (
            <p
              className="line-clamp-4 px-2 text-center text-[13px] leading-[17px] text-duet-ink-3"
              data-onboarding-footnote=""
            >
              {footnote}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <button
              className={cn(
                "type-row flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full px-4 py-3 font-semibold outline-none transition-[filter,transform,opacity,background-color,color] focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-[0.98] disabled:opacity-50 disabled:hover:brightness-100 motion-reduce:transition-none",
                primary.done
                  ? "bg-duet-green-soft text-duet-green"
                  : "bg-duet-black text-duet-on-black hover:brightness-125",
              )}
              aria-busy={primary.pending ? true : undefined}
              data-done={primary.done ? "" : undefined}
              data-onboarding-primary=""
              data-pending={primary.pending ? "" : undefined}
              disabled={primary.disabled}
              onClick={primary.onClick}
              type="button"
            >
              {primary.done ? (
                <DuetIcon name="check" size={18} stroke={2.6} />
              ) : null}
              {primary.pending ? (
                <span
                  aria-hidden
                  className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
                />
              ) : null}
              {primary.label}
            </button>
            {secondary ? (
              <button
                className="type-row min-h-[52px] px-4 py-3 w-full rounded-full bg-duet-surface font-semibold text-duet-ink shadow-[inset_0_0_0_1px_var(--duet-hair)] outline-none transition-[background-color,transform] hover:bg-duet-tile focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-[0.98]"
                data-onboarding-secondary=""
                onClick={secondary.onClick}
                type="button"
              >
                {secondary.label}
              </button>
            ) : reserveSecondary ? (
              <div
                aria-hidden
                className="h-[52px]"
                data-onboarding-secondary-slot=""
              />
            ) : null}
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * Where somebody is, as short dashes with the current one filled.
 *
 * A progress bar to assistive technology, read as "Step 3 of 7": the dashes are a picture of that
 * sentence, so they are hidden and the sentence is what is announced.
 */
export function StepDashes({ index, total }: { index: number; total: number }) {
  return (
    <div
      aria-label="Onboarding progress"
      aria-valuemax={total}
      aria-valuemin={1}
      aria-valuenow={index + 1}
      aria-valuetext={`Step ${index + 1} of ${total}`}
      className="flex min-w-0 w-full max-w-[228px] items-center gap-[6px]"
      role="progressbar"
    >
      {Array.from({ length: total }, (_, at) => (
        <span
          aria-hidden
          className={cn(
            "h-1 min-w-0 flex-1 rounded-full transition-colors duration-[var(--duet-dur-enter)] motion-reduce:transition-none",
            at === index ? "bg-duet-ink" : "bg-duet-ink-3/35",
          )}
          data-current={at === index ? "" : undefined}
          // biome-ignore lint/suspicious/noArrayIndexKey: the dashes are positions, fixed in order.
          key={at}
        />
      ))}
    </div>
  );
}
