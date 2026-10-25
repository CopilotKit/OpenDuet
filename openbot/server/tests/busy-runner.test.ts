import { describe, expect, test } from "bun:test";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { signallingBusy } from "../src/approvals/busy-runner";

/**
 * A turn the server starts on its own, such as the continuation after Allow once, says the
 * conversation is busy while it runs, so the app's pill can show it.
 */
describe("a server-started turn announces itself", () => {
  const input = {
    ownerUserId: "u",
    routineId: "approval",
    agentId: "openduet",
    threadId: "thread-1",
    instruction: "",
  };

  test("busy before the turn, idle after it", async () => {
    const said: string[] = [];
    const runner: TurnRunner = async () => {
      said.push("turn");
      return { replyText: "Sent." };
    };
    const result = await signallingBusy(runner, async (threadId, busy) => {
      said.push(`${threadId}:${busy}`);
    })(input);
    expect(result).toEqual({ replyText: "Sent." });
    expect(said).toEqual(["thread-1:true", "turn", "thread-1:false"]);
  });

  test("idle again when the turn fails, and the failure still reaches the caller", async () => {
    const said: boolean[] = [];
    const failing: TurnRunner = async () => {
      throw new Error("model down");
    };
    await expect(
      signallingBusy(failing, async (_, busy) => {
        said.push(busy);
      })(input),
    ).rejects.toThrow("model down");
    expect(said).toEqual([true, false]);
  });

  test("an announcement that fails never fails the turn", async () => {
    const result = await signallingBusy(
      async () => ({ replyText: "Done." }),
      async () => {
        throw new Error("socket gone");
      },
    )(input);
    expect(result).toEqual({ replyText: "Done." });
  });
});

test("concurrent server invocations own different busy claims, even with the same logical run id", async () => {
  const active = new Set<string>();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const runner = signallingBusy(
    async () => {
      if (++calls === 1) await waiting;
      return { replyText: "Done." };
    },
    async (_, busy, runId) => {
      if (busy) active.add(runId);
      else active.delete(runId);
    },
  );
  const input = {
    ownerUserId: "u",
    routineId: "same",
    runId: "same",
    agentId: "bot",
    threadId: "thread",
    instruction: "",
  };
  const first = runner(input);
  await Promise.resolve();
  await runner(input);
  expect(active.size).toBe(1);
  release();
  await first;
  expect(active.size).toBe(0);
});
