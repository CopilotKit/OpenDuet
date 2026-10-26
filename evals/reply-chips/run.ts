/*
 * Measures reply chips on ten everyday choice questions in a running fake-mailbox stack.
 * Every ask uses a fresh conversation. At least seven replies must have 2–3 short chips,
 * and every reply must preserve its prose answer.
 *
 *   OPENDUET_FAKE_MAILBOX=1 OPENDUET_APP=http://localhost:3041 bun evals/reply-chips/run.ts
 *
 * Requires system Chrome. Writes results-<timestamp>.md beside this file.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sampleQuestions } from "../../openbot/scripts/evals/chat-browser";
import {
  completedReplies,
  samplingFailureReport,
} from "../../openbot/scripts/evals/chat-sampling";
import { markdownTableRow } from "../../openbot/scripts/evals/markdown-table";
import { hasProseAnswer } from "../../openbot/scripts/evals/reply-answer";
import { hasShortReplyChips } from "../../openbot/scripts/evals/reply-chips";

const APP = process.env.OPENDUET_APP ?? "http://localhost:3041";
if (/:(3030|3130)\b/.test(APP)) throw new Error("Refusing a live stack.");
if (process.env.OPENDUET_FAKE_MAILBOX !== "1")
  throw new Error(
    "Set OPENDUET_FAKE_MAILBOX=1 after verifying this stack uses Fake Google.",
  );

const QUESTIONS = [
  "Should I handle Ana's order or the Clayworks invoice first?",
  "Is regular or double-wall packaging better for Sam's order?",
  "Would you prioritize replying to Rosa or checking the kiln repair?",
  "Should I offer Jordan a refund or replacement bowls?",
  "For Hearth & Co, would you promise 120 mugs or the extra 80?",
  "Would Oat Satin be a better choice than waiting for Speckled White?",
  "Should I reopen Shopify first or confirm the wholesale shipment?",
  "Would you reply to Leah today or wait until after the glaze test?",
  "Should I keep Friday's ship date or propose Monday?",
  "Would you review tomorrow's calendar or today's urgent mail first?",
];
const samples = await sampleQuestions(APP, QUESTIONS);
const resultPath = join(
  import.meta.dir,
  `results-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
);
const replies = completedReplies(samples, QUESTIONS);
if (!replies) {
  const failure = samplingFailureReport(samples, QUESTIONS);
  await writeFile(
    resultPath,
    `# Reply chips eval sampling failure\n\nStack: ${APP}.\n\n${failure}`,
    { flag: "wx" },
  );
  throw new Error(`${failure}Report: ${resultPath}`);
}
const rows = replies.map((reply) => ({
  ...reply,
  shortChips: hasShortReplyChips(reply.chips),
  collapsed: !hasProseAnswer(reply.bubbles, reply.chips),
}));
for (const reply of rows) {
  console.log(
    `${reply.chips.length} chips; shortChips=${reply.shortChips}; collapsed=${reply.collapsed}: ${reply.ask}`,
  );
}
const offered = rows.filter((r) => r.shortChips).length;
const collapsed = rows.filter((r) => r.collapsed).length;
const passed = offered >= 7 && collapsed === 0;
const lines = [
  `# Reply chips eval, ${new Date().toISOString().slice(0, 10)}`,
  "",
  `Stack: ${APP}. Natural choices with the fake mailbox.`,
  "",
  `${passed ? "PASS" : "FAIL"}: ${offered}/10 with 2–3 short chips (each 1–3 words, ≤24 characters; target ≥7); ${collapsed} collapsed answers (target 0).`,
  "",
  "Answer preservation is a conservative English structural check, not a semantic quality score. Questions, invitations, common filler and chip-label echoes do not count; unrecognized wording fails for review. Review the saved prose for meaning and relevance.",
  "",
  "| Ask | Chips | Short chips | Collapsed | Answer |",
  "|---|---|---|---|---|",
  ...rows.map((r) =>
    markdownTableRow([
      r.ask,
      r.chips.join(" / "),
      r.shortChips,
      r.collapsed,
      r.bubbles.join(" / "),
    ]),
  ),
  "",
];
await writeFile(resultPath, lines.join("\n"), { flag: "wx" });
if (!passed) process.exitCode = 1;
