import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseEvent, Message } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
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
    async () => [read, ...replyTools({ initiator: { kind: "person" } })],
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
  return { calls, steps: at };
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
  test("ending on the question: shown, and the Bot is told to end its turn", async () => {
    const { calls } = await turn([
      { calls: [reads()] },
      { text: ANSWER, calls: [chips()] },
      { text: "" },
    ]);

    const [shown] = replyAnswers(calls);
    expect(drawn(shown)).toBe(true);
    expect(shown).toContain("End your turn now and write nothing more.");
    // Nothing that would have it ask the question a second time.
    expect(shown).not.toContain("ask it now");
    expect(shown).not.toContain("Ask your question");
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

  test("beside a copy of itself: the first is shown and the copy dropped, so one row is drawn", async () => {
    // A copy is not a read: the answer before them stands, and neither is held.
    const { calls } = await turn([
      { calls: [reads()] },
      { text: ANSWER, calls: [chips(), chips(), chips()] },
      { text: "" },
    ]);

    const answers = replyAnswers(calls);
    expect(answers.filter(drawn)).toHaveLength(1);
    expect(answers.filter(drawn)[0]).toContain("End your turn now");
    expect(
      answers.filter((answer) => answer.includes("already on screen")),
    ).toHaveLength(2);
  });
});

describe("one set of chips per turn", () => {
  test("a second call after the first was shown is dropped", async () => {
    const { calls } = await turn([
      { text: ANSWER, calls: [chips()] },
      { calls: [chips(["Draft it", "Not yet"])] },
      { text: "" },
    ]);

    const [first, second] = replyAnswers(calls);
    expect(drawn(first)).toBe(true);
    expect(second).toStartWith("Refused.");
    expect(second).toContain("already on screen");
  });

  test("a second call after one was held is dropped too", async () => {
    const { calls } = await turn([
      { calls: [reads(), chips()] },
      { text: ANSWER, calls: [chips(["Draft it", "Not yet"])] },
      { text: "" },
    ]);

    const [held, second] = replyAnswers(calls);
    expect(drawn(held)).toBe(true);
    expect(second).toStartWith("Refused.");
    expect(second).toContain("already on screen");
  });

  test("two calls held in one step: one is drawn", async () => {
    const { calls } = await turn([
      { calls: [reads(), chips(), chips(["Draft it", "Not yet"])] },
      { text: ANSWER },
    ]);
    const answers = replyAnswers(calls);
    expect(answers).toHaveLength(2);
    expect(answers.filter(drawn)).toHaveLength(1);
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
