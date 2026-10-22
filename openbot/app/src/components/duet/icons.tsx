import type { CSSProperties, ReactNode } from "react";

/**
 * The launch film's icon set (launch-film/film/src/duet/icons.tsx): line glyphs on the Lucide
 * 24-unit grid with round caps and joins, so every glyph in the shell shares one weight.
 */
export type DuetIconName =
  | "menu"
  | "plus"
  | "mic"
  | "arrowUp"
  | "arrowRight"
  | "chevronRight"
  | "check"
  | "checkCircle"
  | "mail"
  | "shield"
  | "shieldCheck"
  | "lock"
  | "clock"
  | "globe"
  | "chat"
  | "inbox"
  | "tasks"
  | "bulb"
  | "activity"
  | "eyeOff"
  | "waveform"
  | "wrench"
  | "question"
  | "x"
  | "stop";

const PATHS: Record<DuetIconName, ReactNode> = {
  menu: <path d="M4 7h16M4 12h16M4 17h10" />,
  plus: <path d="M5 12h14M12 5v14" />,
  mic: (
    <>
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
    </>
  ),
  arrowUp: <path d="m5 12 7-7 7 7M12 19V5" />,
  arrowRight: <path d="M5 12h14M12 5l7 7-7 7" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  check: <path d="M20 6 9 17l-5-5" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m8.5 12.2 2.4 2.4 4.8-5" />
    </>
  ),
  mail: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      <path d="m3 7 7.94 5.3a1.9 1.9 0 0 0 2.12 0L21 7" />
    </>
  ),
  shield: (
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  ),
  shieldCheck: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10.5" rx="2.5" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7v5l3.2 2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 2.5a14 14 0 0 0 0 19 14 14 0 0 0 0-19M2.5 12h19" />
    </>
  ),
  chat: <path d="M7.9 20A9 9 0 1 0 4 16.1L2.5 21.5z" />,
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  tasks: (
    <>
      <rect x="3" y="4" width="6" height="6" rx="1.5" />
      <path d="m3 17 2 2 4-4M13 5h8M13 12h8M13 19h8" />
    </>
  ),
  bulb: (
    <>
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6M10 22h4" />
    </>
  ),
  activity: (
    <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
  ),
  eyeOff: (
    <>
      <path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61" />
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M2 2l20 20" />
    </>
  ),
  waveform: <path d="M3 10v4M7.5 7v10M12 4v16M16.5 8v8M21 10.5v3" />,
  wrench: (
    <path d="M7 10h3v-3l-3.5-3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1-3 3l-6-6a6 6 0 0 1-8-8l3.5 3.5" />
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5M12 17.5h.01" />
    </>
  ),
  x: <path d="M18 6 6 18M6 6l12 12" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
};

export function DuetIcon({
  name,
  size = 24,
  stroke = 2,
  className,
  style,
}: {
  name: DuetIconName;
  size?: number;
  stroke?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden
      className={className}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={stroke}
      style={{ display: "block", flex: "none", ...style }}
      viewBox="0 0 24 24"
      width={size}
    >
      {PATHS[name]}
    </svg>
  );
}
