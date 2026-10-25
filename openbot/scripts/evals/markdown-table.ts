/** Keep dynamic cells literal on one table row, normalizing CR/LF runs to spaces. */
export function markdownTableRow(
  cells: readonly (string | number | boolean)[],
): string {
  const escaped = cells.map((cell) =>
    String(cell)
      // Markdown permits backslash escapes for every ASCII punctuation character.
      .replace(/[!-/:-@[-`{-~]/g, "\\$&")
      .replace(/[\r\n]+/g, " "),
  );
  return `| ${escaped.join(" | ")} |`;
}
