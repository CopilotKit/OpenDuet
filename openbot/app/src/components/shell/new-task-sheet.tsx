import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PillButton } from "@/components/approvals/approval-card";
import { DuetIcon } from "@/components/duet/icons";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  saveForUpNextMutationOptions,
  startTaskMutationOptions,
} from "@/lib/tasks/mutations";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * The + on Tasks: a sheet on the frosted veil that asks what the Bot should do, with one field and
 * two answers. Start now opens it as a task straight away, in a conversation of its own, as asking
 * in Chat would. Save for Up next leaves it on Up next, marked as one the person asked for, to start
 * later. Either way the sheet closes and Tasks shows where it went.
 */
export function NewTaskSheet({
  bot,
  onClose,
  onAdded,
}: {
  bot: AgentProfile;
  onClose: () => void;
  /** It was added: `active` once started, `up_next` once saved. */
  onAdded: (where: "active" | "up_next") => void;
}) {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const start = useMutation(startTaskMutationOptions(queryClient));
  const save = useMutation(saveForUpNextMutationOptions(queryClient));
  const busy = start.isPending || save.isPending;
  const error = start.error ?? save.error;
  const instruction = draft.trim();
  const ask = { botId: bot.id, instruction };
  const question = `What should ${bot.name} do?`;
  const startNow = () => {
    if (!instruction || busy) return;
    save.reset();
    start.mutate(ask, { onSuccess: () => onAdded("active") });
  };
  return (
    <DialogPrimitive.Root
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      open
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="duet-veil fixed inset-0 z-50 transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <DialogPrimitive.Popup
          className={cn(
            "duet-face fixed inset-x-0 bottom-0 z-50 mx-auto w-full max-w-[430px] px-2.5 pb-[max(env(safe-area-inset-bottom),12px)] text-duet-ink outline-none",
            "transition-[opacity,translate] duration-300 ease-out data-ending-style:translate-y-6 data-ending-style:opacity-0 data-starting-style:translate-y-6 data-starting-style:opacity-0 motion-reduce:transition-none",
          )}
          initialFocus={field}
        >
          <div className="duet-glass rounded-[28px] p-4 shadow-duet-glass">
            <div className="flex items-start justify-between gap-3">
              <DialogPrimitive.Title className="type-title pt-1.5 pl-1 font-semibold">
                {question}
              </DialogPrimitive.Title>
              <button
                aria-label="Close"
                className="grid size-10 shrink-0 place-items-center rounded-full text-duet-ink-2 outline-none transition-colors hover:bg-duet-tile focus-visible:ring-3 focus-visible:ring-duet-violet/40 disabled:opacity-50"
                disabled={busy}
                onClick={onClose}
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
                maxLength={4000}
                onChange={(event) => setDraft(event.target.value)}
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
                    save.mutate(ask, { onSuccess: () => onAdded("up_next") });
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
