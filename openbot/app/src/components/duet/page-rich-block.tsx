// biome-ignore-all lint/suspicious/noArrayIndexKey: saved block rows and columns keep their order and may repeat values.
import {
  CURRENT_SLIDE_LAYOUT,
  type RichBlockShape,
  type SlideLayoutVersion,
  slideTableWidth,
  TAP_TARGET,
} from "@openbot/shared/slide-fit";
import { sanitizeThumbnail } from "@openbot/shared/thumbnail";
import { cn } from "@/lib/utils";

/** Sanitized static SVG. The shared allowlist runs again at the browser boundary. */
export function SafeSvg({
  svg,
  label,
  className,
}: {
  svg: string | null | undefined;
  label?: string;
  className?: string;
}) {
  const safe = sanitizeThumbnail(svg);
  if (!safe) return null;
  return (
    <div
      aria-label={label}
      aria-hidden={!label || undefined}
      role="img"
      className={cn(
        "[&_svg]:h-full [&_svg]:w-full [&_svg]:overflow-hidden",
        className,
      )}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: only the strict shared static-SVG allowlist reaches this boundary.
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

/** Rich blocks use the same content on a page and a slide; compact measurements live in slide-fit. */
export function RichBlock({
  block,
  compact = false,
  scale = 1,
  layoutVersion = CURRENT_SLIDE_LAYOUT,
  onCheck,
}: {
  block: RichBlockShape;
  compact?: boolean;
  /** The enclosing slide transform; checklist labels stay at least 44px on screen. */
  scale?: number;
  layoutVersion?: SlideLayoutVersion;
  onCheck?: ((item: string, checked: boolean) => void) | undefined;
}) {
  const type = compact
    ? "text-[13px] leading-[16px]"
    : "type-body leading-relaxed";
  const wrapper = cn(
    type,
    "min-w-0 text-duet-ink [overflow-wrap:anywhere]",
    !compact && "mt-6 first:mt-0",
  );
  switch (block.type) {
    case "timeline":
      return (
        <ol className={wrapper}>
          {block.items.map((item, index) => (
            <li
              key={`${item.date}-${index}`}
              className="relative border-[var(--page-accent,var(--duet-violet))] border-l-2 pb-3 pl-[18px]"
            >
              <span
                aria-hidden
                className="absolute top-1 -left-[5px] size-2 rounded-full bg-[var(--page-accent,var(--duet-violet))]"
              />
              <p className="font-semibold text-[var(--page-accent,var(--duet-violet))]">
                {item.date}
              </p>
              <p className="font-semibold">{item.title}</p>
              {item.text ? (
                <p className="text-duet-ink-2">{item.text}</p>
              ) : null}
            </li>
          ))}
        </ol>
      );
    case "checklist":
      return (
        <ul className={wrapper}>
          {block.items.map((item) => (
            <li key={item.id}>
              <label
                className="flex min-h-11 items-center gap-3 py-2"
                style={
                  compact
                    ? {
                        minHeight: `max(2.75rem, ${Math.ceil(TAP_TARGET / scale)}px)`,
                      }
                    : undefined
                }
              >
                <input
                  aria-label={item.text}
                  checked={item.checked}
                  className="size-5 shrink-0 accent-[var(--page-accent,var(--duet-violet))]"
                  disabled={!onCheck}
                  onChange={(event) => onCheck?.(item.id, event.target.checked)}
                  type="checkbox"
                />
                <span
                  className={
                    item.checked ? "text-duet-ink-3 line-through" : undefined
                  }
                >
                  {item.text}
                </span>
              </label>
            </li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div
          className={cn(
            wrapper,
            "overflow-x-auto rounded-xl border border-duet-hair",
          )}
        >
          <table
            className="w-full border-separate border-spacing-0 text-left"
            style={
              compact
                ? {
                    tableLayout: "fixed",
                    width: slideTableWidth(block.columns.length, layoutVersion),
                  }
                : undefined
            }
          >
            <thead>
              <tr>
                {block.columns.map((column, index) => (
                  <th
                    className={cn(
                      "min-w-[100px] border-duet-hair border-b bg-duet-tile px-2 py-2 font-semibold",
                      index === 0 && "sticky left-0 z-10",
                    )}
                    key={`${column}-${index}`}
                    scope="col"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={`row-${index}`}>
                  {row.map((cell, column) =>
                    column === 0 ? (
                      <th
                        className="sticky left-0 z-10 min-w-[100px] border-duet-hair border-b bg-duet-card px-2 py-2 font-medium"
                        key={`cell-${column}`}
                        scope="row"
                      >
                        {cell}
                      </th>
                    ) : (
                      <td
                        className="min-w-[100px] border-duet-hair border-b bg-duet-card px-2 py-2"
                        key={`cell-${column}`}
                      >
                        {cell}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "decision":
      return (
        <section aria-label={block.question} className={wrapper}>
          <h3 className="mb-2 font-semibold">{block.question}</h3>
          <div className="flex gap-2 overflow-x-auto">
            {block.options.map((option, index) => (
              <div
                className="min-w-[120px] flex-1 rounded-xl bg-duet-tile p-2"
                key={index}
              >
                <h4 className="font-semibold">{option.title}</h4>
                {option.pros.map((pro, index) => (
                  <p className="mt-1 flex gap-1" key={`pro-${index}`}>
                    <span
                      aria-label="Pro"
                      role="img"
                      className="text-duet-green"
                    >
                      +
                    </span>
                    <span>{pro}</span>
                  </p>
                ))}
                {option.cons.map((con, index) => (
                  <p className="mt-1 flex gap-1" key={`con-${index}`}>
                    <span
                      aria-label="Con"
                      role="img"
                      className="text-duet-amber"
                    >
                      −
                    </span>
                    <span>{con}</span>
                  </p>
                ))}
              </div>
            ))}
          </div>
          {block.pick ? (
            <p className="mt-2 font-semibold text-[var(--page-accent,var(--duet-violet))]">
              Pick: {block.pick}
            </p>
          ) : null}
        </section>
      );
    case "comparison":
      return (
        <div className={cn(wrapper, "flex gap-2 overflow-x-auto")}>
          {block.columns.map((column, index) => (
            <section
              className="min-w-[120px] flex-1 rounded-xl bg-duet-tile p-2"
              key={`${column.title}-${index}`}
            >
              <h3 className="font-semibold">{column.title}</h3>
              <ul>
                {column.items.map((item, index) => (
                  <li className="mt-1" key={`item-${index}`}>
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      );
    case "image":
      return (
        <figure className={wrapper}>
          <SafeSvg
            className={compact ? "h-[120px]" : "aspect-video max-h-80"}
            label={block.alt}
            svg={block.svg}
          />
          <figcaption
            className={cn("mt-1 text-duet-ink-2", !compact && "type-label")}
          >
            {block.alt}
          </figcaption>
        </figure>
      );
  }
}
