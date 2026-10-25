/** Shared contract for the browser evals. Only settled, nonempty answers may be scored. */
export type ChatSnapshot = {
  turn: "busy" | "idle" | "unknown";
  questionVisible: boolean;
  approval: boolean;
  stopped: string | null;
  bubbles: string[];
  chips: string[];
  listItems: number;
};

export type CompletedReply = {
  status: "completed";
  ask: string;
  channelId: string;
  elapsedMs: number;
  bubbles: string[];
  chips: string[];
  listItems: number;
};
export type FailedReply = {
  status: "failed";
  ask: string;
  channelId?: string;
  elapsedMs: number;
  reason: "timeout" | "approval" | "stopped" | "empty" | "error";
  detail: string;
  lastSnapshot?: ChatSnapshot;
};
export type ReplySample = CompletedReply | FailedReply;

export async function waitForReply({
  ask,
  channelId,
  read,
  wait,
  now = Date.now,
  timeoutMs = 150_000,
  settleMs = 3000,
  pollMs = 1000,
}: {
  ask: string;
  channelId: string;
  read: () => Promise<ChatSnapshot>;
  wait: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  settleMs?: number;
  pollMs?: number;
}): Promise<ReplySample> {
  const started = now();
  let lastSnapshot: ChatSnapshot | undefined;
  let stableSince: number | undefined;
  let lastContent: string | undefined;
  const failed = (
    reason: FailedReply["reason"],
    detail: string,
  ): FailedReply => ({
    status: "failed",
    ask,
    channelId,
    reason,
    detail,
    elapsedMs: now() - started,
    lastSnapshot,
  });
  try {
    while (now() - started < timeoutMs) {
      lastSnapshot = await read();
      // Reading the page can itself cross the deadline; it must not turn a timeout into a pass.
      if (now() - started >= timeoutMs) break;
      if (lastSnapshot.approval) {
        return failed("approval", "The turn paused for Allow once.");
      }
      if (lastSnapshot.stopped) {
        return failed("stopped", lastSnapshot.stopped);
      }
      const content = JSON.stringify([
        lastSnapshot.bubbles,
        lastSnapshot.chips,
        lastSnapshot.listItems,
      ]);
      if (lastSnapshot.turn !== "idle" || !lastSnapshot.questionVisible) {
        stableSince = undefined;
      } else if (content !== lastContent || stableSince === undefined) {
        stableSince = now();
      } else if (now() - stableSince >= settleMs) {
        if (!lastSnapshot.bubbles.some((bubble) => bubble.trim().length > 0)) {
          return failed(
            "empty",
            "The turn settled without an assistant answer.",
          );
        }
        return {
          status: "completed",
          ask,
          channelId,
          elapsedMs: now() - started,
          bubbles: lastSnapshot.bubbles,
          chips: lastSnapshot.chips,
          listItems: lastSnapshot.listItems,
        };
      }
      lastContent = content;
      await wait(Math.min(pollMs, timeoutMs - (now() - started)));
    }
    return failed("timeout", `The turn did not settle within ${timeoutMs}ms.`);
  } catch (error) {
    return failed(
      "error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Stop on the first failed sample: navigating onward would interrupt an unfinished turn. */
export async function sampleBatch<T>({
  questions,
  open,
  ask,
  close,
}: {
  questions: readonly string[];
  open: () => Promise<T>;
  ask: (page: T, question: string) => Promise<ReplySample>;
  close: () => Promise<void>;
}): Promise<ReplySample[]> {
  try {
    const page = await open();
    const samples: ReplySample[] = [];
    for (const question of questions) {
      const sample = await ask(page, question);
      samples.push(sample);
      if (sample.status === "failed") break;
    }
    return samples;
  } finally {
    await close();
  }
}

/** Guard the complete question set before computing any metrics, including zero-word budgets. */
export function completedReplies(
  samples: readonly ReplySample[],
  questions: readonly string[],
): CompletedReply[] | null {
  if (samples.length !== questions.length || questions.length === 0)
    return null;
  const completed: CompletedReply[] = [];
  for (const [index, sample] of samples.entries()) {
    if (
      sample.status !== "completed" ||
      sample.ask !== questions[index] ||
      !sample.bubbles.some((bubble) => bubble.trim().length > 0)
    ) {
      return null;
    }
    completed.push(sample);
  }
  return completed;
}

export function samplingFailureReport(
  samples: readonly ReplySample[],
  questions: readonly string[],
): string {
  return [
    "FAIL: sampling did not produce a completed, nonempty answer for every question.",
    "Voice/chip metrics were not calculated. Partial text below is diagnostic evidence only.",
    `Attempted ${samples.length}/${questions.length} questions.`,
    "",
    "```json",
    JSON.stringify(
      { samples, unattempted: questions.slice(samples.length) },
      null,
      2,
    ),
    "```",
    "",
  ].join("\n");
}
