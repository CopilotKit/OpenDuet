import type { CSSProperties, ReactNode } from "react";

/**
 * The launch film's icon set (launch-film/film/src/duet/icons.tsx): line glyphs on the Lucide
 * 24-unit grid with round caps and joins, so every glyph in the shell shares one weight.
 *
 * One thin weight, as Duet draws (parity-spec 2.6): 1.6 at 24px and up, 1.8 below, never over 2
 * unless a caller has a reason it states.
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
  | "stop"
  | "page"
  | "chevronLeft"
  | "more"
  | "bolt"
  | "plug"
  | "box"
  | "repeat"
  | "settings"
  | "logout"
  | "bell"
  | "key"
  | "sun"
  | "moon"
  | "phone"
  | "shieldLock"
  | "reply"
  | "search"
  | "alert"
  | "file"
  | "pin"
  | "pinOff"
  | "trash"
  | "sort"
  | "calendar"
  | "sparkle"
  | "layout"
  | "deck"
  | "dashboard";

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
  page: (
    <>
      <path d="M14.5 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7.5z" />
      <path d="M14 2.5v4a1.5 1.5 0 0 0 1.5 1.5h4M8.5 13h7M8.5 17h5" />
    </>
  ),
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="0.6" />
      <circle cx="12" cy="12" r="0.6" />
      <circle cx="18.5" cy="12" r="0.6" />
    </>
  ),
  bolt: <path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z" />,
  plug: (
    <>
      <path d="M9 2.5v5M15 2.5v5" />
      <path d="M6 7.5h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 16.5v5" />
    </>
  ),
  box: (
    <>
      <path d="M21 8v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19V8" />
      <rect x="1.5" y="3.5" width="21" height="4.5" rx="1" />
      <path d="M10 12h4" />
    </>
  ),
  repeat: (
    <>
      <path d="m17 2.5 3.5 3.5L17 9.5" />
      <path d="M3.5 11.5V10a4 4 0 0 1 4-4h13" />
      <path d="m7 21.5-3.5-3.5L7 14.5" />
      <path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13" />
    </>
  ),
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  logout: (
    <path d="M9 21H5.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2H9M16 17l5-5-5-5M21 12H9" />
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="5" />
      <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  ),
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  phone: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="2.5" />
      <path d="M11 18h2" />
    </>
  ),
  reply: <path d="M6 4v7a4 4 0 0 0 4 4h9M15 11l4 4-4 4" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20.5 20.5-4.5-4.5" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  pin: (
    <>
      <path d="M12 17v5" />
      <path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2v.8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </>
  ),
  pinOff: (
    <>
      <path d="M12 17v5M15 9.3V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.9M2 2l20 20" />
      <path d="M9 9v1.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2v.8a1 1 0 0 0 1 1h11" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  file: (
    <>
      <path d="M14.5 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-12z" />
      <path d="M14 2.5v4a1.5 1.5 0 0 0 1.5 1.5h4" />
    </>
  ),
  shieldLock: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <rect x="9" y="11" width="6" height="5" rx="1" />
      <path d="M10.5 11V9.5a1.5 1.5 0 0 1 3 0V11" />
    </>
  ),
  sort: <path d="m21 16-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16" />,
  calendar: (
    <>
      <rect x="3" y="4.5" width="18" height="17" rx="2.5" />
      <path d="M8 2.5v4M16 2.5v4M3 10h18" />
    </>
  ),
  // Make: a four-point spark and a small one, for what the Bot makes.
  sparkle: (
    <>
      <path d="M10.6 3.6a.6.6 0 0 1 1.13 0l1.43 4.13a2 2 0 0 0 1.23 1.23l4.13 1.43a.6.6 0 0 1 0 1.13l-4.13 1.43a2 2 0 0 0-1.23 1.23l-1.43 4.13a.6.6 0 0 1-1.13 0l-1.43-4.13a2 2 0 0 0-1.23-1.23L4.4 12.12a.6.6 0 0 1 0-1.13l4.13-1.43a2 2 0 0 0 1.23-1.23z" />
      <path d="M19 15.5v5M21.5 18h-5" />
    </>
  ),
  // A page laid out: a header band and a column.
  layout: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M3 9h18M9 21V9" />
    </>
  ),
  // A deck: a slide on its stand.
  deck: (
    <>
      <path d="M2.5 3.5h19" />
      <path d="M20.5 3.5v10a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10M12 15.5V19M8 21l4-2 4 2" />
    </>
  ),
  // A dashboard: tiles of different heights.
  dashboard: (
    <>
      <rect x="3" y="3" width="7.5" height="9" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="5" rx="1.5" />
      <rect x="13.5" y="11" width="7.5" height="10" rx="1.5" />
      <rect x="3" y="15" width="7.5" height="6" rx="1.5" />
    </>
  ),
};

export function DuetIcon({
  name,
  size = 24,
  stroke = size >= 22 ? 1.6 : 1.8,
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
