import { describe, expect, test } from "bun:test";
import { FIRST_DAY_FRAME, frameFirstDay, readFirstDay } from "./first-day";
import { frameFiring, readFiring } from "./routine-firing";

const REQUEST =
  "Get to know me. Look through my recent mail and this week's calendar.";

describe("frameFirstDay", () => {
  test("puts the frame sentences above the request", () => {
    expect(frameFirstDay(REQUEST)).toBe(
      [...FIRST_DAY_FRAME, "", REQUEST].join("\n"),
    );
  });
});

describe("readFirstDay", () => {
  test("gives back exactly the request that was framed", () => {
    expect(readFirstDay(frameFirstDay(REQUEST))).toBe(REQUEST);
  });

  test("keeps a request that runs over several lines whole", () => {
    const multi = "Read my mail.\n\nThen tell me how you can help.";
    expect(readFirstDay(frameFirstDay(multi))).toBe(multi);
  });

  test("says no to a message a person wrote themselves", () => {
    expect(readFirstDay(REQUEST)).toBeNull();
  });

  test("says no to a person quoting one line of the frame", () => {
    for (const line of FIRST_DAY_FRAME) {
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
