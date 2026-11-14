import { describe, expect, test } from "bun:test";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { resumePersonQuestion } from "../src/approvals/question-resume";
import type { PersonQuestion } from "../src/approvals/questions";
import type {
  Responsibility,
  ResponsibilityRun,
  ResponsibilityStore,
} from "../src/responsibilities/types";

const ownerUserId = "question-answer-owner";
const responsibility = {
  id: "goal-1",
  ownerUserId,
  agentId: "bot-1",
  threadId: "thread-1",
  status: "active",
} as Responsibility;
const question = (runId: string): PersonQuestion => ({
  actorId: ownerUserId,
  botId: responsibility.agentId,
  threadId: responsibility.threadId,
  runId,
  question: "Which deployment should I choose?",
  mode: "completed_question",
  initiator: { kind: "responsibility", id: responsibility.id },
});
const waitingRun = (id: string, runId?: string) =>
  ({
    id,
    status: "waiting",
    waiting: {
      kind: "person_question",
      ...(runId ? { continuation: { runId } } : {}),
    },
  }) as ResponsibilityRun;

function fixture(
  runs: ResponsibilityRun[],
  resumptionAccepted = true,
) {
  const resumed: { runId: string; response: unknown }[] = [];
  const continued: (string | undefined)[] = [];
  const store = {
    get: async () => responsibility,
    listRuns: async () => runs,
    resumeWaiting: async (
      _owner: string,
      runId: string,
      response: unknown,
    ) => {
      resumed.push({ runId, response });
      return resumptionAccepted;
    },
  } as Pick<ResponsibilityStore, "get" | "listRuns" | "resumeWaiting">;
  const plain: TurnRunner = async () => {
    throw new Error("A responsibility answer must not use the plain runner");
  };
  const respond = (id: string) =>
    resumePersonQuestion({
      ownerUserId,
      question: question(id),
      response: "Staging",
      messageId: "person-response:1",
      runTurn: plain,
      responsibilities: store,
      responsibilityTurn: ({ responsibilityRunId }) => {
        continued.push(responsibilityRunId);
        return async () => ({ replyText: "Recorded staging." });
      },
    });
  return { respond, resumed, continued };
}

describe("person question run correlation", () => {
  test("resumes the older originating run, not the newest run waiting on another question", async () => {
    const f = fixture([
      waitingRun("newer-task", "agent-run-B"),
      waitingRun("original-task", "agent-run-A"),
    ]);
    expect(await f.respond("agent-run-A")).toEqual({
      replyText: "",
      responsibilityId: responsibility.id,
    });
    expect(f.resumed).toEqual([{
      runId: "original-task",
      response: { content: "The person answered: Staging" },
    }]);
    expect(f.continued).toEqual([]);
  });

  test("does not resume a different run when the answered run is no longer waiting", async () => {
    const f = fixture([waitingRun("newer-task", "agent-run-B")]);
    expect(await f.respond("agent-run-A")).toEqual({
      replyText: "Recorded staging.",
      responsibilityId: responsibility.id,
    });
    expect(f.resumed).toEqual([]);
    // The detached turn must not gain another waiting run's progress authority.
    expect(f.continued).toEqual([undefined]);
  });

  test("supports a legacy single waiting run without continuation metadata", async () => {
    const f = fixture([waitingRun("only-task")]);
    await f.respond("older-run");
    expect(f.resumed.map((entry) => entry.runId)).toEqual(["only-task"]);
    expect(f.continued).toEqual([]);
  });

  test("does not guess between ambiguous legacy runs", async () => {
    const f = fixture([waitingRun("second-task"), waitingRun("first-task")]);
    await f.respond("older-run");
    expect(f.resumed).toEqual([]);
    expect(f.continued).toEqual([undefined]);
  });

  test("falls back to a detached answer if the matched run has already been resumed", async () => {
    const f = fixture([waitingRun("original-task", "agent-run-A")], false);
    await f.respond("agent-run-A");
    expect(f.resumed.map((entry) => entry.runId)).toEqual(["original-task"]);
    expect(f.continued).toEqual([undefined]);
  });
});
