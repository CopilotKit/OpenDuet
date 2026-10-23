import { describe, expect, test } from "bun:test";
import {
  CHANNEL_HELLO_FRAME,
  CHANNEL_HELLO_OFFER,
  CHANNEL_HELLO_PICK,
  CHANNEL_HELLO_QUESTION,
  describeChannelHello,
  frameChannelHello,
  readChannelHello,
} from "./channel-hello";
import { frameCheckIn, readCheckIn } from "./check-in";
import { frameFirstDay, readFirstDay } from "./first-day";
import { frameFiring, readFiring } from "./routine-firing";
import { frameTaskBrief, readTaskBrief } from "./task-brief";

const CHANNEL = {
  name: "Kiln move",
  purpose: "Moving the studio's kiln to the new space by March.",
};

describe("frameChannelHello", () => {
  test("puts the frame sentences above the channel, as JSON", () => {
    const framed = frameChannelHello(CHANNEL);
    expect(framed.startsWith([...CHANNEL_HELLO_FRAME, "", ""].join("\n"))).toBe(
      true,
    );
    const body = JSON.parse(
      framed.slice([...CHANNEL_HELLO_FRAME, "", ""].join("\n").length),
    );
    expect(body).toEqual({ channel: CHANNEL.name, purpose: CHANNEL.purpose });
  });

  test("asks the Bot to end on the question with Yes, No and Not now as replies", () => {
    const framed = frameChannelHello(CHANNEL);
    expect(framed).toContain(CHANNEL_HELLO_QUESTION);
    expect(framed).toContain('"Yes", "No", "Not now"');
    expect(framed).toContain("suggest_replies");
  });

  test("on Yes, asks for three grounded things, a chip for each, and start_task on a pick", () => {
    const framed = frameChannelHello(CHANNEL);
    expect(framed).toContain(CHANNEL_HELLO_OFFER);
    expect(framed).toContain(CHANNEL_HELLO_PICK);
    expect(framed).toContain("start_task");
    expect(framed).toContain("never a generic idea");
  });
});

describe("readChannelHello", () => {
  test("gives back exactly the channel that was framed", () => {
    expect(readChannelHello(frameChannelHello(CHANNEL))).toEqual(CHANNEL);
  });

  test("keeps a name or purpose with quotes and line breaks whole", () => {
    const awkward = { name: 'The "big" move', purpose: "Line one.\nLine two." };
    expect(readChannelHello(frameChannelHello(awkward))).toEqual(awkward);
  });

  test("says no to a message a person wrote themselves", () => {
    expect(readChannelHello(CHANNEL.purpose)).toBeNull();
    expect(readChannelHello("Yes")).toBeNull();
  });

  test("says no to a person quoting one line of the frame", () => {
    for (const line of CHANNEL_HELLO_FRAME) {
      expect(readChannelHello(line)).toBeNull();
      expect(readChannelHello(`${line}\n\n{}`)).toBeNull();
    }
  });

  test("is still a hello when its body cannot be read", () => {
    const prefix = [...CHANNEL_HELLO_FRAME, "", ""].join("\n");
    expect(readChannelHello(`${prefix}not json`)).toEqual({
      name: "",
      purpose: "",
    });
  });

  test("is no other frame, and no other frame is a hello", () => {
    const hello = frameChannelHello(CHANNEL);
    expect(readFirstDay(hello)).toBeNull();
    expect(readCheckIn(hello)).toBeNull();
    expect(readTaskBrief(hello)).toBeNull();
    expect(readFiring(hello)).toBeNull();
    expect(readChannelHello(frameFirstDay("Get to know me."))).toBeNull();
    expect(readChannelHello(frameTaskBrief("Draft it."))).toBeNull();
    expect(readChannelHello(frameFiring("Every morning."))).toBeNull();
    expect(
      readChannelHello(
        frameCheckIn({ checkedAt: "2026-10-22T09:00:00Z", offers: [] }),
      ),
    ).toBeNull();
  });
});

describe("describeChannelHello", () => {
  test("names the channel, for a reader that titles the conversation", () => {
    expect(describeChannelHello(CHANNEL)).toBe("New channel: Kiln move");
    expect(describeChannelHello({ name: "", purpose: "" })).toBe("New channel");
  });
});
