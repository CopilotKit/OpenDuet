/*
 * Measures OpenDuet's chat voice on a running stack: asks each question in a fresh conversation,
 * reads the reply bubbles as a person sees them, and checks them against the chat contract
 * (parity-spec Chat 2): a direct answer, a few short sentences per bubble, no more than three listed
 * things, no notes on where it read something, no going back over an earlier answer.
 *
 *   OPENDUET_APP=http://localhost:3066 bun evals/voice/run.ts
 *
 * It needs the app and server running with Gmail connected (Fake Google is enough), and system
 * Chrome. Every question gets its own new conversation, so one answer cannot shape the next. Writes
 * results-<timestamp>.md beside this file.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sampleQuestions } from "../../openbot/scripts/evals/chat-browser";
import {
  completedReplies,
  samplingFailureReport,
  type CompletedReply,
} from "../../openbot/scripts/evals/chat-sampling";
import { markdownTableRow } from "../../openbot/scripts/evals/markdown-table";
import { evaluateVoiceBudget } from "../../openbot/scripts/evals/voice-budget";

const APP = process.env.OPENDUET_APP ?? "http://localhost:3066";
if (/:(3030|3130)\b/.test(APP)) throw new Error("Refusing a live stack.");

/**
 * The prompt's own example questions, asked verbatim. Their people and facts are in nobody's
 * mailbox, so a direct answer is "No, nothing from Kenji", and an answer that repeats the example's
 * made-up facts is the failure this checks for.
 */
const EXAMPLES = [
  {
    ask: "Did Kenji email me?",
    subject: /kenji/i,
    invented: /thursday'?s call|friday at 3/i,
  },
  { ask: "What's on Sunday?", subject: /sunday/i, invented: null },
];

/** Things a person asks every day, against the seeded mailbox and calendar. */
const EVERYDAY = [
  "Did Sam email me?",
  "What is on my calendar today?",
  "Anything from Clayworks?",
  "Who is Priya?",
  "Anything urgent in my inbox?",
  "Did Hearth & Co reply?",
  "Is anything due Friday?",
  "Any phishing in my inbox?",
  "When is the glaze test review?",
  "Did Rosa reply about the glaze?",
  "What should I do first today?",
  "Is the kiln technician still coming?",
];

const CAVEAT =
  /snippet|haven'?t opened|did ?n[o']t open|going by|from the search results|based on (the|what) I (found|read)/i;
const SELF_CORRECTION =
  /correct (my|that) (last|earlier)|I mistakenly|I was wrong (earlier|before)|to correct my/i;
const DEFLECTION =
  /^(I'?ve already asked|Tell me|Which |Do you want|Could you)/i;

const questions = [...EXAMPLES.map((example) => example.ask), ...EVERYDAY];
const samples = await sampleQuestions(APP, questions);
const resultPath = join(
  import.meta.dir,
  `results-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
);
const replies = completedReplies(samples, questions);
if (!replies) {
  const failure = samplingFailureReport(samples, questions);
  await writeFile(
    resultPath,
    `# Voice eval sampling failure\n\nStack: ${APP}.\n\n${failure}`,
    { flag: "wx" },
  );
  throw new Error(`${failure}Report: ${resultPath}`);
}

const words = (reply: CompletedReply) =>
  reply.bubbles.join(" ").split(/\s+/).filter(Boolean).length;
const sentences = (text: string) =>
  (text.match(/[.!?](\s|$)/g) ?? []).length || 1;

const examples = [];
for (const [index, example] of EXAMPLES.entries()) {
  const reply = replies[index];
  if (!reply) throw new Error(`Missing completed answer for ${example.ask}`);
  const first = reply.bubbles[0] ?? "";
  const direct =
    first.length > 0 &&
    example.subject.test(first) &&
    !DEFLECTION.test(first) &&
    !first.trimEnd().endsWith("?");
  const invented = example.invented
    ? example.invented.test(reply.bubbles.join(" "))
    : false;
  examples.push({ ...reply, direct, invented, pass: direct && !invented });
  console.log(
    `${direct && !invented ? "PASS" : "FAIL"} ${example.ask} -> ${reply.bubbles.join(" / ")}`,
  );
}

const everyday = [];
for (const [index, question] of EVERYDAY.entries()) {
  const reply = replies[EXAMPLES.length + index];
  if (!reply) throw new Error(`Missing completed answer for ${question}`);
  const all = reply.bubbles.join(" ");
  const row = {
    ...reply,
    words: words(reply),
    perBubble: reply.bubbles.map(sentences),
    caveat: CAVEAT.test(all),
    selfCorrection: SELF_CORRECTION.test(all),
  };
  everyday.push(row);
  console.log(`${row.words}w ${JSON.stringify(row.perBubble)} ${question}`);
}

const { counts, median, pass } = evaluateVoiceBudget(everyday, examples);
const lines = [
  `# Voice eval, ${new Date().toISOString().slice(0, 10)}`,
  "",
  `Stack: ${APP}. Each question in a fresh conversation.`,
  "",
  "## The prompt's example questions, asked verbatim",
  "",
  "| Question | Direct | Repeats the example's made-up facts | Reply |",
  "|---|---|---|---|",
  ...examples.map((row) =>
    markdownTableRow([
      row.ask,
      row.direct ? "yes" : "NO",
      row.invented ? "YES" : "no",
      row.bubbles.join(" / "),
    ]),
  ),
  "",
  "## Everyday asks",
  "",
  `Words: median ${median}; over 80: ${counts.filter((n) => n > 80).length} of ${counts.length}; max ${counts.at(-1)}.`,
  `Sentences per bubble, at most: ${Math.max(...everyday.flatMap((row) => row.perBubble))}. Listed things, at most: ${Math.max(...everyday.map((row) => row.listItems))}.`,
  `Source caveats: ${everyday.filter((row) => row.caveat).length}. Self-corrections: ${everyday.filter((row) => row.selfCorrection).length}.`,
  "",
  "| Ask | Bubbles | Words | Sentences per bubble | Listed | Caveat | Reply |",
  "|---|---|---|---|---|---|---|",
  ...everyday.map((row) =>
    markdownTableRow([
      row.ask,
      row.bubbles.length,
      row.words,
      row.perBubble.join(", "),
      row.listItems,
      row.caveat || row.selfCorrection ? "yes" : "no",
      row.bubbles.join(" / "),
    ]),
  ),
  "",
];
await writeFile(resultPath, lines.join("\n"), { flag: "wx" });
console.log(lines.slice(9, 14).join("\n"));

// A useful budget gate, not just a printed measurement.
if (!pass) {
  console.error(
    "Voice regression: require median ≤45 words, no reply over80, and direct grounded examples.",
  );
  process.exitCode = 1;
}
