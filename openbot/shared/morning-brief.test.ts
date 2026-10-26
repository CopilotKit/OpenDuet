import { describe, expect, test } from "bun:test";
import { frameCheckIn, readCheckIn } from "./check-in";
import { frameFirstDay, readFirstDay } from "./first-day";
import {
  frameMorningBrief,
  localDateOf,
  MORNING_BRIEF_FRAME,
  MORNING_BRIEF_TOOL,
  readMorningBrief,
  utcMidnightOf,
} from "./morning-brief";
import { frameFiring, readFiring } from "./routine-firing";
import { frameTaskBrief, readTaskBrief } from "./task-brief";

const REQUEST = "Give me my morning brief.";

describe("frameMorningBrief", () => {
  test("puts the frame sentences above the request", () => {
    expect(frameMorningBrief(REQUEST)).toBe(
      [...MORNING_BRIEF_FRAME, "", REQUEST].join("\n"),
    );
  });

  test("tells the model nobody typed it, to call the brief, and to say exactly one sentence", () => {
    const frame = MORNING_BRIEF_FRAME.join(" ");
    expect(frame).toContain("Nobody typed this.");
    expect(frame).toContain("first time today");
    expect(frame).toContain(`Call ${MORNING_BRIEF_TOOL} once.`);
    expect(frame).toContain("exactly one sentence of at most twenty words");
    // The second sentence a real brief added was an offer of help, so it is named, not implied.
    expect(frame).toContain("no second sentence, no offer of help");
  });

  test("keeps the model's reply buttons off the brief", () => {
    expect(frameMorningBrief(REQUEST)).toContain(
      "Do not call suggest_replies in this turn",
    );
  });
});

describe("readMorningBrief", () => {
  test("gives back exactly the request that was framed", () => {
    expect(readMorningBrief(frameMorningBrief(REQUEST))).toBe(REQUEST);
    const multi = `${REQUEST}\n\nKeep it short.`;
    expect(readMorningBrief(frameMorningBrief(multi))).toBe(multi);
    const padded = `  ${REQUEST}  `;
    expect(readMorningBrief(frameMorningBrief(padded))).toBe(padded);
  });

  test("is still a brief around a blank request", () => {
    expect(readMorningBrief(frameMorningBrief(""))).toBe("");
  });

  test("still reads a brief posted under the frame before this wording", () => {
    // Verbatim as it was sent, so a thread holding one keeps drawing it as nobody's bubble.
    const retired = [
      "Nobody typed this. The person has just opened the app for the first time today, and the app sent the request below for them, so the day's brief is waiting when they look.",
      `Call ${MORNING_BRIEF_TOOL} once. The app shows what it returns as a card that already greets them, so do not greet them or repeat what it lists. After it, add at most one short sentence, on the one thing that matters most today or on what could not be checked, and do nothing else this turn.`,
      "Do not call suggest_replies in this turn: the brief's card already puts Start on each thing that needs them.",
      "",
      REQUEST,
    ].join("\n");
    expect(readMorningBrief(retired)).toBe(REQUEST);
  });

  test("says no to a message a person wrote themselves", () => {
    expect(readMorningBrief(REQUEST)).toBeNull();
  });

  test("says no to a person quoting one line of the frame", () => {
    for (const line of MORNING_BRIEF_FRAME) {
      expect(readMorningBrief(line)).toBeNull();
      expect(readMorningBrief(`${line}\n\n${REQUEST}`)).toBeNull();
    }
  });

  test("is not mistaken for any other frame, nor they for it", () => {
    const framed = frameMorningBrief(REQUEST);
    expect(readFirstDay(framed)).toBeNull();
    expect(readFiring(framed)).toBeNull();
    expect(readTaskBrief(framed)).toBeNull();
    expect(readCheckIn(framed)).toBeNull();
    expect(readMorningBrief(frameFirstDay(REQUEST))).toBeNull();
    expect(readMorningBrief(frameFiring(REQUEST))).toBeNull();
    expect(readMorningBrief(frameTaskBrief(REQUEST))).toBeNull();
    expect(
      readMorningBrief(
        frameCheckIn({ checkedAt: "2026-10-26T08:00:00.000Z", offers: [] }),
      ),
    ).toBeNull();
  });
});

describe("the local date", () => {
  test("is the browser's own calendar date, zero-padded", () => {
    expect(localDateOf(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDateOf(new Date(2026, 9, 26, 0, 0))).toBe("2026-10-26");
  });

  test("reads a real date to its UTC midnight and refuses anything else", () => {
    expect(utcMidnightOf("2026-10-26")).toBe(Date.UTC(2026, 9, 26));
    expect(utcMidnightOf("2028-02-29")).toBe(Date.UTC(2028, 1, 29));
    for (const bad of [
      "2026-02-30",
      "2026-13-01",
      "2026-10-26T00:00:00Z",
      "26-10-2026",
      "2026-1-5",
      "",
    ])
      expect(utcMidnightOf(bad)).toBeNull();
  });
});
