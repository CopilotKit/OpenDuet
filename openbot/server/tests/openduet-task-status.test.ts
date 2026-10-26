import { describe, expect, test } from "bun:test";
import {
  readTaskStatus,
  TASK_NEXT_MAX,
  TASK_STATUS_TOOL,
  taskStatusTools,
} from "../src/openduet/task-status";

/**
 * `task_status`: the Bot saying where a task stands, for the row on Tasks, instead of the row being
 * read out of whichever paragraph the reply ended on.
 */

const [tool] = taskStatusTools({ initiator: { kind: "person" } });

describe("task_status", () => {
  test("is an OpenDuet tool that takes a status and one line", async () => {
    expect(tool?.name).toBe(TASK_STATUS_TOOL);
    expect(tool?.ref).toBe("openduet/task_status");
    const noted = await tool?.execute({
      status: "needs_you",
      next: "Send me the label sizes",
    });
    expect(noted).not.toStartWith("Refused");
    // Called before the reply was written, it must not read as "you're done here".
    expect(noted).toContain("write that now");
  });

  test("refuses anything but needs_you or done, an empty line, a long one, or more", async () => {
    for (const args of [
      { status: "maybe", next: "Soon" },
      { status: "done", next: "   " },
      { status: "done", next: "x".repeat(TASK_NEXT_MAX + 1) },
      { status: "done", next: "Ready", extra: true },
      undefined,
    ])
      expect(await tool?.execute(args as never)).toStartWith("Refused.");
  });

  test("says where it should be called, and that the reply still has to say it", () => {
    expect(tool?.description).toContain("Only in a task's own conversation");
    expect(tool?.description).toContain("at the end of every turn");
    expect(tool?.description).toContain("your reply must still say");
  });
});

describe("reading what the turn said through it", () => {
  test("the last valid call wins, other tools and bad calls are passed over", () => {
    expect(
      readTaskStatus([
        { name: TASK_STATUS_TOOL, args: { status: "needs_you", next: "A" } },
        { name: "suggest_replies", args: { replies: ["Yes", "No"] } },
        { name: TASK_STATUS_TOOL, args: { status: "done", next: "B" } },
        { name: TASK_STATUS_TOOL, args: { status: "later", next: "C" } },
      ]),
    ).toEqual({ status: "done", next: "B" });
  });

  test("nothing said is null, so the reply's prose decides", () => {
    expect(readTaskStatus(undefined)).toBeNull();
    expect(readTaskStatus([])).toBeNull();
    expect(
      readTaskStatus([{ name: TASK_STATUS_TOOL, args: { status: "done" } }]),
    ).toBeNull();
  });
});
