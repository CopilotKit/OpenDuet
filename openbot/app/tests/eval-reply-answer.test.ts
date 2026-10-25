import { describe, expect, test } from "bun:test";
import { hasProseAnswer } from "../../scripts/evals/reply-answer";
import { hasShortReplyChips } from "../../scripts/evals/reply-chips";

const chips = ["Use regular", "Use double-wall"];

describe("reply-chip answer preservation", () => {
  test.each([
    "Would you like me to choose regular packaging or double-wall packaging for Sam's order?",
    "Which packaging is better for the ceramic mugs in Sam's large wholesale order?",
    "Would you like me to use the stronger double-wall packaging for Sam's order",
    "Want me to use double-wall packaging for all of Sam's ceramic mugs?",
    "Let me know whether you want regular packaging or double-wall packaging for Sam.",
  ])("rejects a question or invitation regardless of length: %s", (answer) => {
    expect(hasProseAnswer([answer], chips)).toBe(false);
  });

  // The three single-line answer forms are covered by the concise-answer cases below.
  test.each([
    { answer: "Double-wall is safer than regular?", expected: false },
    { answer: "Double-wall is safer\nthan regular?", expected: false },
    { answer: "Double-wall\nis safer.", expected: true },
    { answer: "I recommend\ndouble-wall.", expected: true },
    { answer: "Use\ndouble-wall for Sam's mugs.", expected: true },
    { answer: "Use double-wall\nfor Sam's mugs.", expected: true },
    { answer: "Use regular\nfor Sam's mugs.", expected: true },
  ])(
    "classifies the complete logical clause across a soft wrap: $answer",
    ({ answer, expected }) => {
      expect(hasProseAnswer([answer], chips)).toBe(expected);
    },
  );

  for (const replyChips of [chips, []]) {
    describe(`invitations ${replyChips.length ? "with" : "without"} chips`, () => {
      test.each([
        "Tell me which option is better.",
        "Please tell me whether double-wall is safer.",
        "Tell me whether double-wall is safer.",
        "Please tell me which option is better.",
        "Tell me what the safer option is.",
        "Tell me how double-wall is safer.",
        "Tell me who is available.",
        "Please confirm whether double-wall is safer.",
      ])("rejects an invitation containing a predicate: %s", (answer) => {
        expect(hasProseAnswer([answer], replyChips)).toBe(false);
      });

      for (const invitation of [
        "Please let me know whether double-wall is safer.",
        "Tell me if double-wall is safer.",
        "Please tell me if double-wall is safer.",
      ]) {
        test.each([
          {
            context: "alone",
            bubbles: [invitation],
            expected: false,
          },
          {
            context: "with a following answer in the same bubble",
            bubbles: [`${invitation} Double-wall is safer.`],
            expected: true,
          },
          {
            context: "with a following answer in a separate bubble",
            bubbles: [invitation, "Double-wall is safer."],
            expected: true,
          },
        ])(`${invitation} $context`, ({ bubbles, expected }) => {
          expect(hasProseAnswer(bubbles, replyChips)).toBe(expected);
        });
      }

      test.each(["Double-wall is safer.", "Regular is better."])(
        "preserves a direct declarative answer: %s",
        (answer) => {
          expect(hasProseAnswer([answer], replyChips)).toBe(true);
        },
      );
    });
  }

  test("preserves an independent answer after a confirmation invitation", () => {
    expect(
      hasProseAnswer(
        ["Please confirm whether double-wall is safer. Double-wall is safer."],
        chips,
      ),
    ).toBe(true);
  });

  const wrappedInvitation = "Please tell me whether\ndouble-wall is safer.";
  // The matching single-line forms are already covered above, with and without chips.
  test.each([wrappedInvitation, "Tell me if\ndouble-wall is safer."])(
    "keeps a wrapped proposition inside its invitation: %s",
    (answer) => {
      expect(hasProseAnswer([answer], chips)).toBe(false);
    },
  );

  for (const replyChips of [["Use regular", "Use double-wall", "Wait"], []]) {
    test.each([
      "Please tell me\nwhether double-wall is safer.",
      "Please tell\nme whether double-wall is safer.",
    ])(
      `recognizes an invitation across an internal soft wrap ${replyChips.length ? "with" : "without"} chips: %s`,
      (answer) => {
        expect(hasProseAnswer([answer], replyChips)).toBe(false);
      },
    );
  }

  test("keeps a wrapped confirmation inside its invitation", () => {
    const singleLine = [
      "Would you like me to confirm whether double-wall is safer",
    ];
    const wrapped = [
      "Would you like me to\nconfirm whether double-wall is safer",
    ];
    expect(hasProseAnswer(singleLine, chips)).toBe(false);
    expect(hasProseAnswer(wrapped, chips)).toBe(false);
  });

  test("keeps a wrapped invitation without chips", () => {
    expect(hasProseAnswer([wrappedInvitation], [])).toBe(false);
  });

  const offer = "I can help you decide whether";
  for (const replyChips of [chips, []]) {
    test.each([
      "I'd be happy to help you choose.",
      "I would be happy to help you choose.",
    ])("rejects a conditional help offer: %s", (answer) => {
      expect(hasProseAnswer([answer], replyChips)).toBe(false);
    });
  }

  test("preserves an independent answer after a conditional help offer", () => {
    expect(
      hasProseAnswer(
        ["I'd be happy to help you choose. Double-wall is safer."],
        chips,
      ),
    ).toBe(true);
  });

  const wrappedOffer = `${offer}\ndouble-wall is safer.`;
  test.each([
    { answer: `${offer} double-wall is safer.`, expected: false },
    { answer: wrappedOffer, expected: false },
    {
      answer: `${wrappedOffer} Double-wall is safer.`,
      expected: true,
    },
    { answer: `${offer}\n\nDouble-wall is safer.`, expected: true },
  ])(
    "keeps wrapped offer scope until an independent answer boundary: %j",
    ({ answer, expected }) => {
      expect(hasProseAnswer([answer], chips)).toBe(expected);
    },
  );

  test.each([
    { bubbles: [`${wrappedInvitation} Double-wall is safer.`] },
    { bubbles: [wrappedInvitation, "Double-wall is safer."] },
  ])(
    "preserves an independent answer after a wrapped invitation: %j",
    ({ bubbles }) => {
      expect(hasProseAnswer(bubbles, chips)).toBe(true);
    },
  );

  test.each([
    {
      bubbles: [
        "Please tell me whether double-wall is safer. Double-wall is safer.",
      ],
    },
    {
      bubbles: [
        "Please tell me whether double-wall is safer.",
        "Double-wall is safer.",
      ],
    },
  ])(
    "preserves an independent answer after an invitation: %j",
    ({ bubbles }) => {
      expect(hasProseAnswer(bubbles, chips)).toBe(true);
    },
  );

  test.each([
    "Double-wall is safer.",
    "Use double-wall for Sam's mugs.",
    "Use regular for Sam's mugs.",
    "I'd use double-wall.",
    "I recommend double-wall.",
    "The invoice is overdue.",
    "Reply to Rosa today.",
    "Don't promise the extra 80.",
    "Confirm the wall thickness before ordering.",
  ])("accepts a concise statement or instruction: %s", (answer) => {
    expect(hasProseAnswer([answer], chips)).toBe(true);
  });

  test.each([
    { bubbles: [] },
    { bubbles: ["  \n "] },
    { bubbles: ["Regular packaging for all of Sam's fragile ceramic mugs"] },
    { bubbles: ["Regular packaging", "Double-wall packaging"] },
    { bubbles: ["Here are the two packaging options for Sam's order."] },
    { bubbles: ["I am happy to help you choose the best packaging."] },
    { bubbles: ["The choice is yours and I can help with either option."] },
    { bubbles: ["Use regular.", "Use double-wall!"] },
    { bubbles: ["Use regular / Use double-wall"] },
    { bubbles: ["Use regular or use double-wall"] },
    { bubbles: ["Use regular, use double-wall"] },
    { bubbles: ["1. Use regular\n2. Use double-wall"] },
    { bubbles: ["Use regular\nUse double-wall"] },
    { bubbles: ["- Use regular\n- Use double-wall"] },
    { bubbles: ["1) Use regular\n2) Use double-wall"] },
    { bubbles: ["I can help you decide.", "Which option do you prefer?"] },
    { bubbles: ["Choose one of the packaging options shown below."] },
    { bubbles: ["Use ..."] },
    { bubbles: ["Double-wall is ..."] },
  ])("rejects empty, label-only or filler prose: %j", ({ bubbles }) => {
    expect(hasProseAnswer(bubbles, chips)).toBe(false);
  });

  test("chip text itself cannot supply answer evidence", () => {
    expect(
      hasProseAnswer(
        ["Which option would you like?"],
        ["Use double-wall because it protects the mugs", "Regular is cheaper"],
      ),
    ).toBe(false);
  });

  test.each([
    ["Use regular, please", "Use regular, please"],
    ["Use regular, please", "Use regular, please."],
    ["Use regular, please", " \tUse regular, please. \t"],
    ["Reply or wait", "Reply or wait"],
    ["Reply or wait", "Reply or wait."],
    ["Reply or wait", " \tReply or wait. \t"],
    ["Review and confirm", "Review and confirm"],
    ["Review and confirm", "Review and confirm."],
    ["Review and confirm", " \tReview and confirm. \t"],
    ["Use regular; please", "Use regular; please"],
    ["Use regular; please", "Use regular; please."],
    ["Use regular; please", " \tUse regular; please. \t"],
    ["Use regular. Please", "Use regular. Please"],
    ["Use regular! Please", "Use regular! Please"],
    ["Use regular\nplease", "Use regular\nplease"],
    ["1. Use regular", "1. Use regular"],
    ["1) Use regular", "1) Use regular"],
    ["2. Reply today", "2. Reply today"],
    ["2) Reply today", "2) Reply today"],
  ])("rejects the accepted chip %s echoed as %s", (chip, answer) => {
    const chips = [chip, "Not now"];
    expect(hasShortReplyChips(chips)).toBe(true);
    expect(hasProseAnswer([answer], chips)).toBe(false);
  });

  const numberedEchoChips = ["Use regular. Please", "Not now"];
  test("rejects a complete chip echo split across bubbles", () => {
    expect(hasProseAnswer(["Use regular.", "Please"], numberedEchoChips)).toBe(
      false,
    );
  });

  test.each([
    { bubbles: ["1) Use regular. Please"], expected: false },
    {
      bubbles: ["1) Use regular. Please. Double-wall is safer."],
      expected: true,
    },
    {
      bubbles: ["1) Use regular. Please", "Double-wall is safer."],
      expected: true,
    },
  ])(
    "keeps a numbered complete chip echo separate from answer evidence: %j",
    ({ bubbles, expected }) => {
      expect(hasProseAnswer(bubbles, numberedEchoChips)).toBe(expected);
    },
  );

  test.each([
    {
      chips: ["Use regular, please", "Not now"],
      answer: "Use regular, please or Not now",
    },
    {
      chips: ["Reply or wait", "Not now"],
      answer: "Reply or wait, Not now",
    },
    {
      chips: ["Review and confirm", "Not now"],
      answer: "Review and confirm or Not now",
    },
    {
      chips: ["Use regular. Please", "Not now"],
      answer: "Use regular. Please or Not now",
    },
    { chips, answer: "Use regular & use double-wall" },
  ])(
    "rejects a sequence of complete accepted labels: $answer",
    ({ chips, answer }) => {
      expect(hasShortReplyChips(chips)).toBe(true);
      expect(hasProseAnswer([answer], chips)).toBe(false);
    },
  );

  test.each([
    { bubbles: ["Use regular, please or Not now. Double-wall is safer."] },
    { bubbles: ["Use regular, please or Not now", "Double-wall is safer."] },
  ])(
    "preserves an independent answer after a label sequence: %j",
    ({ bubbles }) => {
      expect(hasProseAnswer(bubbles, ["Use regular, please", "Not now"])).toBe(
        true,
      );
    },
  );

  test.each([
    "Use regular, please",
    "Reply or wait",
    "Review and confirm",
    "Use regular; please",
    "Use regular. Please",
    "Use regular! Please",
    "Use regular\nplease",
  ])("preserves an independent answer after echoing %s", (chip) => {
    expect(
      hasProseAnswer([`${chip}.`, "Double-wall is safer."], [chip, "Not now"]),
    ).toBe(true);
    expect(
      hasProseAnswer([`${chip}\nDouble-wall is safer.`], [chip, "Not now"]),
    ).toBe(true);
  });

  test("keeps answer evidence separate from follow-up questions across bubbles", () => {
    expect(
      hasProseAnswer(
        [
          "Which packaging should we use?",
          "Double-wall is safer.",
          "Draft a reply?",
        ],
        chips,
      ),
    ).toBe(true);
    expect(
      hasProseAnswer(
        ["Which packaging should we use?", "Want me to tell Sam it is safer?"],
        chips,
      ),
    ).toBe(false);
  });

  test("keeps a short answer in the same bubble as a follow-up question", () => {
    expect(
      hasProseAnswer(["Double-wall is safer. Want me to tell Sam?"], chips),
    ).toBe(true);
  });

  test("applies the same answer requirement on turns without chips", () => {
    expect(hasProseAnswer(["The invoice is overdue."], [])).toBe(true);
    expect(
      hasProseAnswer(
        ["Which invoice would you like me to look into first?"],
        [],
      ),
    ).toBe(false);
  });
});
