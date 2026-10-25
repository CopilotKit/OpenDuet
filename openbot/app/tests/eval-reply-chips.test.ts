import { describe, expect, test } from "bun:test";
import { hasShortReplyChips } from "../../scripts/evals/reply-chips";

describe("reply-chip label qualification", () => {
  test.each([
    "Use regular, please",
    "Reply or wait",
    "Review and confirm",
    "Use regular; please",
    "Use regular. Please",
    "Use regular! Please",
    "Use regular\nplease",
  ])("accepts a short label containing a separator: %s", (label) => {
    expect(hasShortReplyChips([label, "Not now"])).toBe(true);
  });

  test.each([
    { chips: ["Yes", "Not now"] },
    { chips: ["Yes", "Not now", "Reply to Rosa"] },
    { chips: ["Confirm shipment Tuesday", "Wait"] },
    { chips: ["  Confirm shipment Tuesday  ", " Wait "] },
    { chips: ["Reply\tto\nRosa", "Use double-wall"] },
  ])(
    "accepts 2–3 chips with 1–3 words and at most 24 characters: %j",
    ({ chips }) => {
      expect(hasShortReplyChips(chips)).toBe(true);
    },
  );

  test.each([
    { chips: [] },
    { chips: ["Yes"] },
    { chips: ["Yes", "Not now", "Reply to Rosa", "Wait"] },
  ])("rejects a chip count outside 2–3: %j", ({ chips }) => {
    expect(hasShortReplyChips(chips)).toBe(false);
  });

  test.each([
    { chips: ["Yes, take Oat Satin", "Let me think"] },
    { chips: ["Yes", "One two three four"] },
    { chips: ["Confirm shipments Tuesday", "Wait"] },
    { chips: ["Supercalifragilisticexpialidocious", "Wait"] },
    { chips: ["", "Wait"] },
    { chips: ["Yes", " \t\n "] },
    { chips: ["Yes", "", "Wait"] },
    { chips: ["Yes", "Wait", "One two three four"] },
  ])(
    "rejects the turn when any label exceeds a limit or is blank: %j",
    ({ chips }) => {
      expect(hasShortReplyChips(chips)).toBe(false);
    },
  );
});
