import { useCallback, useEffect, useRef, useState } from "react";
import { DURATION } from "@/lib/motion";

/** Past the longest exit, with room for a slow frame: a close is reported by then whatever happens. */
export const SHEET_EXIT_GRACE_MS = Math.round(DURATION.sheet * 1000) + 150;

/**
 * A sheet that stays on screen for as long as its parent draws it, with an entrance and an exit.
 *
 * WHY. Base UI plays a popup's entrance (`data-starting-style`) only when `open` turns true after
 * the dialog has mounted, and its exit (`data-ending-style`) only while the dialog is still mounted.
 * These sheets were drawn already open and closed by their parent unmounting them, so neither ever
 * played: each appeared, and vanished, between one frame and the next. This opens the sheet on the
 * frame after it mounts, and keeps it mounted through its exit before telling the parent it closed.
 *
 * `close(then)` starts the exit and runs `then` once the exit has finished: `onClose`, or what the
 * parent does once an answer is in, such as switching to the list the new task landed on. Only the
 * last `then` runs, once. An exit that never reports its end (a tab in the background, a test's DOM
 * with no animations to wait for) still runs it, once the longest exit has had time to play.
 */
export function useSheetPresence(): {
  /** For the dialog's root: false on the first frame, so the entrance plays. */
  open: boolean;
  close: (then: () => void) => void;
  /** For the dialog's root, which calls it when its entrance or exit has finished. */
  onOpenChangeComplete: (open: boolean) => void;
} {
  const [open, setOpen] = useState(false);
  const then = useRef<(() => void) | null>(null);
  useEffect(() => setOpen(true), []);
  const finish = useCallback(() => {
    const run = then.current;
    then.current = null;
    run?.();
  }, []);
  useEffect(() => {
    if (open || !then.current) return;
    const timer = setTimeout(finish, SHEET_EXIT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [open, finish]);
  const close = useCallback((after: () => void) => {
    then.current = after;
    setOpen(false);
  }, []);
  const onOpenChangeComplete = useCallback(
    (next: boolean) => {
      if (!next) finish();
    },
    [finish],
  );
  return { open, close, onOpenChangeComplete };
}
