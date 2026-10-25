/** Aggregate completed answers for the voice report and its exit-status gate. */
export function evaluateVoiceBudget(
  everyday: readonly { words: number }[],
  examples: readonly { pass: boolean }[],
) {
  const counts = everyday.map((row) => row.words).sort((a, b) => a - b);
  const lowerMiddle = counts[Math.floor((counts.length - 1) / 2)] ?? 0;
  const upperMiddle = counts[Math.floor(counts.length / 2)] ?? 0;
  const median = (lowerMiddle + upperMiddle) / 2;
  return {
    counts,
    median,
    pass: !(
      median > 45 ||
      counts.some((n) => n > 80) ||
      examples.some((row) => !row.pass)
    ),
  };
}
