import type { ReactNode } from "react";

/** Plain page text with source URLs; never interpret model text as HTML or Markdown. */
export function PageText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const start = match.index;
    let source = match[0].replace(/[.,;:!?]+$/, "");
    for (const [open, close] of [
      ["(", ")"],
      ["[", "]"],
    ]) {
      while (
        source.endsWith(close) &&
        source.split(close).length > source.split(open).length
      ) {
        source = source.slice(0, -1);
      }
    }
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      continue;
    }
    if (url.username || url.password) continue;
    parts.push(text.slice(cursor, start));
    parts.push(
      <a
        key={start}
        href={url.href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {source}
      </a>,
    );
    cursor = start + source.length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}
