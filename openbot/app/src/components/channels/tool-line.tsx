import type { ReactNode } from "react";
import { DuetIcon, type DuetIconName } from "@/components/duet/icons";
import { cn } from "@/lib/utils";

/**
 * One line for one thing a Bot did.
 *
 * Every tool call in the transcript draws through this, so a browser action, an MCP call and a
 * refusal read as the same kind of event. Detail stays behind a disclosure so the transcript keeps a
 * single-line action rhythm.
 *
 * While it is still running the text shimmers, which is the only signal that the Bot is working on
 * something with nothing to show yet.
 */
export function ToolLine({
  icon,
  label,
  detail,
  running,
  refused,
  failed,
  declined,
  children,
}: {
  /** Drawn before the label, small and muted. A group of steps puts its kinds here. */
  icon?: ReactNode;
  /** What was done, in a couple of words: "Searched Slack", "Filled in", "Read the page". */
  label: string;
  /** What it was done to. Muted, and truncated rather than wrapped. */
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
  /** The person said no on its card, so it was not done. Their decision, not a failure. */
  declined?: boolean;
  /** Shown when the line is expanded. Without it the line is not expandable. */
  children?: ReactNode;
}) {
  const tone = refused
    ? "text-duet-red"
    : failed
      ? "text-duet-amber"
      : "text-duet-ink-2";
  /*
   * The film's topic label: a hairline hook, then a glyph saying how it went (a green check once
   * done), then what was done. The group's own kinds come after the label, where they no longer
   * compete with the outcome.
   */
  const glyph: DuetIconName =
    refused || declined
      ? "x"
      : failed
        ? "x"
        : running
          ? "clock"
          : "checkCircle";
  const text = (
    <span className="duet-face inline-flex min-w-0 max-w-full items-center gap-[7px]">
      <svg
        aria-hidden
        className="mt-[9px] shrink-0 text-duet-ink-3"
        height={14}
        viewBox="0 0 14 14"
        width={14}
      >
        <path
          d="M1 13V7a6 6 0 0 1 6-6h6"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={1.2}
        />
      </svg>
      <span
        className={cn(
          "shrink-0",
          refused || failed
            ? tone
            : running
              ? "text-duet-ink-3"
              : "text-duet-green",
        )}
      >
        <DuetIcon name={glyph} size={16} stroke={2.2} />
      </span>
      <span
        className={cn(
          "type-sub inline-flex min-w-0 items-baseline gap-1.5 font-medium",
          tone,
          running && "tool-line-running",
        )}
      >
        {/* Cut with an ellipsis rather than run past its row: a summary can be long. */}
        <span className="min-w-0 truncate">
          {declined
            ? `You declined: ${label}`
            : refused
              ? `Blocked: ${label}`
              : failed
                ? `${label}, didn't work`
                : label}
        </span>
        {detail ? (
          <span className="truncate font-medium opacity-70">{detail}</span>
        ) : null}
      </span>
      {icon ? (
        <span className="shrink-0 self-center text-duet-ink-3">{icon}</span>
      ) : null}
    </span>
  );

  if (!children) return <div className="pl-1">{text}</div>;

  return (
    <details className="tool-line min-w-0 pl-1">
      {/*
       * The summary IS the line. No marker of its own: the chevron after the label says it opens.
       */}
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
        {text}
        <span
          aria-hidden
          className="tool-line-chevron shrink-0 text-duet-ink-3 text-xs transition-transform"
        >
          ▸
        </span>
      </summary>
      {/*
       * Indented to the label, past the hook and the glyph, so the detail reads as belonging to it.
       */}
      <div className="mt-2 ml-[45px] max-h-80 overflow-auto border-duet-hair border-l pl-3 type-caption text-duet-ink-2 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium">
        {children}
      </div>
    </details>
  );
}
