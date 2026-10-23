import { describe, expect, test } from "bun:test";
import {
  FIRST_DAY_FRAME,
  FIRST_DAY_FRAME_WITHOUT_MAIL,
  frameFirstDay,
  readFirstDay,
} from "./first-day";
import { frameFiring, readFiring } from "./routine-firing";

const REQUEST =
  "Get to know me. Look through my recent mail and this week's calendar.";

describe("frameFirstDay", () => {
  test("puts the frame sentences above the request", () => {
    expect(frameFirstDay(REQUEST)).toBe(
      [...FIRST_DAY_FRAME, "", REQUEST].join("\n"),
    );
  });

  test("without mail, tells the model the app promised none", () => {
    const framed = frameFirstDay(REQUEST, { mail: false });
    expect(framed).toBe(
      [...FIRST_DAY_FRAME_WITHOUT_MAIL, "", REQUEST].join("\n"),
    );
    expect(framed).not.toContain("said you are reading their mail");
    expect(framed).toContain("can't see their mail or calendar yet");
  });

  test("keeps the first day free of reply buttons, with or without mail", () => {
    for (const framed of [
      frameFirstDay(REQUEST),
      frameFirstDay(REQUEST, { mail: false }),
    ]) {
      expect(framed).toContain(
        "Do not call suggest_replies in this turn: write the whole answer, in the shape the request asks for.",
      );
    }
  });
});

describe("readFirstDay", () => {
  test("gives back exactly the request that was framed", () => {
    expect(readFirstDay(frameFirstDay(REQUEST))).toBe(REQUEST);
  });

  test("reads the frame without mail too", () => {
    expect(readFirstDay(frameFirstDay(REQUEST, { mail: false }))).toBe(REQUEST);
  });

  test("still reads a first day sent with the earlier no-buttons sentence", () => {
    const stored = [
      FIRST_DAY_FRAME[0],
      FIRST_DAY_FRAME[1],
      "Do not call suggest_replies in this turn: write the whole answer, and end it with one question in words.",
      "",
      REQUEST,
    ].join("\n");
    expect(readFirstDay(stored)).toBe(REQUEST);
  });

  test("still reads a first day sent with the frame threads already hold", () => {
    const stored = [
      "This is your first conversation with this person: they have just opened the app for the first time and have not written anything yet, so the request below was sent for them.",
      "The app has already welcomed them in your voice and said you are reading their mail and calendar, so do not greet them or introduce yourself again: carry out the request in this turn and open with what you found.",
      "",
      REQUEST,
    ].join("\n");
    expect(readFirstDay(stored)).toBe(REQUEST);
  });

  test("keeps a request that runs over several lines whole", () => {
    const multi = "Read my mail.\n\nThen tell me how you can help.";
    expect(readFirstDay(frameFirstDay(multi))).toBe(multi);
  });

  test("says no to a message a person wrote themselves", () => {
    expect(readFirstDay(REQUEST)).toBeNull();
  });

  test("says no to a person quoting one line of the frame", () => {
    for (const line of [...FIRST_DAY_FRAME, ...FIRST_DAY_FRAME_WITHOUT_MAIL]) {
      expect(readFirstDay(line)).toBeNull();
      expect(readFirstDay(`${line}\n\n${REQUEST}`)).toBeNull();
    }
  });

  test("is a first-day message even when the request is blank", () => {
    expect(readFirstDay(frameFirstDay(""))).toBe("");
  });

  test("round-trips a request with leading and trailing whitespace, untrimmed", () => {
    const padded = "  get to know me  ";
    expect(readFirstDay(frameFirstDay(padded))).toBe(padded);
  });

  test("is not a routine firing, and a firing is not a first day", () => {
    expect(readFiring(frameFirstDay(REQUEST))).toBeNull();
    expect(readFirstDay(frameFiring(REQUEST))).toBeNull();
  });
});
