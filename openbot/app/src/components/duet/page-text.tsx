import type { ReactNode } from "react";

/** Plain page text with source URLs; never interpret model text as HTML or Markdown. */
export function PageText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const start = match.index;
    // Trim trailing sentence punctuation, then drop unmatched closers — and
    // repeat, because a closer can hide punctuation behind it:
    // "(see https://example.com/pricing.)" trims nothing first (the "."
    // is not last), drops the ")", and only then exposes the ".".
    // Balanced parentheses inside a URL are preserved throughout.
    let source = match[0];
    let previous = "";
    while (source !== previous) {
      previous = source;
      source = source.replace(/[.,;:!?]+$/, "");
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
