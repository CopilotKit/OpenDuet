/*
 * Measures OpenDuet's triage against the labelled set in emails.jsonl, using the same code the
 * server runs (openbot/server/src/openduet/triage.ts) and this deployment's model and key.
 *
 *   bun --env-file=openbot/.env evals/triage/run.ts             rules, then the model
 *   bun --env-file=openbot/.env evals/triage/run.ts --rules-only rules alone, no model calls
 *
 * The provider is BOT_PROVIDER (openai or anthropic, openai by default), with OPENAI_API_KEY or
 * ANTHROPIC_API_KEY. The model is TRIAGE_EVAL_MODEL, then BOT_MODEL, then the tenant package's
 * default for OpenAI. Writes results-<model>.md beside this file.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeModel } from "../../openbot/server/src/copilot";
import {
  ruleVerdict,
  triage,
  type TriageMessage,
  type TriagePerson,
  type TriageResult,
} from "../../openbot/server/src/openduet/triage";
import { createModelCompleter } from "../../openbot/server/src/routing/model";

type Labelled = {
  id: string;
  label: "needs_you" | "can_wait";
  why: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  headers: Record<string, string>;
  gmail_labels: string[];
  body: string;
};

const PERSON: TriagePerson = {
  name: "Maya Okafor",
  email: "maya@marlowceramics.com",
  about:
    "Runs Marlow Ceramics, a small studio that makes mugs and tableware for shops such as Hearth & Co.",
};
// The morning the set was written for.
const NOW = new Date("2026-10-22T07:30:00-07:00");

const rulesOnly = process.argv.includes("--rules-only");
const provider: RuntimeModel["provider"] =
  process.env.BOT_PROVIDER?.trim().toLowerCase() === "anthropic"
    ? "anthropic"
    : "openai";
const model =
  process.env.TRIAGE_EVAL_MODEL?.trim() ||
  process.env.BOT_MODEL?.trim() ||
  "gpt-5.6-terra";

const set: Labelled[] = (
  await readFile(join(import.meta.dir, "emails.jsonl"), "utf8")
)
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const toMessage = (item: Labelled): TriageMessage => ({
  id: item.id,
  from: item.from,
  to: item.to,
  cc: item.cc,
  subject: item.subject,
  date: item.date,
  headers: item.headers,
  labels: item.gmail_labels,
  body: item.body,
});

const complete = createModelCompleter({
  model: { provider, defaultModel: model } satisfies RuntimeModel,
  resolveApiKey: async () =>
    (provider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY
    )?.trim() || null,
});

type Row = { item: Labelled; result: TriageResult | null; error?: string };
const rows: Row[] = [];
const queue = [...set];
async function worker() {
  for (let item = queue.shift(); item; item = queue.shift()) {
    const message = toMessage(item);
    if (rulesOnly) {
      rows.push({ item, result: ruleVerdict(message) });
      continue;
    }
    try {
      rows.push({
        item,
        result: await triage(message, PERSON, {
          complete,
          model,
          now: () => NOW,
        }),
      });
    } catch (error) {
      rows.push({
        item,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
rows.sort((a, b) => a.item.id.localeCompare(b.item.id));

const decided = rows.filter((row) => row.result);
const truePositive = decided.filter(
  (row) =>
    row.item.label === "needs_you" && row.result?.verdict === "needs_you",
).length;
const falsePositive = decided.filter(
  (row) => row.item.label === "can_wait" && row.result?.verdict === "needs_you",
).length;
const falseNegative = decided.filter(
  (row) => row.item.label === "needs_you" && row.result?.verdict === "can_wait",
).length;
const trueNegative = decided.filter(
  (row) => row.item.label === "can_wait" && row.result?.verdict === "can_wait",
).length;
const byRule = decided.filter((row) =>
  row.result?.decidedBy.startsWith("rule:"),
);
const ruleErrors = byRule.filter((row) => row.item.label !== "can_wait");
const failed = rows.filter((row) => !row.result);
const pct = (n: number, d: number) =>
  d ? `${((100 * n) / d).toFixed(1)}%` : "n/a";
const precision = pct(truePositive, truePositive + falsePositive);
const recall = pct(truePositive, truePositive + falseNegative);

const wrong = decided.filter((row) => row.result?.verdict !== row.item.label);
const lines = [
  `# Triage eval${rulesOnly ? " (rules only)" : ""}`,
  "",
  `Run ${new Date().toISOString()} against ${set.length} labelled messages (${set.filter((i) => i.label === "needs_you").length} needs_you, ${set.filter((i) => i.label === "can_wait").length} can_wait). Model: ${rulesOnly ? "none" : model}.`,
  "",
  "| Measure | Value |",
  "| --- | --- |",
  `| Precision for needs_you | ${precision} (${truePositive} of ${truePositive + falsePositive} flagged were right) |`,
  `| Recall for needs_you | ${recall} (${truePositive} of ${truePositive + falseNegative} that needed her were flagged) |`,
  `| Accuracy | ${pct(truePositive + trueNegative, decided.length)} of ${decided.length} decided |`,
  `| Decided by rules, no model call | ${byRule.length} of ${set.length}, ${ruleErrors.length} wrong |`,
  `| Not decided (model error${rulesOnly ? " or left for the model" : ""}) | ${failed.length} |`,
  "",
  wrong.length ? "## Disagreements" : "## Disagreements\n\nNone.",
  ...wrong.map(
    (row) =>
      `- **${row.item.id}** "${row.item.subject}": labelled ${row.item.label}, got ${row.result?.verdict} by ${row.result?.decidedBy}. Its reason: "${row.result?.reason}". Label's reason: "${row.item.why}"`,
  ),
  ...(failed.length && !rulesOnly
    ? [
        "",
        "## Errors",
        ...failed.map((row) => `- **${row.item.id}**: ${row.error}`),
      ]
    : []),
  "",
  "## Every verdict",
  "",
  "| id | label | verdict | decided by | reason |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map(
    (row) =>
      `| ${row.item.id} | ${row.item.label} | ${row.result?.verdict ?? "-"} | ${row.result?.decidedBy ?? "-"} | ${(row.result?.reason ?? row.error ?? "").replaceAll("|", "/")} |`,
  ),
  "",
];
await writeFile(
  join(
    import.meta.dir,
    rulesOnly ? "results-rules-only.md" : `results-${model}.md`,
  ),
  lines.join("\n"),
);
console.log(lines.slice(0, 13).join("\n"));
