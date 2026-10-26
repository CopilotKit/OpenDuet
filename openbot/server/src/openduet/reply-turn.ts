import { AsyncLocalStorage } from "node:async_hooks";
import type { BaseEvent } from "@ag-ui/client";
import { resolveModel } from "@copilotkit/runtime/v2";
import { readFirstDay } from "@openbot/shared/first-day";
import { readMorningBrief } from "@openbot/shared/morning-brief";
import { nativeRunWaiting } from "@openbot/toolkit/native-approval";
import { Observable } from "rxjs";
import type { PlanLanguageModel } from "../agents/plan-model";
import { REFUSAL_MARKER } from "../plugins/tools";
import {
  REPLIES_AFTER_APPROVAL,
  REPLIES_ALREADY_HELD,
  REPLIES_ALREADY_SHOWN,
  REPLIES_DRAWN_PREFIX,
  REPLIES_FIRST_DAY,
  REPLIES_HELD,
  REPLIES_MORNING_BRIEF,
  REPLIES_SHOWN,
  REPLIES_SHOWN_ASK,
  REPLIES_TOOL,
} from "./replies";

/*
 * Reply chips go under an answer, never in place of one. Enforced here, in code, because asking
 * did not work.
 *
 * A Bot asked "Ana emailed me. What does she want, and should I say yes?" read the mail and called
 * `suggest_replies` in the same step as the read, before writing a word. Told the buttons were on
 * screen and to ask "in one short sentence", it wrote only the closing question, and the person got
 * "Which reply should I draft?" with three chips and no answer: 7 runs of 9 on main. Wording in the
 * tool's description and its answer moved that to 9 of 10. So a built-in run checks each call
 * against the turn it is in:
 *
 * - A call made beside another tool in the same step, or before any answer was written (nothing in
 *   this turn, or nothing since the last other tool, because "Let me check" before a read is not
 *   the answer to it), is HELD. Its chips are drawn where the app draws every set, under the last
 *   words of the turn, and the Bot is told that nothing is on the person's screen yet, not even what
 *   it read, and to write the full answer it would write with no buttons.
 * - A call made after the answer, on its own, is SHOWN. When its question is already written the
 *   turn ENDS there: the next step's model call is answered "stop" without reaching the model
 *   (`endingTurns`), because told "write nothing more" the Bot still wrote a line about the buttons.
 * - A shown call replaces a held set, because the choices picked after the answer fit it better.
 *   A copy of the call in the same step gets the first one's answer word for word, and the app draws
 *   the last set of a turn only. A call in a later step, once a set was held or shown, is REFUSED,
 *   in words that match the set it lost to: "write your full answer" beside a held one, "end your
 *   turn" beside a shown one.
 * - A call made while another tool in its step waits on the person's approval is REFUSED: the next
 *   choice belongs under the reply once the action is done, not under an unanswered card. So is a
 *   call on the first day, whose replies the app draws itself, and one in a morning brief, whose
 *   card already holds what the person can start.
 *
 * WHY HELD AND NOT REFUSED. Refusing the early call, and telling the Bot to answer and call again,
 * was tried first, live, with five wordings over 22 turns. Once it said nothing was on screen, the
 * answer came every time, and the second call almost never did: the Bot put the choices in prose and
 * stopped, so the person lost the chips. Its early call already names the choices it means to offer;
 * holding it keeps them and still gets the answer written first.
 *
 * A refusal starts with "Refused.", which the app reads as "draw nothing".
 *
 * HOW THE STEP IS KNOWN. The AI SDK this runtime ships (ai 6) executes a step's tool calls only
 * once the model's output for that step has ended, all of them in one burst, and hands every one
 * the same array of messages the step was asked with. So every call is noted against that array as
 * it starts, and the chips call waits one macrotask before looking: by then every call in its step
 * has been noted. The run's own events are watched as well, for the words written in the step
 * before the call, which no message array holds yet, and for any call that runs elsewhere.
 *
 * HOW THE RUN IS KNOWN. `watchReplyTurn` wraps a built-in run's events, and the run is subscribed
 * inside an AsyncLocalStorage scope holding that run's turn, so the tool calls the run makes find
 * it. Concurrent runs each have their own. Anything executed outside a watched run, such as a
 * remote Bot's tool through the headless middleware, finds nothing and is answered as before.
 */

/** What the AI SDK hands a tool's `execute` beside its arguments. Only these parts are read. */
export type ToolExecution = {
  toolCallId?: string;
  /** The messages the step was asked with: one array per step, shared by its calls. */
  messages?: readonly unknown[];
};

type Step = { text: string; calls: string[] };
type Seen = { step: Step; text: string };
/** A tool call executed in a step, and its execution, which settles when the call answers or waits. */
type Executed = { name: string; settled: Promise<unknown> };
/** A set of chips in this turn: held under an answer still to come, or shown under one. */
type Drawn = "held" | "shown" | null;

type Turn = {
  /** The tool calls executed in each step, keyed by the step's message array. */
  executed: WeakMap<object, Executed[]>;
  /** The step the run's events are in, and whether its tools have answered (it is over). */
  step: Step;
  answered: boolean;
  /** Each call's step, and what had been written in that step when the call started. */
  seen: Map<string, Seen>;
  waiting: Map<string, () => void>;
  /** The set of chips held or shown in this run, if any. */
  drawn: Drawn;
  /** The first chips call's answer in each step, which every copy beside it gets too. */
  firstInStep: WeakMap<object, Promise<string>>;
  /** The answer and its chips are on screen: the run takes no further step. */
  ended: boolean;
};

const turns = new AsyncLocalStorage<Turn>();

/** How long to wait for a call's own start event before deciding without it. */
const SEEN_TIMEOUT_MS = 2_000;

/**
 * A built-in run's events, watched for what the chips guard needs, with the run subscribed inside
 * that run's own turn.
 */
export function watchReplyTurn(
  events: Observable<BaseEvent>,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const turn: Turn = {
      executed: new WeakMap(),
      step: { text: "", calls: [] },
      answered: false,
      seen: new Map(),
      waiting: new Map(),
      drawn: null,
      firstInStep: new WeakMap(),
      ended: false,
    };
    const subscription = turns.run(turn, () =>
      events.subscribe({
        next(event) {
          note(turn, event);
          subscriber.next(event);
        },
        error: (error) => subscriber.error(error),
        complete: () => subscriber.complete(),
      }),
    );
    return () => {
      subscription.unsubscribe();
      for (const release of turn.waiting.values()) release();
      turn.waiting.clear();
    };
  });
}

function note(turn: Turn, event: BaseEvent) {
  const fields = event as BaseEvent & {
    delta?: unknown;
    toolCallId?: unknown;
    toolCallName?: unknown;
  };
  // A step's tool results come after everything its model wrote, so the next words or call after
  // one begins a new step.
  const begin = () => {
    if (!turn.answered) return;
    turn.step = { text: "", calls: [] };
    turn.answered = false;
  };
  switch (event.type) {
    case "TEXT_MESSAGE_CHUNK":
    case "TEXT_MESSAGE_CONTENT":
      if (typeof fields.delta !== "string" || fields.delta === "") return;
      begin();
      turn.step.text += fields.delta;
      return;
    case "TOOL_CALL_START": {
      if (typeof fields.toolCallId !== "string") return;
      begin();
      turn.seen.set(fields.toolCallId, {
        step: turn.step,
        text: turn.step.text,
      });
      turn.step.calls.push(
        typeof fields.toolCallName === "string" ? fields.toolCallName : "",
      );
      turn.waiting.get(fields.toolCallId)?.();
      turn.waiting.delete(fields.toolCallId);
      return;
    }
    case "TOOL_CALL_RESULT":
      turn.answered = true;
      return;
  }
}

/**
 * Notes a call against its step, with its execution. Called for every tool, the moment the SDK
 * executes it.
 */
export function noteToolStep(
  name: string,
  execution: ToolExecution | undefined,
  settled: Promise<unknown>,
) {
  const turn = turns.getStore();
  const step = execution?.messages;
  if (!turn || !step) return;
  turn.executed.set(step, [
    ...(turn.executed.get(step) ?? []),
    { name, settled },
  ]);
}

/**
 * The answer to a `suggest_replies` call: refused while its step waits on an approval, on the first
 * day, or when a set was already drawn this turn; held when it came before the answer; and otherwise
 * shown, which ends the turn when the question is written. The tool's own check of the replies
 * (`run`) still decides whether they are drawn at all.
 */
export async function answerReplies(
  execution: ToolExecution | undefined,
  run: () => Promise<string>,
): Promise<string> {
  const turn = turns.getStore();
  const id = execution?.toolCallId;
  if (!turn || !id) return run();

  // Every call in this step is executed in the same burst; one macrotask on, all have been noted.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const seen = await seenCall(turn, id);
  const step = execution?.messages
    ? (turn.executed.get(execution.messages) ?? [])
    : [];
  /*
   * Every other tool in the step is let finish first, because a send held for the person's approval
   * only stops the run once the gate has read its policy and written the request. Deciding sooner
   * drew the chips under the waiting card. Copies of this call are not waited on: they wait on these.
   */
  await Promise.allSettled(
    step
      .filter((call) => call.name !== REPLIES_TOOL)
      .map((call) => call.settled),
  );
  /*
   * A copy of a chips call in the same step gets the first call's answer, word for word. The model
   * often sends two or three at once; answered differently, it followed whichever one told it to
   * stop and wrote "Nothing more to add for now." in place of its answer. The app draws the last set
   * of a turn only, so the copies still make one row.
   */
  const key = execution?.messages;
  const first = key ? turn.firstInStep.get(key) : undefined;
  if (first) return first;
  const answering = decide(turn, execution, seen, step, run);
  if (key) turn.firstInStep.set(key, answering);
  return answering;
}

async function decide(
  turn: Turn,
  execution: ToolExecution | undefined,
  seen: Seen | undefined,
  step: Executed[],
  run: () => Promise<string>,
): Promise<string> {
  if (nativeRunWaiting()) return REPLIES_AFTER_APPROVAL;
  const messages = execution?.messages ?? [];
  const asked = lastPersonText(messages);
  if (readFirstDay(asked) !== null) return REPLIES_FIRST_DAY;
  if (readMorningBrief(asked) !== null) return REPLIES_MORNING_BRIEF;
  const earlier = earlierInTurn(messages);

  // A copy of the chips call beside it is not a read; any other tool is.
  const beside = [
    ...step.map((call) => call.name),
    ...(seen?.step.calls ?? []),
  ].some((name) => name !== REPLIES_TOOL);
  // Words in this step before the call, or else the answer written since the last other tool.
  const written = seen?.text.trim() ? seen.text : earlier.text;
  const answered = written.trim() !== "";
  const early = beside || !answered;

  /*
   * Checked and claimed with no await between. A shown set is never replaced; a held one is, by a
   * call made after the answer.
   */
  const sets = [turn.drawn, earlier.drawn];
  const prior: Drawn = sets.includes("shown")
    ? "shown"
    : sets.includes("held")
      ? "held"
      : null;
  if (prior === "shown") {
    if (!beside && answered) turn.ended = true;
    return REPLIES_ALREADY_SHOWN;
  }
  if (prior === "held" && early) return REPLIES_ALREADY_HELD;
  const before = turn.drawn;
  turn.drawn = early ? "held" : "shown";

  const answer = await run();
  if (answer.startsWith(REFUSAL_MARKER)) {
    turn.drawn = before;
    return answer;
  }
  if (early) return REPLIES_HELD;
  if (!asksAQuestion(written)) return REPLIES_SHOWN_ASK;
  turn.ended = true;
  return REPLIES_SHOWN;
}

/**
 * The text of the person's last message, which says whether this turn is one the app asked for in
 * their place: the first day's request, or a later day's morning brief, framed as the app sends them.
 */
function lastPersonText(messages: readonly unknown[]): string {
  const person = messages.findLast((message) => roleOf(message) === "user");
  const content = (person as { content?: unknown } | undefined)?.content;
  return typeof content === "string"
    ? content
    : partsOf(content)
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("");
}

/** The call's start as the run's events carried it, waited for briefly if it has not arrived. */
function seenCall(turn: Turn, id: string): Promise<Seen | undefined> {
  const seen = turn.seen.get(id);
  if (seen) return Promise.resolve(seen);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      turn.waiting.delete(id);
      resolve(turn.seen.get(id));
    }, SEEN_TIMEOUT_MS);
    turn.waiting.set(id, () => {
      clearTimeout(timer);
      resolve(turn.seen.get(id));
    });
  });
}

type Part = {
  type?: unknown;
  text?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  output?: unknown;
};

/**
 * What the turn so far holds, from the messages the step was asked with: the person's last message
 * and everything after it, which includes this run's earlier steps and anything a resumed run
 * carried in.
 *
 * `text` is what was written since the last tool the Bot called other than this one. `drawn` is the
 * set of chips already held or shown: any earlier call counts unless it was refused or rejected,
 * and one with no answer at all counts as held. A built-in run's history sanitizer drops such a call
 * before the run starts, so on that path it is the app that keeps one set per turn (`repliesLast`).
 */
function earlierInTurn(messages: readonly unknown[]): {
  text: string;
  drawn: Drawn;
} {
  let start = 0;
  messages.forEach((message, index) => {
    if (roleOf(message) === "user") start = index + 1;
  });
  let text = "";
  const calls = new Map<string, Drawn>();
  for (const message of messages.slice(start)) {
    const role = roleOf(message);
    const content = (message as { content?: unknown }).content;
    if (role === "assistant") {
      if (typeof content === "string") text += content;
      for (const part of partsOf(content)) {
        if (part.type === "text" && typeof part.text === "string")
          text += part.text;
        if (part.type === "tool-call" && part.toolName !== REPLIES_TOOL)
          text = "";
        if (
          part.type === "tool-call" &&
          part.toolName === REPLIES_TOOL &&
          typeof part.toolCallId === "string"
        )
          calls.set(part.toolCallId, "held");
      }
    }
    if (role === "tool")
      for (const part of partsOf(content))
        if (
          part.type === "tool-result" &&
          typeof part.toolCallId === "string" &&
          calls.has(part.toolCallId)
        )
          calls.set(part.toolCallId, drawnBy(part.output));
  }
  const sets = [...calls.values()];
  return {
    text,
    drawn: sets.includes("shown")
      ? "shown"
      : sets.includes("held")
        ? "held"
        : null,
  };
}

/**
 * What an answer to the chips call drew. Nothing for a refusal or for the runtime's own rejection of
 * the arguments ("Error: Invalid input…", an `error-text` output inside a run), which never reached
 * the tool.
 */
function drawnBy(output: unknown): Drawn {
  const kind =
    output && typeof output === "object"
      ? (output as { type?: unknown }).type
      : undefined;
  if (typeof kind === "string" && kind.startsWith("error")) return null;
  const answer = resultText(output);
  if (answer.startsWith(REFUSAL_MARKER) || answer.startsWith("Error:"))
    return null;
  return answer.startsWith(`${REPLIES_DRAWN_PREFIX} held`) ? "held" : "shown";
}

function roleOf(message: unknown): unknown {
  return message && typeof message === "object"
    ? (message as { role?: unknown }).role
    : undefined;
}

function partsOf(content: unknown): Part[] {
  return Array.isArray(content)
    ? content.filter((part): part is Part => !!part && typeof part === "object")
    : [];
}

/** A tool result's text, unwrapped from the extra JSON encoding a stored thread gives it. */
function resultText(output: unknown): string {
  const value =
    output && typeof output === "object"
      ? (output as { value?: unknown }).value
      : output;
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    const decoded: unknown = JSON.parse(trimmed);
    return typeof decoded === "string" ? decoded.trim() : trimmed;
  } catch {
    return trimmed;
  }
}

/** Whether the words end on a question: their last line asks one. */
function asksAQuestion(text: string): boolean {
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? "").includes("?");
}

type Model = PlanLanguageModel;
type StreamResult = Awaited<ReturnType<Model["doStream"]>>;

/**
 * The model a built-in run steps with, answering "stop" once the run's turn has ended.
 *
 * WHY HERE. The runtime's agent takes a step count and no stop condition of its own, and every step
 * after the first is the model answering the tools of the step before. So the seam that ends the turn
 * is the next model call: once the chips are shown under a question already asked, that call returns
 * a finished, empty step without reaching the model, and the step loop ends there as it does after
 * any reply with no tool calls. Nothing is written after the chips, and nothing is paid for.
 *
 * Resolved the way the runtime resolves it, on first use, from the same specifier and key.
 */
export function endingTurns(model: string | Model, apiKey?: string): Model {
  let inner: Model | undefined;
  const resolved = () => {
    inner ??= resolveModel(model, apiKey) as Model;
    return inner;
  };
  return {
    get specificationVersion() {
      return resolved().specificationVersion;
    },
    get provider() {
      return resolved().provider;
    },
    get modelId() {
      return resolved().modelId;
    },
    get supportedUrls() {
      return resolved().supportedUrls;
    },
    doGenerate: (options) => resolved().doGenerate(options),
    doStream: (options) =>
      turns.getStore()?.ended
        ? Promise.resolve(endedStep())
        : resolved().doStream(options),
  } as Model;
}

function endedStep(): StreamResult {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: {
              total: undefined,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: undefined,
              text: undefined,
              reasoning: undefined,
            },
          },
        });
        controller.close();
      },
    }),
  };
}
