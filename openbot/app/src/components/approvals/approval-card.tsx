import { AnimatePresence, motion } from "motion/react";
import {
  type ComponentProps,
  Fragment,
  type ReactNode,
  useId,
  useState,
} from "react";
import { DuetIcon, type DuetIconName } from "@/components/duet/icons";
import { DuetCard, OutcomePill, Rule, Tile } from "@/components/duet/kit";
import {
  approvalOutcome,
  approvalPlace,
  clockTime,
  decisionReceipt,
  describeApproval,
} from "@/lib/approval-view";
import type { ApprovalDecision, ApprovalRequest } from "@/lib/approvals";
import { DURATION, EASE_OUT } from "@/lib/motion";
import { useReducedMotionPreference } from "@/lib/reduced-motion";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<
  ReturnType<typeof describeApproval>["kind"],
  DuetIconName
> = {
  mail: "mail",
  browser: "globe",
  command: "wrench",
  other: "shield",
};

/** A pill button half the card wide, as the film draws Refuse and Allow once. */
export function PillButton({
  children,
  primary = false,
  className,
  ...props
}: ComponentProps<"button"> & { primary?: boolean }) {
  return (
    <button
      className={cn(
        "type-row inline-flex min-h-[46px] min-w-0 flex-1 basis-[7rem] items-center justify-center rounded-full px-4 py-2.5 font-semibold transition-[filter,transform,opacity,background-color] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-[0.98] disabled:opacity-50",
        primary
          ? "bg-duet-black text-duet-on-black hover:brightness-125"
          : "text-duet-ink shadow-[inset_0_0_0_1px_var(--duet-hair)] hover:bg-duet-tile",
        className,
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * One action a Bot wants to take, drawn the way the film draws the email it wants to send: what it
 * is, who it goes to, what it says, and the person's three answers. "Always allow" is a quiet text
 * button under the two, because it changes a rule rather than answering this one request.
 *
 * Once decided, the answers fold into a line saying who decided and when, and a pill says how it
 * ended. Everything the request carries stays one tap away under Details.
 *
 * Decided while the person watched, the line arrives the way a word swaps in, rising out of a short
 * blur, with its check landing, and the pill pops in beside the title. When the pill's word changes
 * after that, Allowed to Sent, it turns over in place. A card drawn already decided, read back from
 * history, is drawn still: `decidedNow` says the card was put up in place of a waiting one, which a
 * conversation does by drawing a new, folded card (inline-approval.tsx).
 */
export function ApprovalCard({
  request,
  botName,
  busy = false,
  error,
  onDecide,
  compact = false,
  decidedNow = false,
  className,
}: {
  request: ApprovalRequest;
  /** Said when the card is shown away from the Bot's own conversation. */
  botName?: string;
  busy?: boolean;
  error?: string | null;
  onDecide?: (choice: ApprovalDecision) => void;
  /** Only the title, the outcome and who decided: a decided card left in a conversation. */
  compact?: boolean;
  /** The request was decided while it was on screen, in a card this one replaces. */
  decidedNow?: boolean;
  className?: string;
}) {
  const view = describeApproval(request);
  const waiting = request.status === "pending";
  // Drawn waiting at some point, so a decision that comes in is one the person saw being made.
  const [sawWaiting, setSawWaiting] = useState(waiting);
  if (waiting && !sawWaiting) setSawWaiting(true);
  const arrives = decidedNow || sawWaiting;
  const reduced = useReducedMotionPreference();
  const handOff = request.action.policy?.behaviour === "hand_off";
  const outcome = approvalOutcome(request);
  const receipt = waiting ? null : decisionReceipt(request);
  const caption = [botName, view.app, approvalPlace(request)]
    .filter(Boolean)
    .join(" · ");

  return (
    <DuetCard
      aria-label={waiting ? "Waiting for your approval" : undefined}
      className={className}
      raised
      role={waiting ? "region" : undefined}
    >
      <div className="relative flex min-h-[54px] items-center gap-2.5 px-4 py-2.5">
        <Tile icon={KIND_ICON[view.kind]} size={32} />
        <div className="min-w-0 flex-1">
          <p className="type-row font-semibold">
            {handOff && waiting ? `This needs you: ${view.title}` : view.title}
          </p>
          {caption ? (
            <p className="type-label truncate text-duet-ink-3">{caption}</p>
          ) : null}
        </div>
        <AnimatePresence initial={arrives} mode="popLayout">
          {outcome ? (
            <motion.span
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              className="shrink-0"
              data-outcome={outcome.label}
              exit={
                reduced
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.9, filter: "blur(2px)" }
              }
              initial={
                reduced
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.85, filter: "blur(2px)" }
              }
              key={outcome.label}
              transition={{ duration: DURATION.swap, ease: EASE_OUT }}
            >
              <OutcomePill
                icon={outcome.tone === "green" ? "check" : null}
                tone={outcome.tone}
              >
                {outcome.label}
              </OutcomePill>
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>
      {compact ? null : (
        <ApprovalContent handOff={handOff} request={request} view={view} />
      )}
      {error ? (
        <p className="type-label px-4 pb-2 text-duet-red" role="alert">
          {error}
        </p>
      ) : null}
      {waiting && onDecide ? (
        <div className="px-4 pt-1 pb-3">
          <div className="flex flex-wrap gap-2">
            {handOff ? (
              <>
                <PillButton disabled={busy} onClick={() => onDecide("deny")}>
                  Don't do it
                </PillButton>
                <PillButton
                  disabled={busy}
                  onClick={() => onDecide("handled")}
                  primary
                >
                  I did it myself
                </PillButton>
              </>
            ) : (
              <>
                <PillButton disabled={busy} onClick={() => onDecide("deny")}>
                  Refuse
                </PillButton>
                <PillButton
                  disabled={busy}
                  onClick={() => onDecide("allow_once")}
                  primary
                >
                  Allow once
                </PillButton>
              </>
            )}
          </div>
          {handOff ? null : (
            <button
              className="type-sub mx-auto mt-1 flex h-11 items-center rounded-full px-3 font-medium text-duet-ink-2 transition-colors hover:text-duet-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40 disabled:opacity-50"
              disabled={busy}
              onClick={() => onDecide("allow_always")}
              type="button"
            >
              Always allow
            </button>
          )}
        </div>
      ) : null}
      <AnimatePresence initial={arrives}>
        {receipt ? (
          <motion.div
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            data-decided-line=""
            initial={
              reduced
                ? { opacity: 0 }
                : { opacity: 0, y: 4, filter: "blur(2px)" }
            }
            key="decided"
            transition={{ duration: DURATION.swap, ease: EASE_OUT }}
          >
            <DecidedLine
              at={request.decidedAt ?? null}
              landing={arrives}
              tone={request.decision === "deny" ? "red" : "green"}
            >
              {receipt}
            </DecidedLine>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </DuetCard>
  );
}

/** The fields, the body, why the Bot asked, and everything else it would send. */
function ApprovalContent({
  request,
  view,
  handOff,
}: {
  request: ApprovalRequest;
  view: ReturnType<typeof describeApproval>;
  handOff: boolean;
}) {
  const detailsId = useId();
  return (
    <>
      {view.fields.map((field) => (
        <Fragment key={field.label}>
          <Rule />
          <div className="flex min-h-[43px] items-baseline gap-2 px-4 py-2.5">
            <span className="type-sub w-[66px] shrink-0 font-medium text-duet-ink-3">
              {field.label}
            </span>
            <span className="type-sub min-w-0 font-medium [overflow-wrap:anywhere]">
              {field.value}
            </span>
          </div>
        </Fragment>
      ))}
      {view.body ? <ApprovalBody body={view.body} /> : null}
      {request.action.policy?.reason ? (
        <p className="type-label px-4 pt-1 pb-1 text-duet-ink-2">
          {handOff ? "Handed to you: " : ""}
          {request.action.policy.reason}
        </p>
      ) : null}
      <details className="group px-4 pb-1">
        <summary
          aria-controls={detailsId}
          className="type-label inline-flex min-h-11 cursor-pointer list-none items-center gap-1 py-1 font-medium text-duet-ink-3 outline-none focus-visible:underline [&::-webkit-details-marker]:hidden"
        >
          Details
          <DuetIcon
            className="transition-transform group-open:rotate-90"
            name="chevronRight"
            size={14}
            stroke={2.2}
          />
        </summary>
        <pre
          className="mt-1 mb-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-xl bg-duet-tile p-3 font-mono text-duet-ink-2 text-xs"
          id={detailsId}
        >
          {JSON.stringify(request.action.args, null, 2)}
        </pre>
      </details>
    </>
  );
}

/** A body past this many characters, or lines, starts folded with "Show all" under it. */
export const FOLD_CHARS = 600;
export const FOLD_LINES = 10;

/**
 * What the Bot would send, all of it, folded when it is long.
 *
 * It was a box of fixed height that scrolled, over a body the server had already cut to 280
 * characters: the card stopped mid-word, nothing said there was more, and Allow once sent the rest
 * unseen. The server now sends the whole body (approvals/service.ts `publicApproval`), and a long
 * one is folded rather than boxed: the whole text is on the page, cut off visibly at the fold with
 * a fade, and "Show all" under it says how much there is and opens it in place. Nothing is ever
 * held back from the page, so a screen reader reads it all, folded or not.
 */
function ApprovalBody({ body }: { body: string }) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const long = body.length > FOLD_CHARS || body.split("\n").length > FOLD_LINES;
  const folded = long && !open;
  return (
    <>
      <Rule />
      <p
        className={cn(
          "type-row whitespace-pre-wrap px-4 py-3 leading-6 [overflow-wrap:anywhere]",
          folded &&
            "max-h-60 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]",
        )}
        data-folded={folded ? "true" : undefined}
        id={bodyId}
      >
        {body}
      </p>
      {long ? (
        <button
          aria-controls={bodyId}
          aria-expanded={open}
          className="type-label mx-4 mb-1 inline-flex min-h-11 items-center gap-1 rounded-full font-semibold text-duet-ink-2 transition-colors hover:text-duet-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40"
          onClick={() => setOpen((shown) => !shown)}
          type="button"
        >
          {open
            ? "Show less"
            : `Show all ${body.length.toLocaleString()} characters`}
          <DuetIcon
            className={open ? "-rotate-90" : "rotate-90"}
            name="chevronRight"
            size={14}
            stroke={2.2}
          />
        </button>
      ) : null}
    </>
  );
}

function DecidedLine({
  children,
  at,
  tone,
  landing,
}: {
  children: ReactNode;
  at: string | null;
  tone: "green" | "red";
  /** Decided just now: the check lands as Tasks' does when a task is checked off. */
  landing: boolean;
}) {
  return (
    <div className="relative flex min-h-[52px] items-center gap-[9px] px-4">
      <div
        aria-hidden
        className="absolute top-0 right-4 left-4 h-px bg-duet-hair-2"
      />
      <span
        className={cn(
          tone === "green" ? "text-duet-green" : "text-duet-red",
          landing && "duet-check-land",
        )}
      >
        <DuetIcon
          name={tone === "green" ? "checkCircle" : "x"}
          size={20}
          stroke={2.2}
        />
      </span>
      <span className="type-sub font-semibold">{children}</span>
      {at ? (
        <span className="type-label ml-auto font-medium text-duet-ink-3">
          {clockTime(at)}
        </span>
      ) : null}
    </div>
  );
}
