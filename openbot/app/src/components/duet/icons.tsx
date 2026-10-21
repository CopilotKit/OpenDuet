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

/**
 * The CopilotKit kite, the app's mark until OpenDuet has its own. `optical` nudges it left: the sail
 * sits right of the box's centre, and a centred box reads off-centre inside a circle.
 */
export function KiteMark({
  size = 24,
  id,
  optical = false,
}: {
  size?: number;
  /** Prefixes the gradient ids, which must be unique in the document. */
  id: string;
  optical?: boolean;
}) {
  const g = (n: number) => `${id}-k${n}`;
  return (
    <svg
      aria-hidden
      fill="none"
      height={size}
      style={{
        display: "block",
        flex: "none",
        transform: optical ? `translateX(${-0.088 * size}px)` : undefined,
      }}
      viewBox="0 0 22 27"
      width={(size * 22) / 27}
    >
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={g(0)}
          x1="15.5372"
          x2="12.0802"
          y1="5.0278"
          y2="14.534"
        >
          <stop stopColor="#6430AB" />
          <stop offset="1" stopColor="#AA89D8" />
        </linearGradient>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={g(1)}
          x1="12.8583"
          x2="8.40764"
          y1="10.3858"
          y2="18.9846"
        >
          <stop stopColor="#005DBB" />
          <stop offset="1" stopColor="#3D92E8" />
        </linearGradient>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={g(2)}
          x1="14.8452"
          x2="13.5047"
          y1="5.02774"
          y2="9.21911"
        >
          <stop stopColor="#1B70C4" />
          <stop offset="1" stopColor="#54A4F2" />
        </linearGradient>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={g(3)}
          x1="4.85806"
          x2="18.9963"
          y1="24.2455"
          y2="24.2455"
        >
          <stop stopColor="#4497EA" />
          <stop offset="0.25" stopColor="#1463B2" />
          <stop offset="0.5" stopColor="#0A437D" />
          <stop offset="0.67" stopColor="#2476C8" />
          <stop offset="0.97" stopColor="#0C549A" />
        </linearGradient>
      </defs>
      <path
        d="M6.36084 10.9855C8.34277 8.393 9.98843 5.82939 10.6204 3.75914C10.6382 3.70281 10.7043 3.67888 10.7534 3.7114C12.9536 5.16894 16.9635 6.12833 20.5086 6.15085C20.5703 6.15124 20.6124 6.2114 20.5895 6.26829C19.4109 9.25938 17.9705 14.6189 17.9148 20.7392C17.9148 20.8301 17.7873 20.8627 17.7419 20.7837C15.7236 17.2522 9.26021 12.2898 6.39414 11.1186C6.34112 11.0968 6.32556 11.0313 6.36084 10.9855Z"
        fill={`url(#${g(0)})`}
      />
      <path
        d="M13.0475 9.39974C9.95016 10.3806 7.11935 10.9259 6.44331 11.0498C6.40027 11.0577 6.39115 11.1172 6.43152 11.134C9.3203 12.3347 15.7516 17.2826 17.7511 20.7998C17.7551 20.8075 17.7647 20.8103 17.7728 20.8068C17.7809 20.803 17.7853 20.793 17.7819 20.7844L13.0475 9.39974Z"
        fill={`url(#${g(1)})`}
      />
      <path
        d="M10.762 3.705C13.4137 5.15161 16.4787 5.80132 20.545 6.14367C20.5703 6.14585 20.5787 6.18008 20.5557 6.19197C20.0359 6.45923 17.0574 7.97512 14.8455 8.78701C14.2524 9.00453 13.6564 9.20632 13.0692 9.39249C13.0562 9.39656 13.0419 9.39015 13.0369 9.37774L10.7005 3.75979C10.6849 3.72196 10.7257 3.68538 10.762 3.705Z"
        fill={`url(#${g(2)})`}
      />
      <path
        d="M10.7145 3.79041L17.8305 20.7659"
        stroke="#513C9F"
        strokeLinecap="round"
        strokeWidth="0.17284"
      />
      <path
        d="M6.44531 11.0476C6.44531 11.0476 10.375 10.3422 14.0686 9.06804C17.7623 7.7939 20.5122 6.23373 20.5122 6.23373"
        stroke="#513C9F"
        strokeLinecap="round"
        strokeWidth="0.17284"
      />
      <path
        d="M11.6914 5.93518L9.05534 14.7068M9.05534 14.7068H15.3203M9.05534 14.7068L0.15625 26.3646"
        stroke="#ABABAB"
        strokeLinecap="round"
        strokeWidth="0.302474"
      />
      <path
        d="M6.02539 23.9646L4.85806 24.1287C5.46272 25.7287 6.70381 26.4276 8.18528 26.4276C11.8147 26.4276 10.707 22.3227 12.8103 22.3227C14.3358 22.3227 13.7155 25.6498 16.9992 25.6498C19.0029 25.6498 19.2028 23.631 18.8607 22.7625C18.8589 22.7572 18.8568 22.7524 18.8538 22.7476L18.3166 21.9253C18.2817 21.8706 18.1968 21.8912 18.1907 21.9562L18.0908 22.9529C18.0838 23.0222 18.0857 23.0913 18.0936 23.1605C18.1764 23.8491 18.2291 25.5202 16.9992 25.5202C15.7015 25.5202 15.3895 22.2362 12.8103 22.2362C9.78393 22.2362 10.1726 26.298 8.31487 26.298C7.08938 26.298 6.15447 24.9153 6.02539 23.9646Z"
        fill={`url(#${g(3)})`}
      />
    </svg>
  );
}
