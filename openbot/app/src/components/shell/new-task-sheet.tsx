import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { PillButton } from "@/components/approvals/approval-card";
import { DuetIcon } from "@/components/duet/icons";
import { useSheetPresence } from "@/hooks/use-sheet-presence";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  saveForUpNextMutationOptions,
  startTaskMutationOptions,
} from "@/lib/tasks/mutations";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/** Where the caret goes in a starter line: on its "…", selected, so typing replaces it. */
export const STARTER_BLANK = "…";

/**
 * The + on Tasks: a sheet on the frosted veil that asks what the Bot should do, with one field and
 * two answers. Start now opens it as a task straight away, in a conversation of its own, as asking
 * in Chat would. Save for Up next leaves it on Up next, marked as one the person asked for, to start
 * later. Either way the sheet closes and Tasks shows where it went.
 *
 * Make's + opens the same sheet with a starter line, such as "Make a deck about …", and the "…"
 * selected, so the person only types what it is about. A starter left as it was is not an ask yet.
 *
 * It rises from below the screen's edge onto the veil, and sinks back before `onClose` or `onAdded`
 * is called, so the parent never takes it away mid-motion (use-sheet-presence.ts). With reduced
 * motion it fades in place.
 */
export function NewTaskSheet({
  bot,
  onClose,
  onAdded,
  starter = "",
  question: asked,
  instructionPrefix = "",
}: {
  bot: AgentProfile;
  onClose: () => void;
  /** It was added: `active` once started, `up_next` once saved. */
  onAdded: (where: "active" | "up_next", task: { id: string } | null) => void;
  /** The field's first words, with the caret on their "…". */
  starter?: string;
  /** The sheet's question, when it is not what the Bot should do. */
  question?: string;
  /** Context the task needs, kept outside the person’s editable ask. */
  instructionPrefix?: string;
}) {
  const [draft, setDraft] = useState(starter);
  const field = useRef<HTMLTextAreaElement>(null);
  const start = useMutation(startTaskMutationOptions(queryClient));
  const save = useMutation(saveForUpNextMutationOptions(queryClient));
  const presence = useSheetPresence();
  const busy = start.isPending || save.isPending;
  const error = start.error ?? save.error;
  const instruction = draft.trim() === starter.trim() ? "" : draft.trim();
  const ask = {
    botId: bot.id,
    instruction: [instructionPrefix, instruction].filter(Boolean).join("\n\n"),
  };
  const question = asked ?? `What should ${bot.name} do?`;
  /*
   * The caret on the starter's blank: set before the field takes focus, and again as it does, since
   * focusing a field can put its caret back at the start.
   */
  const placed = useRef(false);
  const placeCaret = () => {
    const element = field.current;
    const blank = starter.lastIndexOf(STARTER_BLANK);
    if (!element || blank < 0 || placed.current) return;
    element.setSelectionRange(blank, blank + STARTER_BLANK.length);
  };
  useLayoutEffect(placeCaret);
  const startNow = () => {
    if (!instruction || busy) return;
    save.reset();
    start.mutate(ask, {
      onSuccess: (task) => presence.close(() => onAdded("active", task)),
    });
  };
  return (
    <DialogPrimitive.Root
      onOpenChange={(next) => {
        if (!next && !busy) presence.close(onClose);
      }}
      onOpenChangeComplete={presence.onOpenChangeComplete}
      open={presence.open}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="duet-veil fixed inset-0 z-50 transition-opacity duration-[var(--duet-dur-enter)] data-ending-style:duration-[var(--duet-dur-swap)] data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup
          className={cn(
            "duet-face fixed inset-x-0 bottom-0 z-50 mx-auto max-h-dvh w-full max-w-[430px] overflow-y-auto overscroll-contain px-2.5 pb-[max(env(safe-area-inset-bottom),12px)] text-duet-ink outline-none",
            "transition-[opacity,translate] motion-safe:duration-[var(--duet-dur-sheet)] motion-safe:data-ending-style:duration-[var(--duet-dur-enter)] motion-safe:data-ending-style:translate-y-full motion-safe:data-starting-style:translate-y-full motion-reduce:duration-[var(--duet-dur-swap)] motion-reduce:data-ending-style:opacity-0 motion-reduce:data-starting-style:opacity-0",
          )}
          initialFocus={field}
        >
          <div className="duet-glass rounded-[28px] p-4 shadow-duet-glass">
            <div className="flex items-start justify-between gap-3">
              <DialogPrimitive.Title className="type-title min-w-0 flex-1 pt-1.5 pl-1 font-semibold [overflow-wrap:anywhere]">
                {question}
              </DialogPrimitive.Title>
              <button
                aria-label="Close"
                className="grid size-11 shrink-0 place-items-center rounded-full text-duet-ink-2 outline-none transition-colors hover:bg-duet-tile focus-visible:ring-3 focus-visible:ring-duet-violet/40 disabled:opacity-50"
                disabled={busy}
                onClick={() => presence.close(onClose)}
                type="button"
              >
                <DuetIcon name="x" size={20} stroke={2.1} />
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                startNow();
              }}
            >
              <textarea
                aria-label={question}
                className="type-body mt-3 min-h-28 w-full resize-none rounded-[20px] bg-duet-card px-4 py-3 text-duet-ink shadow-[inset_0_0_0_1px_var(--duet-hair)] outline-none placeholder:text-duet-ink-3 focus-visible:ring-3 focus-visible:ring-duet-violet/25"
                disabled={busy}
                maxLength={
                  4000 - (instructionPrefix ? instructionPrefix.length + 2 : 0)
                }
                onChange={(event) => setDraft(event.target.value)}
                onFocus={() => {
                  placeCaret();
                  placed.current = true;
                }}
                onKeyDown={(event) => {
                  // ⌘ or Ctrl with Enter starts it, as a keyboard sends from Chat's composer.
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    startNow();
                  }
                }}
                placeholder="Draft a reply, find a time, chase a payment…"
                ref={field}
                value={draft}
              />
              {error ? (
                <p className="type-label mt-2 px-1 text-duet-red" role="alert">
                  {error.message}
                </p>
              ) : null}
              <div className="mt-3 flex gap-2">
                <PillButton
                  disabled={busy || !instruction}
                  onClick={() => {
                    start.reset();
                    save.mutate(ask, {
                      onSuccess: () =>
                        presence.close(() => onAdded("up_next", null)),
                    });
                  }}
                >
                  Save for Up next
                </PillButton>
                <PillButton
                  disabled={busy || !instruction}
                  primary
                  type="submit"
                >
                  Start now
                </PillButton>
              </div>
            </form>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
