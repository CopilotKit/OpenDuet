import { describe, expect, test } from "bun:test";
import {
  CHECK_IN_FRAME,
  describeCheckIn,
  frameCheckIn,
  OFFER_TASK_TOOL,
  readCheckIn,
} from "./check-in";
import { frameFirstDay, readFirstDay } from "./first-day";
import { frameFiring, readFiring } from "./routine-firing";

const CHECK_IN = {
  checkedAt: "2026-10-22T17:32:00.000Z",
  offers: [
    {
      id: "s-1",
      title: "Reply to Rosa about the glaze substitute",
      why: 'She needs an answer on "Oat Satin" by 4pm.\n\nNext: send the two options.',
    },
    { id: "s-2", title: "Confirm the kiln delivery", why: "" },
  ],
};

describe("frameCheckIn", () => {
  test("puts the frame above what was found, and names the one tool it may call", () => {
    const framed = frameCheckIn(CHECK_IN);
    expect(framed.startsWith([...CHECK_IN_FRAME, "", "{"].join("\n"))).toBe(
      true,
    );
    expect(CHECK_IN_FRAME.join(" ")).toContain(OFFER_TASK_TOOL);
    expect(framed).toContain('"suggestionId": "s-1"');
  });
});

describe("readCheckIn", () => {
  test("gives back exactly the time and the offers that were framed", () => {
    expect(readCheckIn(frameCheckIn(CHECK_IN))).toEqual(CHECK_IN);
  });

  test("says no to a message a person wrote themselves", () => {
    expect(readCheckIn("Reply to Rosa about the glaze substitute")).toBeNull();
  });

  test("says no to a person quoting one line of the frame", () => {
    for (const line of CHECK_IN_FRAME) {
      expect(readCheckIn(line)).toBeNull();
      expect(readCheckIn(`${line}\n\n{}`)).toBeNull();
    }
  });

  test("is still a check-in when the body under the frame cannot be read", () => {
    expect(readCheckIn([...CHECK_IN_FRAME, "", "not json"].join("\n"))).toEqual(
      { checkedAt: null, offers: [] },
    );
  });

  test("is not mistaken for a routine firing or a first-day message, nor they for it", () => {
    const framed = frameCheckIn(CHECK_IN);
    expect(readFiring(framed)).toBeNull();
    expect(readFirstDay(framed)).toBeNull();
    expect(readCheckIn(frameFiring("Post the standup."))).toBeNull();
    expect(readCheckIn(frameFirstDay("Get to know me."))).toBeNull();
  });
});

describe("describeCheckIn", () => {
  test("names what was found, for the conversation's title", () => {
    expect(describeCheckIn(CHECK_IN)).toBe(
      "Checked mail and calendar and found: Reply to Rosa about the glaze substitute; Confirm the kiln delivery",
    );
    expect(describeCheckIn({ checkedAt: null, offers: [] })).toBe(
      "Checked mail and calendar",
    );
  });
});
