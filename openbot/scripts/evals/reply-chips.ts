/**
 * Match agents.yaml's 1–3 words and the reply tool's 24-character limit after trimming.
 * Count whitespace-separated words and UTF-16 code units, as the tool's string length does.
 */
export function hasShortReplyChips(chips: readonly string[]): boolean {
  return (
    chips.length >= 2 &&
    chips.length <= 3 &&
    chips.every((chip) => {
      const label = chip.trim();
      return (
        label.length > 0 && label.length <= 24 && label.split(/\s+/).length <= 3
      );
    })
  );
}
