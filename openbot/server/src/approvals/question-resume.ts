import { PERSON_INITIATOR } from "../audit";
import type {
  Responsibility,
  ResponsibilityStore,
} from "../responsibilities/types";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import {
  type PersonQuestion,
  questionConversationBot,
  questionResponseMessage,
} from "./questions";
import { ApprovalRefusedError } from "./types";

/** The waiting kind a responsibility run is suspended under while its question is unanswered. */
export const PERSON_QUESTION_WAITING = "person_question";

/**
 * A person's answer to a Bot's question, resumed as the same kind of turn that asked it.
 *
 * The answer goes back into the same conversation as a user message either way. What differs is the
 * turn around it: a question asked by a responsibility's run must come back to that responsibility,
 * run with its tools (`report_responsibility_progress` bound to its latest run) and its initiator,
 * or the Bot can read the answer but cannot record progress or complete the goal it was working on.
 * A question from anything else keeps the initiator it was asked under rather than becoming a
 * person's own turn.
 */
export async function resumePersonQuestion(input: {
  ownerUserId: string;
  question: PersonQuestion;
  response: string;
  messageId: string;
  /** The ordinary headless runner: computer tools, the question's own initiator. */
  runTurn: TurnRunner;
  responsibilities?: Pick<
    ResponsibilityStore,
    "get" | "listRuns" | "resumeWaiting"
  >;
  /** A runner carrying the responsibility's own tools, bound to one of its runs. */
  responsibilityTurn?: (goal: {
    responsibility: Responsibility;
    responsibilityRunId: string | undefined;
  }) => TurnRunner;
}): Promise<{ replyText: string; responsibilityId?: string }> {
  const { question, ownerUserId } = input;
  if (question.actorId !== ownerUserId)
    throw new ApprovalRefusedError("The saved question owner does not match.");
  const agentId = questionConversationBot(question);
  const userMessage = questionResponseMessage(
    question,
    input.response,
    input.messageId,
  );
  const initiator = question.initiator ?? PERSON_INITIATOR;
  if (
    initiator.kind === "responsibility" &&
    input.responsibilities &&
    input.responsibilityTurn
  ) {
    // Owner-scoped: another person's responsibility id is not found.
    const responsibility = await input.responsibilities.get(
      ownerUserId,
      initiator.id,
    );
    if (
      responsibility.threadId !== question.threadId ||
      responsibility.agentId !== agentId
    )
      throw new ApprovalRefusedError(
        "That answer does not belong to this responsibility's conversation.",
      );
    const runs = await input.responsibilities.listRuns(
      ownerUserId,
      responsibility.id,
    );
    const [latest] = runs;
    /*
     * Concurrent events can create several runs for one responsibility. The newest run may
     * be waiting for a different question: resuming it with this older question's answer
     * consumes the wrong interrupt and leaves the original question unanswered.
     *
     * A headless suspension carries the AG-UI runId in its continuation; use it to find
     * the run that actually asked this question, even when it is not the newest one.
     * Older waiting records without a continuation remain supported only when there is
     * exactly one run to resume, so ambiguous legacy records cannot cross-answer.
     */
    const waitingForQuestion = runs.find((run) => {
      if (
        run.status !== "waiting" ||
        run.waiting?.kind !== PERSON_QUESTION_WAITING
      )
        return false;
      const continuation = run.waiting.continuation;
      return (
        continuation !== null &&
        typeof continuation === "object" &&
        "runId" in continuation &&
        continuation.runId === question.runId
      );
    }) ?? (
      runs.length === 1 &&
      latest?.status === "waiting" &&
      latest.waiting?.kind === PERSON_QUESTION_WAITING &&
      !latest.waiting.continuation
        ? latest
        : undefined
    );
    if (waitingForQuestion) {
      const resumed = await input.responsibilities.resumeWaiting(
        ownerUserId,
        waitingForQuestion.id,
        { content: `The person answered: ${input.response}` },
      );
      if (resumed)
        return { replyText: "", responsibilityId: responsibility.id };
    }
    // Never bind a detached answer to some *other* suspended run's progress tools.
    const run = input.responsibilityTurn({
      responsibility,
      responsibilityRunId: latest?.status === "waiting" ? undefined : latest?.id,
    });
    const outcome = await run({
      ownerUserId,
      routineId: responsibility.id,
      agentId,
      threadId: question.threadId,
      initiator,
      instruction: "",
      userMessage,
    });
    return { ...outcome, responsibilityId: responsibility.id };
  }
  return input.runTurn({
    ownerUserId,
    routineId: "person-response",
    agentId,
    threadId: question.threadId,
    initiator,
    instruction: "",
    userMessage,
  });
}
