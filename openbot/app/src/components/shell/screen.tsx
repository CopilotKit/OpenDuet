import type { ReactNode } from "react";

/**
 * A tab's scrolling body: it runs under the floating header, starting where the film's thread does,
 * and on under the frosted tab bar, ending far enough below it that the last row can scroll clear.
 */
export function ScreenScroll({
  children,
  overlay,
}: {
  children: ReactNode;
  /** What floats over the screen and does not scroll with it, such as Tasks' + button. */
  overlay?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-[100px] pb-[calc(var(--duet-tab-space,0px)+32px)]">
        {children}
      </div>
      {overlay}
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
      <h1 className="type-display font-semibold text-duet-ink">{title}</h1>
      {children ? (
        <p className="type-sub mt-0.5 text-duet-ink-2">{children}</p>
      ) : null}
    </header>
  );
}
