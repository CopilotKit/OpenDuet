import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseEvent, Message } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { frameFirstDay } from "@openbot/shared/first-day";
import { frameMorningBrief } from "@openbot/shared/morning-brief";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { z } from "zod";
import { currentApprovalContext } from "../src/approvals/types";
import { buildAgents } from "../src/copilot";
import { REPLIES_TOOL, replyTools } from "../src/openduet/replies";

/*
 * Reply chips as a real built-in run makes them: the CopilotKit agent, the AI SDK's own step loop,
 * the OpenAI provider, and a scripted model behind aimock. Each script is the model's steps in
 * order; what is asserted is what each `suggest_replies` call answered, which is both what the
 * model is told and what the app draws chips from (a "Refused." answer draws nothing, and anything
 * else is drawn under the last words of the turn).
 *
 * The model this guards against reads mail and calls the chips in the same step, or before it has
 * written anything. Told the buttons were on screen, it then wrote only the closing question, and
 * the person got "Which reply should I draft?" in place of an answer.
 */

const recorder = new LLMock();
let originalBase: string | undefined;
beforeAll(async () => {
  originalBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = await recorder.start();
});
afterAll(async () => {
  if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBase;
  await recorder.stop();
});

const READ = "gmail_read_message";
const ANSWER =
  "Ana wants 200 mugs instead of 120 for the same Friday. The kiln is down until Monday, so 200 by Friday isn't possible.\n\nShould I draft a yes for Tuesday?";

/** A read the Bot holds, standing in for Gmail. */
const read: GrantedTool = {
  name: READ,
  ref: `google-workspace/${READ}`,
  description: "Read one email by id.",
  parameters: z.object({ id: z.string() }),
  execute: async () =>
    "From Ana Pereira: Could we do 200 mugs instead of 120, same Friday?",
};

type Call = { name: string; args?: Record<string, unknown> };
type Step = { text?: string; calls?: Call[] };

const chips = (replies = ["Yes, for Tuesday", "Keep it at 120"]): Call => ({
  name: REPLIES_TOOL,
  args: { replies },
});
const reads = (): Call => ({ name: READ, args: { id: "msg-ana" } });

/** One model step as aimock serves it: text, tool calls, or both, text first. */
function served(step: Step, index: number) {
  const toolCalls = (step.calls ?? []).map((call, at) => ({
    id: `call_${index}_${at}`,
    name: call.name,
    arguments: JSON.stringify(call.args ?? {}),
  }));
  if (toolCalls.length === 0) return { content: step.text ?? "" };
  if (step.text === undefined) return { toolCalls };
  return { content: step.text, toolCalls };
}

/**
 * Runs one turn of the OpenDuet Bot against the script, and answers with each tool call it made, in
 * order, beside what that call answered.
 */
async function turn(
  steps: Step[],
  history: Message[] = [
    {
      id: "u1",
      role: "user",
      content: "Ana from Hearth & Co emailed me. What does she want?",
    },
  ],
  options: { tools?: GrantedTool[] } = {},
) {
  recorder.clearFixtures();
  recorder.clearRequests();
  let at = 0;
  recorder.on({ predicate: () => true }, () => {
    const index = Math.min(at, steps.length - 1);
    at += 1;
    return served(steps[index] ?? {}, index);
  });

  const agents = await buildAgents(
    [
      {
        id: "openduet",
        name: "OpenDuet",
        type: "built_in",
        systemPrompt: "Be brief.",
      },
    ],
    { provider: "openai", defaultModel: "gpt-test" },
    "synthetic-model-key",
    undefined,
    async () => [
      read,
      ...(options.tools ?? []),
      ...replyTools({ initiator: { kind: "person" } }),
    ],
  );
  const built = agents.openduet;
  if (!built) throw new Error('buildAgents returned no "openduet"');
  // The runtime runs a clone of the agent for every request, so the test does too.
  const agent = built.clone();
  agent.setMessages(history);
  const events: BaseEvent[] = [];
  await agent.runAgent(
    { runId: `run-${crypto.randomUUID()}` },
    {
      onEvent: ({ event }: { event: BaseEvent }) => {
        events.push(event);
      },
    },
  );

  const names = new Map<string, string>();
  const calls: { name: string; answer: string }[] = [];
  for (const event of events) {
    const e = event as BaseEvent & {
      toolCallId?: string;
      toolCallName?: string;
      content?: string;
    };
    if (e.type === "TOOL_CALL_START" && e.toolCallId && e.toolCallName)
      names.set(e.toolCallId, e.toolCallName);
    if (e.type === "TOOL_CALL_RESULT" && e.toolCallId) {
      // The runtime encodes a tool's text answer once more, as JSON. Its own "Error: …", for
      // arguments it rejected before the tool ran, it does not.
      const content = e.content ?? "";
      const answer = content.startsWith('"')
        ? (JSON.parse(content) as string)
        : content;
      calls.push({ name: names.get(e.toolCallId) ?? "?", answer });
    }
  }
  expect(events.some((event) => event.type === "RUN_ERROR")).toBe(false);
  const text = events
    .filter(
      (event) =>
        event.type === "TEXT_MESSAGE_CHUNK" ||
        event.type === "TEXT_MESSAGE_CONTENT",
    )
    .map((event) => (event as BaseEvent & { delta?: string }).delta ?? "")
    .join("");
  const finished = events.find((event) => event.type === "RUN_FINISHED") as
    | (BaseEvent & { outcome?: { type?: string } })
    | undefined;
  return { calls, steps: at, text, outcome: finished?.outcome?.type };
}

const replyAnswers = (calls: { name: string; answer: string }[]) =>
  calls.filter((call) => call.name === REPLIES_TOOL).map((call) => call.answer);

/** Whether the app draws this answer's chips: anything but a refusal or the runtime's own error. */
const drawn = (answer: string | undefined) =>
  answer !== undefined &&
  !answer.startsWith("Refused.") &&
  !answer.startsWith("Error:");

describe("a suggest_replies call made too early is held under the answer, not drawn above it", () => {
  test("beside a read in one step: held, and the Bot is told nothing is on screen and to write its full answer", async () => {
    const { calls } = await turn([
      { calls: [reads(), chips()] },
      { text: ANSWER },
    ]);

    // The read itself still ran.
    expect(calls.find((call) => call.name === READ)?.answer).toContain(
      "200 mugs",
    );
    const [held] = replyAnswers(calls);
    // Drawn, under the last thing written this turn: the answer the next step writes.
    expect(drawn(held)).toBe(true);
    expect(held).toContain("Nothing is on the person's screen yet");
    expect(held).toContain("Write your full answer now");
    expect(held).toContain(`Don't call ${REPLIES_TOOL} again`);
    // Not the answer that collapsed it: nothing about the buttons being on screen, or one sentence.
    expect(held).not.toContain("on screen,");
    expect(held).not.toContain("one short sentence");
  });

  test("first in its step, with a read after it: held too, though words came before it", async () => {
    // The words are there, so only the read beside it holds this one.
    const { calls } = await turn([
      { text: "Let me look.", calls: [chips(), reads()] },
      { text: ANSWER },
    ]);
    const [held] = replyAnswers(calls);
    expect(drawn(held)).toBe(true);
    expect(held).toContain("Write your full answer now");
  });

  test("alone in its step but before any answer: held", async () => {
    const { calls } = await turn([
      { calls: [reads()] },
      { calls: [chips()] },
      { text: ANSWER },
    ]);
    const [held] = replyAnswers(calls);
    expect(drawn(held)).toBe(true);
    expect(held).toContain("Write your full answer now");
  });

  test("after a line written before the reads: held, since that line was not the answer", async () => {
    const { calls } = await turn([
      { text: "Let me check your inbox.", calls: [reads()] },
      { calls: [chips()] },
      { text: ANSWER },
    ]);
    expect(replyAnswers(calls)[0]).toContain("Write your full answer now");
  });

  test("the Bot is told not to mention the buttons", async () => {
    const { calls } = await turn([{ calls: [chips()] }, { text: ANSWER }]);
    expect(replyAnswers(calls)[0]).toContain("don't mention the buttons");
  });
});

describe("a suggest_replies call after the answer", () => {
  test("ending on the question: shown, and the turn ends there: the model is not asked again", async () => {
    const { calls, steps, text } = await turn([
      { calls: [reads()] },
      { text: ANSWER, calls: [chips()] },
      // What the model wrote here on main: a line about the buttons, between the question and them.
      { text: "The buttons are on screen above. Pick the one you want." },
    ]);

    const [shown] = replyAnswers(calls);
    expect(drawn(shown)).toBe(true);
    expect(shown).toContain("End your turn now and write nothing more.");
    // Nothing that would have it ask the question a second time.
    expect(shown).not.toContain("ask it now");
    expect(shown).not.toContain("Ask your question");
    // Enforced, not only asked: the third step is never requested, so nothing is written after.
    expect(steps).toBe(2);
    expect(text).not.toContain("Pick the one you want");
  });

  test("that asks nothing: shown, and the Bot is told to ask, once, in words", async () => {
    const { calls } = await turn([
      {
        text: "Ana wants 200 mugs instead of 120 for the same Friday.",
        calls: [chips()],
      },
      { text: "Should I say yes for Tuesday?" },
    ]);

    const [shown] = replyAnswers(calls);
    expect(drawn(shown)).toBe(true);
    expect(shown).toContain("Ask your question now");
  });

  test("beside a copy of itself: every copy gets the same answer, and the turn ends", async () => {
    // A copy is not a read: the answer before them stands, and neither is held. The app draws the
    // last set of a turn only (`repliesLast`), so identical answers still make one row.
    const { calls, steps } = await turn([
      { calls: [reads()] },
      { text: ANSWER, calls: [chips(), chips(), chips()] },
      { text: "The buttons are on screen above." },
    ]);

    const answers = replyAnswers(calls);
    expect(answers).toHaveLength(3);
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain("End your turn now and write nothing more.");
    expect(steps).toBe(2);
  });

  test("that asks nothing does not end the turn: the Bot still has its question to write", async () => {
    const { steps, text } = await turn([
      {
        text: "Ana wants 200 mugs instead of 120 for the same Friday.",
        calls: [chips()],
      },
      { text: "Should I say yes for Tuesday?" },
    ]);
    expect(steps).toBe(2);
    expect(text).toContain("Should I say yes for Tuesday?");
  });

  test("a held call does not end the turn: the answer is still to come", async () => {
    const { steps, text } = await turn([
      { calls: [reads(), chips()] },
      { text: ANSWER },
    ]);
    expect(steps).toBe(2);
    expect(text).toContain("Should I draft a yes for Tuesday?");
  });
});

describe("one set of chips per turn", () => {
  test("a second call after the first was shown is dropped, and the turn ends", async () => {
    // Shown under words that asked nothing, so the turn goes on for the question.
    const { calls, steps } = await turn([
      {
        text: "Ana wants 200 mugs instead of 120 for the same Friday.",
        calls: [chips()],
      },
      {
        text: "Should I say yes for Tuesday?",
        calls: [chips(["Draft it", "Not yet"])],
      },
      { text: "The buttons are on screen above." },
    ]);

    const [first, second] = replyAnswers(calls);
    expect(drawn(first)).toBe(true);
    expect(second).toStartWith("Refused.");
    expect(second).toContain("already on screen");
    expect(steps).toBe(2);
  });

  test("a call after the answer replaces a held set, and the turn ends", async () => {
    // The held set was picked beside the read; the one picked after the answer is the one to draw.
    const { calls, steps } = await turn([
      { calls: [reads(), chips()] },
      { text: ANSWER, calls: [chips(["Draft it", "Not yet"])] },
      { text: "Pick one above." },
    ]);

    const [held, replacing] = replyAnswers(calls);
    expect(held).toStartWith("The buttons are held");
    expect(drawn(replacing)).toBe(true);
    expect(replacing).toContain("End your turn now and write nothing more.");
    expect(steps).toBe(2);
  });

  test("a second call before the answer, after one was held, is dropped", async () => {
    const { calls } = await turn([
      { calls: [reads(), chips()] },
      { calls: [reads(), chips(["Draft it", "Not yet"])] },
      { text: ANSWER },
    ]);

    const [held, second] = replyAnswers(calls);
    expect(held).toStartWith("The buttons are held");
    expect(second).toStartWith("Refused.");
    expect(second).toContain("already held");
  });

  test("two calls held in one step: both get the held answer, so the model is told one thing", async () => {
    /*
     * The model often sends two or three copies of the chips call in one step. Answered differently,
     * "end your turn" or even "already held, write your full answer", it followed the odd one out and
     * wrote "Nothing more to add for now." or "I've given you my full answer above." in place of its
     * answer. Every copy now gets what the first got; the app draws the last set of the turn only.
     */
    const { calls, steps, text } = await turn([
      { calls: [reads(), chips(), chips(["Draft it", "Not yet"])] },
      { text: ANSWER },
    ]);
    const answers = replyAnswers(calls);
    expect(answers).toHaveLength(2);
    expect(answers[0]).toStartWith("The buttons are held");
    expect(answers[1]).toBe(answers[0] ?? "");
    expect(steps).toBe(2);
    expect(text).toContain("Should I draft a yes for Tuesday?");
  });

  test("a call whose replies the runtime rejected drew nothing, so the next one is not dropped", async () => {
    // Too long for a chip: the AI SDK refuses the arguments with "Error: Invalid input…" itself,
    // and the tool never runs. Nothing was drawn, so it is not a first set of chips.
    const { calls } = await turn([
      {
        text: ANSWER,
        calls: [chips(["Draft a yes to all 200 mugs for next Tuesday", "No"])],
      },
      { calls: [chips()] },
      { text: "" },
    ]);

    const [rejected, accepted] = replyAnswers(calls);
    expect(rejected).toStartWith("Error:");
    expect(drawn(accepted)).toBe(true);
    expect(accepted).toContain("End your turn now and write nothing more.");
  });

  test("chips already drawn earlier in the turn, before an approval resumed it: dropped", async () => {
    const { calls } = await turn(
      [{ calls: [chips()] }, { text: "" }],
      [
        { id: "u1", role: "user", content: "Should I say yes to Ana?" },
        {
          id: "a1",
          role: "assistant",
          content: ANSWER,
          toolCalls: [
            {
              id: "call_earlier",
              type: "function",
              function: {
                name: REPLIES_TOOL,
                arguments: JSON.stringify({ replies: ["Yes", "No"] }),
              },
            },
          ],
        },
        {
          id: "t1",
          role: "tool",
          toolCallId: "call_earlier",
          // As the thread stores a server tool's text: encoded once more.
          content: JSON.stringify("The buttons are on screen."),
        },
      ],
    );

    expect(replyAnswers(calls)[0]).toContain("already on screen");
  });
});

const SEND = "gmail_send_reply";
const sends = (): Call => ({
  name: SEND,
  args: { messageId: "msg-ana", body: "Yes to 200, for Tuesday." },
});

/** A send held for the person's approval, as the gate holds one: after a moment's work, it waits. */
const heldSend: GrantedTool = {
  name: SEND,
  ref: `google-workspace/${SEND}`,
  description: "Reply in an existing thread.",
  parameters: z.object({ messageId: z.string(), body: z.string() }),
  execute: async () => {
    // The real gate reads the policy and writes the request first; the chips call answers in that time.
    await new Promise((resolve) => setTimeout(resolve, 25));
    throw new HeadlessToolSuspension("Waiting for your approval.", {
      kind: "approval",
      approvalId: "approval-1",
      requestId: "approval-1",
      continuation: currentApprovalContext(),
    });
  },
};

/** The same send once the person allowed it. */
const allowedSend: GrantedTool = {
  ...heldSend,
  execute: async () => "Sent.",
};

describe("chips and an approval in the same turn", () => {
  test("called beside a send that waits for approval: nothing is drawn under the card", async () => {
    const { calls, outcome } = await turn(
      [{ calls: [reads(), sends(), chips()] }, { text: ANSWER }],
      undefined,
      { tools: [heldSend] },
    );

    expect(outcome).toBe("interrupt");
    // Whatever the chips call answered, if anything reached the person, it draws nothing.
    expect(replyAnswers(calls).filter(drawn)).toEqual([]);
  });

  test("the run resumed after Allow once, with the first chips call left unanswered, draws one set", async () => {
    /*
     * The history a private-share resume runs with: the continuation was captured when the send
     * suspended, before the chips call beside it answered, so that call has no result. The approval's
     * answer stands in for the send's. The model then sends again and calls the chips again.
     */
    const history: Message[] = [
      {
        id: "u1",
        role: "user",
        content:
          "Reply to Ana's 'Could we do 200?' and say yes for Tuesday. Then ask me whether to tell Sam today or tomorrow.",
      },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_read",
            type: "function",
            function: { name: READ, arguments: '{"id":"msg-ana"}' },
          },
          {
            id: "call_send",
            type: "function",
            function: {
              name: SEND,
              arguments:
                '{"messageId":"msg-ana","body":"Yes to 200, for Tuesday."}',
            },
          },
          {
            id: "call_chips_first",
            type: "function",
            function: {
              name: REPLIES_TOOL,
              arguments: '{"replies":["Tell Sam today","Tell Sam tomorrow"]}',
            },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "call_read",
        content: JSON.stringify("Could we do 200 mugs instead of 120?"),
      },
      {
        id: "approval:approval-1",
        role: "tool",
        toolCallId: "call_send",
        content: "The person allowed this share. Send it again now, unchanged.",
      },
    ];
    const { calls, steps } = await turn(
      [
        {
          calls: [sends(), chips(["Tell Sam today", "Tell Sam tomorrow"])],
        },
        { text: "I sent Ana a yes for Tuesday. Should I tell Sam today?" },
      ],
      history,
      { tools: [allowedSend] },
    );

    // One set from this run, held under the answer it then writes; the first call drew nothing.
    expect(replyAnswers(calls).filter(drawn)).toHaveLength(1);
    expect(replyAnswers(calls)[0]).toStartWith("The buttons are held");
    expect(steps).toBe(2);
  });

  test("an earlier set held in the turn counts, so another before the answer is dropped", async () => {
    // A call with no answer at all never gets this far: the history's sanitizer drops it before the
    // run starts, and the app draws nothing for it. What a resumed turn can carry is a held answer.
    const history: Message[] = [
      { id: "u1", role: "user", content: "Should I say yes to Ana?" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_chips_first",
            type: "function",
            function: {
              name: REPLIES_TOOL,
              arguments: '{"replies":["Yes","No"]}',
            },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "call_chips_first",
        content: JSON.stringify(
          "The buttons are held: they appear under the last thing you write this turn.",
        ),
      },
    ];
    const { calls } = await turn(
      [{ calls: [reads(), chips()] }, { text: ANSWER }],
      history,
    );
    expect(replyAnswers(calls)[0]).toContain("already held");
  });
});

describe("the first day", () => {
  test("a chips call on the first-day turn is refused: the app draws that turn's own replies", async () => {
    const { calls } = await turn(
      [{ calls: [reads(), chips()] }, { text: ANSWER }],
      [
        {
          id: "u1",
          role: "user",
          content: frameFirstDay(
            "Look at my mail and calendar and tell me who I am.",
          ),
        },
      ],
    );
    const [refused] = replyAnswers(calls);
    expect(refused).toStartWith("Refused.");
    expect(refused).toContain("first day");
  });
});

describe("the morning brief", () => {
  test("a chips call on the brief nobody typed is refused: its card already holds what can be started", async () => {
    const { calls } = await turn(
      [{ calls: [reads(), chips()] }, { text: ANSWER }],
      [
        {
          id: "u1",
          role: "user",
          content: frameMorningBrief("Give me my morning brief."),
        },
      ],
    );
    const [refused] = replyAnswers(calls);
    expect(refused).toStartWith("Refused.");
    expect(refused).toContain("morning brief");
  });

  test("a chips call after the person answered the brief is theirs to get again", async () => {
    const { calls } = await turn(
      [{ text: ANSWER }, { calls: [chips()] }],
      [
        {
          id: "u1",
          role: "user",
          content: frameMorningBrief("Give me my morning brief."),
        },
        { id: "a1", role: "assistant", content: "One thing needs you." },
        { id: "u2", role: "user", content: "Should I say yes to Ana?" },
      ],
    );
    expect(replyAnswers(calls)[0]).not.toStartWith("Refused.");
  });
});
