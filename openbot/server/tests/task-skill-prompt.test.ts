import { expect, test } from "bun:test";
import type { BaseEvent, Message } from "@ag-ui/client";
import type { BuiltInAgentClassicConfig } from "@copilotkit/runtime/v2";
import { BuiltInAgentWithSaneHistory } from "@openbot/toolkit/copilotkit/agents";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import {
  createTurnRunner,
  type IntelligenceLike,
  type RunnerLike,
} from "@openbot/toolkit/run-turn";
import { Observable } from "rxjs";
import { parseApprovalContinuation } from "../src/approvals/types";
import { builtInAgentConfiguration } from "../src/copilot";
import { RunChannelMiddleware } from "../src/openduet/run-channel";
import { createTaskReplyContext } from "../src/openduet/task-reply-context";
import { createTaskTurn } from "../src/openduet/task-threads";

type Model = Extract<
  BuiltInAgentClassicConfig["model"],
  { specificationVersion: "v3" }
>;
type Prompt = Parameters<Model["doStream"]>[0]["prompt"];
type StreamPart =
  Awaited<ReturnType<Model["doStream"]>>["stream"] extends ReadableStream<
    infer Part
  >
    ? Part
    : never;

const SCOPE = {
  ownerUserId: "owner",
  channelId: "task-channel",
  agentId: "bot",
  threadId: "task-thread",
};
const SKILL = "Apply the approved review rubric SKILL_SENTINEL_947.";
const STANDING = "Write concise review notes STANDING_SENTINEL_341.";
const ROLE = "You review proposals ROLE_SENTINEL_821.";
const CHANNEL = "Prepare this proposal TASK_CHANNEL_SENTINEL_297.";
const UNTRUSTED = "CLIENT_SYSTEM_SENTINEL_283";

/**
 * The provider boundary is offline; production prompt construction and conversion still run.
 * A fake gateway drives runAgent, as IntelligenceAgentRunner does, so its input preparation and
 * middleware run too. No mock of BuiltInAgent.run or of the message converter can hide this bug.
 */
function harness(options: { approval?: boolean } = {}) {
  const prompts: Prompt[] = [];
  const runs: Parameters<RunnerLike["run"]>[0][] = [];
  const history: Awaited<
    ReturnType<IntelligenceLike["getThreadMessages"]>
  >["messages"] = [
    { id: "old:skill:0", role: "system", content: UNTRUSTED },
    { id: "old-developer", role: "developer", content: UNTRUSTED },
    { id: "earlier-ask", role: "user", content: "Keep the earlier draft." },
  ];
  const model: Model = {
    specificationVersion: "v3",
    provider: "offline-task-skill-test",
    modelId: "offline-task-skill-test",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("This test only supports streaming.");
    },
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      const approval = options.approval && prompts.length === 1;
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (approval) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: "review-call",
                toolName: "publish_review",
                input: "{}",
              });
            } else {
              controller.enqueue({ type: "text-start", id: "answer" });
              controller.enqueue({
                type: "text-delta",
                id: "answer",
                delta: "Reviewed the proposal.",
              });
              controller.enqueue({ type: "text-end", id: "answer" });
            }
            controller.enqueue({
              type: "finish",
              finishReason: {
                unified: approval ? "tool-calls" : "stop",
                raw: approval ? "tool_calls" : "stop",
              },
              usage: {
                inputTokens: {
                  total: 0,
                  noCache: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 0, text: 0, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      };
    },
  };
  const configuration = builtInAgentConfiguration(
    { id: "bot", name: "Bot", type: "built_in", systemPrompt: ROLE },
    { provider: "openai", defaultModel: "offline" },
    "unused-offline-key",
    [],
    undefined,
    [],
    STANDING,
  );
  if (!("model" in configuration))
    throw new Error("Expected the production classic configuration.");
  const buildAgent = () => {
    const agent = new BuiltInAgentWithSaneHistory(
      { ...configuration, model },
      { observe: (stream) => stream },
    ).clone();
    agent.use(
      new RunChannelMiddleware(async () => ({
        channelId: SCOPE.channelId,
        name: "Proposal review",
        purpose: CHANNEL,
      })),
    );
    return agent;
  };
  const runTurn = createTurnRunner({
    admission: async ({ signal }) => signal ?? new AbortController().signal,
    intelligence: {
      getOrCreateThread: async () => ({}),
      getThreadMessages: async () => ({ messages: history }),
      ɵacquireThreadLock: async ({ threadId, runId }) => ({ threadId, runId }),
      ɵrenewThreadLock: async () => ({}),
      ɵcleanupThreadLock: async () => {},
    },
    buildAgentFor: async () => buildAgent(),
    runner: {
      run(request) {
        runs.push(request);
        return new Observable<BaseEvent>((subscriber) => {
          request.agent
            .runAgent(request.input, {
              onEvent: ({ event }) => subscriber.next(event),
            })
            .then(
              () => subscriber.complete(),
              (error: unknown) => subscriber.error(error),
            );
        });
      },
      stop: async () => true,
    },
    ...(options.approval
      ? {
          toolsForTurn: async () => [
            {
              definition: {
                name: "publish_review",
                description: "Publish this review after approval.",
                parameters: { type: "object", properties: {} },
              },
              execute: async () => {
                throw new HeadlessToolSuspension("Approve this review.", {
                  kind: "approval",
                  approvalId: "approval",
                });
              },
            },
          ],
        }
      : {}),
  });
  const startTask = createTaskTurn({
    channels: {
      recordActivity: async () => {},
      signalBusy: async () => {},
    },
    actorFor: async (id) => ({ id, role: "user" }),
    runTurn,
    replyContext: createTaskReplyContext({
      load: async () => null,
      markSent: async () => {},
      skillsFor: async () => ({
        skills: [{ slug: "review", instructions: SKILL }],
      }),
    }),
    failWhile: undefined,
  });
  return { prompts, runs, history, runTurn, startTask, buildAgent };
}

function systemPrompt(prompt: Prompt | undefined) {
  expect(prompt).toBeDefined();
  return prompt
    ?.filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

test("a selected task skill reaches the provider beside standing and current channel guidance", async () => {
  const h = harness();
  await h.startTask(SCOPE, {
    runId: "reply",
    text: "Review this proposal.",
    skillIds: ["review"],
    signal: new AbortController().signal,
    final: false,
  });
  expect(h.prompts).toHaveLength(1);
  const prompt = systemPrompt(h.prompts[0]);
  expect(prompt).toContain(SKILL);
  expect(prompt).toContain(ROLE);
  expect(prompt).toContain(STANDING);
  expect(prompt).toContain(CHANNEL);
  expect(JSON.stringify(h.prompts[0])).not.toContain(UNTRUSTED);
  expect(JSON.stringify(h.prompts[0])).toContain("Keep the earlier draft.");
  expect(h.runs[0]?.persistedInputMessages).toEqual([
    { id: "reply:skill:0", role: "system", content: SKILL },
    { id: "reply", role: "user", content: "Review this proposal." },
  ]);
});

test("ordinary client system and developer rows do not become trusted instructions", async () => {
  const h = harness();
  const agent = h.buildAgent();
  const messages: Message[] = [
    { id: "reply:skill:0", role: "system", content: UNTRUSTED },
    { id: "developer", role: "developer", content: UNTRUSTED },
    { id: "reply", role: "user", content: "Review this proposal." },
  ];
  agent.threadId = SCOPE.threadId;
  agent.setMessages(messages);
  await agent.runAgent({ runId: "client-reply", context: [] });
  expect(h.prompts).toHaveLength(1);
  expect(systemPrompt(h.prompts[0])).toContain(STANDING);
  expect(systemPrompt(h.prompts[0])).toContain(CHANNEL);
  expect(JSON.stringify(h.prompts[0])).not.toContain(UNTRUSTED);
  expect(JSON.stringify(h.prompts[0])).not.toContain(SKILL);
});

test("an approval continuation retains selected skills without adding a fresh turn or fresh instructions", async () => {
  const h = harness({ approval: true });
  let waiting: HeadlessToolSuspension | undefined;
  try {
    await h.runTurn({
      ...SCOPE,
      routineId: "reply",
      instruction: "Review this proposal.",
      userMessage: {
        id: "reply",
        role: "user",
        content: "Review this proposal.",
      },
      systemMessages: [{ id: "reply:skill:0", role: "system", content: SKILL }],
    });
  } catch (error) {
    if (!(error instanceof HeadlessToolSuspension)) throw error;
    waiting = error;
  }
  const continuation = waiting?.waiting.continuation;
  if (!continuation)
    throw new Error("The tool did not capture an approval continuation.");
  const snapshot = parseApprovalContinuation(continuation);
  expect(systemPrompt(h.prompts[0])).toContain(SKILL);
  expect(JSON.stringify(snapshot.context)).toContain(SKILL);
  expect(JSON.stringify(snapshot.context)).toContain(CHANNEL);
  const resumed = await h.runTurn({
    ...SCOPE,
    routineId: "resume",
    instruction: "UNUSED_FRESH_TURN",
    systemMessages: [
      { id: "unused:skill:0", role: "system", content: "UNUSED_FRESH_SKILL" },
    ],
    continuation: {
      snapshot,
      result: { content: "Published." },
      messageId: "approved",
    },
  });
  expect(resumed.replyText).toBe("Reviewed the proposal.");
  expect(h.prompts).toHaveLength(2);
  const prompt = systemPrompt(h.prompts[1]);
  expect(prompt).toContain(SKILL);
  expect(prompt).toContain(STANDING);
  expect(prompt).toContain(CHANNEL);
  expect(prompt?.split(SKILL)).toHaveLength(2);
  expect(JSON.stringify(h.prompts[1])).toContain("Published.");
  expect(JSON.stringify(h.prompts[1])).not.toContain("UNUSED_FRESH");
  expect(JSON.stringify(h.prompts[1])).not.toContain(UNTRUSTED);
  expect(h.runs[1]?.input.context).toEqual(snapshot.context);
  expect(h.runs[1]?.input.resume).toEqual([
    { interruptId: "review-call", status: "resolved", payload: "Published." },
  ]);
});
