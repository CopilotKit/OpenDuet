import type { TurnRunner } from "@openbot/toolkit/run-turn";

/**
 * A turn runner that tells the conversation it is busy for as long as the turn runs.
 *
 * A run the browser starts is announced by the runtime (`onRunBusy`), but a turn the server starts
 * on its own is not: the continuation after Allow once ran for about 20 seconds with nothing on the
 * person's screen saying the Bot was working, then the answer simply appeared. The roster's busy
 * flag is what the app's header pill reads for work it did not start, so this sets it around the
 * turn and clears it however the turn ends. A failure to announce never fails the turn.
 */
export function signallingBusy(
  runner: TurnRunner,
  signalBusy: (threadId: string, busy: boolean, runId: string) => Promise<void>,
): TurnRunner {
  return async (input) => {
    const busyOwner = `server-turn:${crypto.randomUUID()}`;
    await signalBusy(input.threadId, true, busyOwner).catch(() => undefined);
    try {
      return await runner(input);
    } finally {
      await signalBusy(input.threadId, false, busyOwner).catch(() => undefined);
    }
  };
}
