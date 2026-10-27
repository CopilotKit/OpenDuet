import type { ComponentProps } from "react";
import { DuetCard } from "@/components/duet/kit";
import type { ProactiveSuggestion } from "@/lib/proactive";
import { cn } from "@/lib/utils";
import { SwipeToAnswer } from "./swipe-to-answer";

/** What a card shows of a suggestion. */
export type CardSuggestion = Pick<
  ProactiveSuggestion,
  "title" | "detail" | "sourceApp"
>;

/** Start or hide. `comeBack` puts a card a drag sent off back in place when the answer fails. */
export type AnswerSuggestion = (
  action: "start" | "dismiss",
  comeBack?: () => void,
) => void;

/**
 * A suggested next step as one card: who could take it on, the title, two lines of why, where it
 * came from, and Hide and Start. Chat draws it above the composer, and in the thread where a
 * check-in offers it. While it is open a finger or a mouse also slides it off: right to start it,
 * left to hide it. Once it was answered, anywhere, the buttons give way to a quiet line saying which.
 */
export function SuggestionCard({
  heading,
  suggestion,
  answered,
  busy = false,
  error,
  glass = false,
  onAnswer,
}: {
  heading: string;
  suggestion: CardSuggestion;
  /** What became of it. Absent while it is still open. */
  answered?: "started" | "hidden";
  /** True while an answer is on its way, from either a drag or a button. */
  busy?: boolean;
  error?: string | null;
  /** The dock's glass, for a card that floats over the conversation. */
  glass?: boolean;
  onAnswer: AnswerSuggestion;
}) {
  const face = (
    <DuetCard
      aria-label={heading}
      className="px-4 py-3"
      glass={glass}
      role="region"
    >
      <p className="type-label font-semibold text-duet-violet">{heading}</p>
      <p className="type-row mt-0.5 font-semibold [overflow-wrap:anywhere]">
        {suggestion.title}
      </p>
      {suggestion.detail ? (
        <p className="type-sub line-clamp-2 text-duet-ink-2 [overflow-wrap:anywhere]">
          {suggestion.detail}
        </p>
      ) : null}
      {suggestion.sourceApp ? (
        <p className="type-label mt-0.5 text-duet-ink-3">
          From {suggestion.sourceApp}
        </p>
      ) : null}
      {error ? (
        <p className="type-label mt-1 text-duet-red" role="alert">
          {error}
        </p>
      ) : null}
      {answered ? (
        <p
          role="status"
          className={cn(
            "type-label mt-2 font-semibold",
            answered === "started" ? "text-duet-green" : "text-duet-ink-3",
          )}
        >
          {answered === "started" ? "Started" : "Hidden"}
        </p>
      ) : (
        <div className="mt-2.5 flex gap-2">
          <SmallPill disabled={busy} onClick={() => onAnswer("dismiss")}>
            Hide
          </SmallPill>
          <SmallPill disabled={busy} onClick={() => onAnswer("start")} primary>
            Start
          </SmallPill>
        </div>
      )}
    </DuetCard>
  );
  // An answered card stays where it was, as a record; only an open one can be slid off.
  if (answered) return <div className="mb-2.5">{face}</div>;
  return (
    <SwipeToAnswer
      disabled={busy}
      onHide={(comeBack) => onAnswer("dismiss", comeBack)}
      onStart={(comeBack) => onAnswer("start", comeBack)}
    >
      {face}
    </SwipeToAnswer>
  );
}

/** Hide or Start on a suggestion's card, sharing the card's width; Start in black. */
export function SmallPill({
  primary = false,
  ...props
}: ComponentProps<"button"> & { primary?: boolean }) {
  return (
    <button
      className={cn(
        "type-label min-h-11 flex-1 rounded-full px-3 py-2 font-semibold transition-[filter,transform,opacity,background-color] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-[0.98] disabled:opacity-50",
        primary
          ? "bg-duet-black text-duet-on-black hover:brightness-125"
          : "text-duet-ink shadow-[inset_0_0_0_1px_var(--duet-hair)] hover:bg-duet-tile",
      )}
      type="button"
      {...props}
    />
  );
}
