import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { markdownTableRow } from "../../scripts/evals/markdown-table";

function expectRenderedRow(
  header: string,
  row: string,
  expected: readonly string[],
) {
  const markdown = [
    header,
    `|${expected.map(() => "---").join("|")}|`,
    row,
  ].join("\n");
  // Consume the production formatter's output with Bun's installed GFM renderer.
  const document = new Window().document;
  document.body.innerHTML = Bun.markdown.html(markdown);

  expect(document.querySelectorAll("table")).toHaveLength(1);
  expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
  const renderedCells = [...document.querySelectorAll("tbody td")];
  expect(renderedCells).toHaveLength(expected.length);
  expect(renderedCells.map((cell) => cell.textContent)).toEqual([...expected]);
}

describe("Markdown eval report rows", () => {
  test.each([
    {
      name: "structural HTML",
      evidence: "</td></tr><tr><td>forged",
    },
    {
      name: "inline HTML and Markdown",
      evidence:
        "<br> <em>tag</em> **bold** ~~strike~~ `code` [label](https://example.invalid/)",
    },
    {
      name: "named and numeric entities",
      evidence: "&copy; &amp; &#124; &#x3C;",
    },
  ])("keeps $name literal in its intended cell", ({ evidence }) => {
    expectRenderedRow(
      "| Evidence | Sentinel |",
      markdownTableRow([evidence, "end"]),
      [evidence, "end"],
    );
  });

  test.each([
    {
      name: "ordinary reply-chip cells",
      cells: ["Who first?", "Rosa / Kiln", true, false, "Reply to Rosa."],
      expected: [
        "Who first?",
        "Rosa / Kiln",
        "true",
        "false",
        "Reply to Rosa.",
      ],
    },
    {
      name: "pipes in every text column",
      cells: [
        "Rosa | Ana?",
        "Rosa | Kiln / Ana",
        true,
        false,
        "Choose Rosa | Kiln.",
      ],
      expected: [
        "Rosa | Ana?",
        "Rosa | Kiln / Ana",
        "true",
        "false",
        "Choose Rosa | Kiln.",
      ],
    },
    {
      name: "LF, CRLF and CR in text cells",
      cells: [
        "Who\rfirst?",
        "Reply\nto Rosa / Kiln\r\nrepair",
        true,
        false,
        "Rosa wrote.\r\nKiln can wait.\nThen call Ana.",
      ],
      expected: [
        "Who first?",
        "Reply to Rosa / Kiln repair",
        "true",
        "false",
        "Rosa wrote. Kiln can wait. Then call Ana.",
      ],
    },
    {
      name: "backslashes beside pipes and cell boundaries",
      cells: [
        "Rosa\\|Ana?",
        "Rosa\\|Kiln / Ana\\",
        false,
        true,
        "Use C:\\notes\\.",
      ],
      expected: [
        "Rosa\\|Ana?",
        "Rosa\\|Kiln / Ana\\",
        "false",
        "true",
        "Use C:\\notes\\.",
      ],
    },
    {
      name: "numeric and boolean scores",
      cells: ["Rosa | Kiln", 2, 0, true, false],
      expected: ["Rosa | Kiln", "2", "0", "true", "false"],
    },
  ])("keeps five readable cells for $name", ({ cells, expected }) => {
    expectRenderedRow(
      "| Ask | Chips | Short chips | Collapsed | Answer |",
      markdownTableRow(cells),
      expected,
    );
  });

  test.each([
    {
      name: "ordinary voice answers",
      ask: "What's on Sunday?",
      bubbles: ["Sunday is clear.", "Kenji has not emailed."],
      direct: true,
      invented: false,
      caveat: false,
      selfCorrection: false,
      expectedAsk: "What's on Sunday?",
      expectedReply: "Sunday is clear. / Kenji has not emailed.",
      expectedFlags: ["yes", "no", "no"] as const,
    },
    {
      name: "pipes and backslashes in voice questions and answers",
      ask: "Sunday | Kenji\\|Ana?",
      bubbles: ["Sunday | Kenji\\|Ana", "Use C:\\notes\\."],
      direct: false,
      invented: true,
      caveat: true,
      selfCorrection: false,
      expectedAsk: "Sunday | Kenji\\|Ana?",
      expectedReply: "Sunday | Kenji\\|Ana / Use C:\\notes\\.",
      expectedFlags: ["NO", "YES", "yes"] as const,
    },
    {
      name: "LF, CRLF and CR in voice questions and answers",
      ask: "Sunday\r\nor\nKenji\rplease?",
      bubbles: ["Sunday:\n- Lunch\r\n- Dinner\rThen rest.", "Kenji is away."],
      direct: true,
      invented: false,
      caveat: false,
      selfCorrection: true,
      expectedAsk: "Sunday or Kenji please?",
      expectedReply: "Sunday: - Lunch - Dinner Then rest. / Kenji is away.",
      expectedFlags: ["yes", "no", "yes"] as const,
    },
  ])("keeps the voice table layouts readable for $name", (row) => {
    expectRenderedRow(
      "| Question | Direct | Repeats the example's made-up facts | Reply |",
      markdownTableRow([
        row.ask,
        row.direct ? "yes" : "NO",
        row.invented ? "YES" : "no",
        row.bubbles.join(" / "),
      ]),
      [
        row.expectedAsk,
        row.expectedFlags[0],
        row.expectedFlags[1],
        row.expectedReply,
      ],
    );
    expectRenderedRow(
      "| Ask | Bubbles | Words | Sentences per bubble | Listed | Caveat | Reply |",
      markdownTableRow([
        row.ask,
        row.bubbles.length,
        8,
        [1, 2].join(", "),
        2,
        row.caveat || row.selfCorrection ? "yes" : "no",
        row.bubbles.join(" / "),
      ]),
      [
        row.expectedAsk,
        "2",
        "8",
        "1, 2",
        "2",
        row.expectedFlags[2],
        row.expectedReply,
      ],
    );
  });
});
