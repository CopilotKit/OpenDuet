import { describe, expect, test } from "bun:test";
import { evaluateVoiceBudget } from "../../scripts/evals/voice-budget";

describe("voice eval aggregation and budget gate", () => {
  test.each([
    {
      name: "accepts a 12-answer median exactly at the 45-word limit",
      words: [10, 10, 10, 10, 10, 40, 50, 50, 50, 50, 50, 50],
      examples: [{ pass: true }],
      median: 45,
      pass: true,
    },
    {
      name: "sorts an odd answer count and uses its middle value",
      words: [50, 10, 45],
      examples: [{ pass: true }],
      median: 45,
      pass: true,
    },
    {
      name: "rejects an even median just above 45 without rounding down",
      words: [50, 41],
      examples: [{ pass: true }],
      median: 45.5,
      pass: false,
    },
    {
      name: "rejects an odd median above 45",
      words: [10, 46, 50],
      examples: [{ pass: true }],
      median: 46,
      pass: false,
    },
    {
      name: "allows an answer exactly at the 80-word ceiling",
      words: [10, 80, 10],
      examples: [{ pass: true }],
      median: 10,
      pass: true,
    },
    {
      name: "rejects an answer over 80 even when the median passes",
      words: [10, 81, 10],
      examples: [{ pass: true }],
      median: 10,
      pass: false,
    },
    {
      name: "rejects an ungrounded example even when word budgets pass",
      words: [10],
      examples: [{ pass: true }, { pass: false }],
      median: 10,
      pass: false,
    },
  ])("$name", ({ words, examples, median, pass }) => {
    expect(
      evaluateVoiceBudget(
        words.map((words) => ({ words })),
        examples,
      ),
    ).toMatchObject({ median, pass });
  });
});
