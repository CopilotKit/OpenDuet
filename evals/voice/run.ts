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
 * results-<date>.md beside this file.
 */
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(
  join(import.meta.dir, "../../openbot/package.json"),
);
const { chromium } =
  require("playwright-core") as typeof import("playwright-core");

const APP = process.env.OPENDUET_APP ?? "http://localhost:3066";
if (/:(3030|3130)\b/.test(APP)) throw new Error("Refusing Jerel's real stack.");

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

type Reply = { ask: string; bubbles: string[]; listItems: number };

const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await (
  await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
).newPage();

async function ask(question: string): Promise<Reply> {
  const created = await fetch(`${APP}/api/channels`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP },
    body: JSON.stringify({ agentIds: ["openduet"] }),
  });
  const { channel } = (await created.json()) as { channel: { id: string } };
  await page.goto(`${APP}/channel/${channel.id}`, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.locator('[contenteditable="true"], textarea').last().click();
  await page.keyboard.type(question);
  await page.getByRole("button", { name: "Send message" }).click();
  const started = Date.now();
  // Settled: nothing running, at least one reply bubble, and no new bubble for three seconds.
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() - started < 150_000) {
    await page.waitForTimeout(1000);
    if (await page.getByRole("button", { name: "Allow once" }).count()) break;
    const busy = await page.locator('[aria-busy="true"]').count();
    const count = await page.locator('[data-slot="bubble-content"]').count();
    if (count !== last || busy) {
      last = count;
      stableSince = Date.now();
      continue;
    }
    if (count > 1 && Date.now() - stableSince > 3000) break;
  }
  return page.evaluate((ask) => {
    const bubbles = [
      ...document.querySelectorAll('[data-slot="bubble-content"]'),
    ];
    // The first bubble is the question; the rest are the reply.
    const reply = bubbles.slice(1);
    return {
      ask,
      bubbles: reply.map((bubble) => (bubble as HTMLElement).innerText.trim()),
      listItems: Math.max(
        0,
        ...reply.map((bubble) => bubble.querySelectorAll("li").length),
      ),
    };
  }, question);
}

const words = (reply: Reply) =>
  reply.bubbles.join(" ").split(/\s+/).filter(Boolean).length;
const sentences = (text: string) =>
  (text.match(/[.!?](\s|$)/g) ?? []).length || 1;

const examples = [];
for (const example of EXAMPLES) {
  const reply = await ask(example.ask);
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
for (const question of EVERYDAY) {
  const reply = await ask(question);
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
await browser.close();

const counts = everyday.map((row) => row.words).sort((a, b) => a - b);
const median = counts[Math.floor(counts.length / 2)] ?? 0;
const lines = [
  `# Voice eval, ${new Date().toISOString().slice(0, 10)}`,
  "",
  `Stack: ${APP}. Each question in a fresh conversation.`,
  "",
  "## The prompt's example questions, asked verbatim",
  "",
  "| Question | Direct | Repeats the example's made-up facts | Reply |",
  "|---|---|---|---|",
  ...examples.map(
    (row) =>
      `| ${row.ask} | ${row.direct ? "yes" : "NO"} | ${row.invented ? "YES" : "no"} | ${row.bubbles.join(" / ").replace(/\|/g, "/")} |`,
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
  ...everyday.map(
    (row) =>
      `| ${row.ask} | ${row.bubbles.length} | ${row.words} | ${row.perBubble.join(", ")} | ${row.listItems} | ${row.caveat || row.selfCorrection ? "yes" : "no"} | ${row.bubbles.join(" / ").replace(/\|/g, "/").replace(/\n+/g, " ")} |`,
  ),
  "",
];
await writeFile(
  join(import.meta.dir, `results-${new Date().toISOString().slice(0, 10)}.md`),
  lines.join("\n"),
);
console.log(lines.slice(9, 14).join("\n"));
