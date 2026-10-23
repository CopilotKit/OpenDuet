/*
 * Gmail's and Google Calendar's own marks, drawn inline so they stay crisp at any size and need no
 * request: the onboarding step that connects them and the setup checklist's Gmail row show the apps
 * a person recognises, not a generic envelope. Their colours are Google's and do not change with the
 * theme; both marks read on a light or a dark surface as they are.
 */

/** Gmail's multicolour "M". */
export function GmailLogo({ size = 24 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      data-logo="gmail"
      height={size}
      viewBox="52 42 88 66"
      width={size}
    >
      <path d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" fill="#4285f4" />
      <path d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" fill="#34a853" />
      <path d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" fill="#fbbc04" />
      <path d="M72 74V48l24 18 24-18v26L96 92" fill="#ea4335" />
      <path
        d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2"
        fill="#c5221f"
      />
    </svg>
  );
}

/** Google Calendar's square with the day, "31". */
export function GoogleCalendarLogo({ size = 24 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      data-logo="google-calendar"
      height={size}
      viewBox="0 0 200 200"
      width={size}
    >
      <g transform="translate(3.75 3.75)">
        <path
          d="M148.882 43.618l-47.368-5.263-57.895 5.263-5.264 52.632 5.263 52.632 52.632 6.579 52.632-6.579 5.263-53.947z"
          fill="#fff"
        />
        <path
          d="M65.211 125.276c-3.934-2.658-6.658-6.539-8.145-11.671l9.132-3.763c.829 3.158 2.276 5.605 4.342 7.342 2.053 1.737 4.553 2.592 7.474 2.592 2.987 0 5.553-.908 7.697-2.724s3.224-4.132 3.224-6.934c0-2.868-1.132-5.211-3.395-7.026s-5.105-2.724-8.5-2.724h-5.276v-9.039H76.5c2.921 0 5.382-.789 7.382-2.368 2-1.579 3-3.737 3-6.487 0-2.447-.895-4.395-2.684-5.855s-4.053-2.197-6.803-2.197c-2.684 0-4.816.711-6.395 2.145s-2.724 3.197-3.447 5.276l-9.039-3.763c1.197-3.395 3.395-6.395 6.618-8.987 3.224-2.592 7.342-3.895 12.342-3.895 3.697 0 7.026.711 9.974 2.145 2.947 1.434 5.263 3.421 6.934 5.947 1.671 2.539 2.5 5.382 2.5 8.539 0 3.224-.776 5.947-2.329 8.184-1.553 2.237-3.461 3.947-5.724 5.145v.539c2.987 1.25 5.421 3.158 7.342 5.724 1.908 2.566 2.868 5.632 2.868 9.211s-.908 6.776-2.724 9.579c-1.816 2.803-4.329 5.013-7.513 6.618-3.197 1.605-6.789 2.421-10.776 2.421-4.618.013-8.881-1.316-12.815-3.974z"
          fill="#1a73e8"
        />
        <path
          d="M121.25 79.961l-9.974 7.25-5.013-7.605 17.987-12.974h6.895v61.197h-9.895z"
          fill="#1a73e8"
        />
        <path
          d="M148.882 196.25l47.368-47.368-23.684-10.526-23.684 10.526-10.526 23.684z"
          fill="#ea4335"
        />
        <path
          d="M33.092 172.566l10.526 23.684h105.263v-47.368H43.618z"
          fill="#34a853"
        />
        <path
          d="M12.039-3.75C3.316-3.75-3.75 3.316-3.75 12.039v136.842l23.684 10.526 23.684-10.526V43.618h105.263l10.526-23.684L148.882-3.75z"
          fill="#4285f4"
        />
        <path
          d="M-3.75 148.882v31.579c0 8.724 7.066 15.789 15.789 15.789h31.579v-47.368z"
          fill="#188038"
        />
        <path
          d="M148.882 43.618v105.263h47.368V43.618l-23.684-10.526z"
          fill="#fbbc04"
        />
        <path
          d="M196.25 43.618V12.039c0-8.724-7.066-15.789-15.789-15.789h-31.579v47.368z"
          fill="#1967d2"
        />
      </g>
    </svg>
  );
}

/** Gmail and Google Calendar side by side, as one row connects both with one consent. */
export function GmailAndCalendarLogos({ size = 24 }: { size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <GmailLogo size={size} />
      <GoogleCalendarLogo size={size} />
    </span>
  );
}
