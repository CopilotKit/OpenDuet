import { AsyncLocalStorage } from "node:async_hooks";
import type { BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";
import { REFUSAL_MARKER } from "../plugins/tools";
import {
  REPLIES_ALREADY_SHOWN,
  REPLIES_DRAWN_PREFIX,
  REPLIES_HELD,
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
 * - A call made after the answer, on its own, is SHOWN, and the Bot is told to end its turn when
 *   its question is already written, so the question is not drawn twice.
 * - Any call once a set was held or shown this turn is REFUSED, so one row is drawn per turn.
 *
 * WHY HELD AND NOT REFUSED. Refusing the early call, and telling the Bot to answer and call again,
 * was tried first, live, with five wordings and twenty turns. The answer came every time, and the
 * second call almost never did: the Bot put the choices in prose and stopped, so the person lost
 * the chips. Its early call already names the choices it means to offer; holding it keeps them and
 * still gets the answer written first.
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

type Turn = {
  /** The names of the tool calls executed in each step, keyed by the step's message array. */
  executed: WeakMap<object, string[]>;
  /** The step the run's events are in, and whether its tools have answered (it is over). */
  step: Step;
  answered: boolean;
  /** Each call's step, and what had been written in that step when the call started. */
  seen: Map<string, Seen>;
  waiting: Map<string, () => void>;
  /** A set of chips was held or shown in this run. */
  drawn: boolean;
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
      drawn: false,
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

/** Notes a call against its step. Called for every tool, the moment the SDK executes it. */
export function noteToolStep(
  name: string,
  execution: ToolExecution | undefined,
) {
  const turn = turns.getStore();
  const step = execution?.messages;
  if (!turn || !step) return;
  turn.executed.set(step, [...(turn.executed.get(step) ?? []), name]);
}

/**
 * The answer to a `suggest_replies` call: refused when a set was already drawn this turn, held when
 * it came before the answer, and otherwise shown, told to end the turn or to ask its question. The
 * tool's own check of the replies (`run`) still decides whether they are drawn at all.
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
  const earlier = earlierInTurn(execution?.messages ?? []);

  /*
   * Checked and claimed with no await between, so of two calls in one step only the first finds the
   * turn free. A copy of the chips call beside it is not a read; any other tool is.
   */
  if (turn.drawn || earlier.drawn) return REPLIES_ALREADY_SHOWN;
  const executed = execution?.messages
    ? (turn.executed.get(execution.messages) ?? [])
    : [];
  const beside = [...executed, ...(seen?.step.calls ?? [])].some(
    (name) => name !== REPLIES_TOOL,
  );
  // Words in this step before the call, or else the answer written since the last other tool.
  const written = seen?.text.trim() ? seen.text : earlier.text;
  turn.drawn = true;

  const answer = await run();
  if (answer.startsWith(REFUSAL_MARKER)) {
    turn.drawn = false;
    return answer;
  }
  if (beside || !written.trim()) return REPLIES_HELD;
  return asksAQuestion(written) ? REPLIES_SHOWN : REPLIES_SHOWN_ASK;
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
 * `text` is what was written since the last tool the Bot called other than this one. `drawn` is
 * whether chips were already held or shown.
 */
function earlierInTurn(messages: readonly unknown[]): {
  text: string;
  drawn: boolean;
} {
  let start = 0;
  messages.forEach((message, index) => {
    if (roleOf(message) === "user") start = index + 1;
  });
  let text = "";
  let drawn = false;
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
      }
    }
    /*
     * Drawn only when the answer says so. Not "anything but a refusal": arguments the runtime
     * rejects never reach the tool, and its own "Error: Invalid input…" drew nothing either.
     */
    if (role === "tool")
      for (const part of partsOf(content))
        if (
          part.type === "tool-result" &&
          part.toolName === REPLIES_TOOL &&
          resultText(part.output).startsWith(REPLIES_DRAWN_PREFIX)
        )
          drawn = true;
  }
  return { text, drawn };
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
