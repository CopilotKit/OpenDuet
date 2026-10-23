import { describe, expect, test } from "bun:test";
import { readCheckIn } from "./check-in";
import { readFirstDay } from "./first-day";
import {
  frameTaskBrief,
  frameTaskReply,
  readTaskBrief,
  START_TASK_TOOL,
  TASK_FRAME,
} from "./task-brief";

const ASK =
  "Draft a reply to Rosa saying we'll take Oat Satin instead of the discontinued glaze.";

describe("frameTaskBrief", () => {
  test("puts the frame above the person's ask, and tells the Bot not to hand the task on", () => {
    expect(frameTaskBrief(ASK)).toBe([...TASK_FRAME, "", ASK].join("\n"));
    expect(TASK_FRAME.join(" ")).toContain(`Never call ${START_TASK_TOOL}`);
  });
});

describe("readTaskBrief", () => {
  test("gives back exactly the ask, over several lines too", () => {
    expect(readTaskBrief(frameTaskBrief(ASK))).toBe(ASK);
    const multi = "Prepare notes.\n\nSource: https://mail.google.com/x";
    expect(readTaskBrief(frameTaskBrief(multi))).toBe(multi);
  });

  test("gives back only the person's words from a reply to a failed task, which still carries the ask", () => {
    const framed = frameTaskReply(ASK, "Use the Oat Satin glaze.");
    expect(framed).toContain(ASK);
    expect(readTaskBrief(framed)).toBe("Use the Oat Satin glaze.");
    expect(readTaskBrief(frameTaskReply(ASK, "Two lines.\n\nNo more."))).toBe(
      "Two lines.\n\nNo more.",
    );
  });

  test("says no to a message the person wrote, or one line of the frame quoted back", () => {
    expect(readTaskBrief(ASK)).toBeNull();
    expect(readTaskBrief(`${TASK_FRAME[0]}\n\n${ASK}`)).toBeNull();
  });

  test("is not mistaken for the other frames, nor they for it", () => {
    expect(readFirstDay(frameTaskBrief(ASK))).toBeNull();
    expect(readCheckIn(frameTaskBrief(ASK))).toBeNull();
  });
});
