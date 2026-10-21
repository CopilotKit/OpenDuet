import type { ReactNode } from "react";

/**
 * A tab's scrolling body: it runs under the floating header, starting where the film's thread does,
 * and fades out above the tab bar.
 */
export function ScreenScroll({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-[100px] pb-8">
        {children}
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-[linear-gradient(transparent,var(--duet-surface))]"
      />
    </div>
  );
}

/** The tab's name and one line on what it holds. */
export function ScreenTitle({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="mb-4 px-1">
      <h1 className="type-title font-semibold text-duet-ink">{title}</h1>
      {children ? (
        <p className="type-sub mt-0.5 text-duet-ink-2">{children}</p>
      ) : null}
    </header>
  );
}
