import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PillButton } from "@/components/approvals/approval-card";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { clockTime } from "@/lib/approval-view";
import {
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
  waitingOnYou,
} from "@/lib/approvals";
import { useSheetPresence } from "@/hooks/use-sheet-presence";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { DuetIcon } from "./icons";

/*
 * A question a Bot asked outside any task, opened from its row under Tasks › Needs input, as a page
 * of its own: × at the top left, who asks across the header, the question and why it is asked, and
 * a box for the answer. Sending it carries the Bot's run on with the answer and closes the page; the
 * row leaves Needs input once the inbox is read again.
 *
 * Drawn in the same frame as a task's page (task-sheet.tsx), so the two read as one kind of thing.
 */

export function QuestionSheet({
  questionId,
  onClose,
}: {
  questionId: string;
  onClose: () => void;
}) {
  const inbox = useQuery(approvalInboxOptions());
  const agents = useQuery(agentListQueryOptions());
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const [draft, setDraft] = useState("");
  const popup = useRef<HTMLDivElement>(null);
  // Fades out and sinks a little before the route closes it (use-sheet-presence.ts).
  const presence = useSheetPresence();
  const close = () => presence.close(onClose);
  const question = waitingOnYou(inbox.data).questions.find(
    (item) => item.id === questionId,
  );
  const botName = question
    ? (agents.data?.find((agent) => agent.id === question.botId)?.name ??
      question.botId)
    : null;
  const send = () => {
    const response = draft.trim();
    if (!question || !response || answer.isPending) return;
    answer.mutate({ id: question.id, response }, { onSuccess: close });
  };

  return (
    <DialogPrimitive.Root
      onOpenChange={(next) => {
        if (!next) close();
      }}
      onOpenChangeComplete={presence.onOpenChangeComplete}
      open={presence.open}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          aria-modal="true"
          className={cn(
            "duet-veil duet-face group fixed inset-0 z-50 flex flex-col text-duet-ink outline-none",
            "transition-opacity duration-[var(--duet-dur-enter)] data-ending-style:duration-[var(--duet-dur-swap)] data-ending-style:opacity-0 data-starting-style:opacity-0",
          )}
          initialFocus={popup}
          ref={popup}
        >
          <div className="mx-auto flex min-h-0 w-full max-w-[430px] flex-1 flex-col px-2.5 pt-[max(env(safe-area-inset-top),12px)] pb-[max(env(safe-area-inset-bottom),10px)]">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] bg-duet-card shadow-duet-raised transition-transform duration-[var(--duet-dur-sheet)] group-data-ending-style:duration-[var(--duet-dur-swap)] motion-reduce:transition-none motion-safe:group-data-ending-style:translate-y-3 motion-safe:group-data-starting-style:translate-y-6">
              <header className="grid min-h-16 shrink-0 grid-cols-[44px_1fr_44px] items-center px-2 py-1">
                <button
                  aria-label="Close"
                  className="grid size-[44px] place-items-center rounded-full text-duet-ink outline-none transition-colors hover:bg-duet-tile focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:bg-duet-tile"
                  onClick={close}
                  type="button"
                >
                  <DuetIcon name="x" size={22} stroke={2.1} />
                </button>
                <DialogPrimitive.Title className="type-row min-w-0 truncate px-1 text-center font-semibold">
                  {botName ? `${botName} asks` : "Question"}
                </DialogPrimitive.Title>
                <span aria-hidden />
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
                {inbox.isPending ? null : inbox.error ? (
                  <p className="type-sub text-duet-red" role="alert">
                    Couldn't open this question. Close it and try again.
                  </p>
                ) : !question ? (
                  <p className="type-sub text-duet-ink-2" role="status">
                    This question has been answered.
                  </p>
                ) : (
                  <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      send();
                    }}
                  >
                    <p className="type-sub">
                      <span className="text-duet-amber">Needs input</span>
                      <span className="text-duet-ink-3">
                        {" · "}
                        {clockTime(question.createdAt)}
                      </span>
                    </p>
                    <p className="type-row whitespace-pre-wrap font-semibold leading-6 [overflow-wrap:anywhere]">
                      {question.question}
                    </p>
                    {question.why ? (
                      <p className="type-sub text-duet-ink-2">{question.why}</p>
                    ) : null}
                    <textarea
                      aria-label="Your answer"
                      className="type-sub mt-2 min-h-28 w-full resize-none rounded-[22px] bg-duet-tile px-4 py-3 text-duet-ink outline-none placeholder:text-duet-ink-3 focus-visible:ring-3 focus-visible:ring-duet-violet/25"
                      disabled={answer.isPending}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder={`Reply to ${botName ?? "the Bot"}`}
                      value={draft}
                    />
                    {answer.error ? (
                      <p className="type-label text-duet-red" role="alert">
                        {answer.error.message}
                      </p>
                    ) : null}
                    <div className="flex">
                      <PillButton
                        disabled={answer.isPending || !draft.trim()}
                        primary
                        type="submit"
                      >
                        Send answer
                      </PillButton>
                    </div>
                  </form>
                )}
              </div>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
