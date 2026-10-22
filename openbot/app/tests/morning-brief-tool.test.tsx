import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { MorningBriefCard } from "@/components/duet/morning-brief-card";
import { briefCard, readBrief } from "@/lib/copilot/morning-brief-tool";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

const BRIEF = {
  at: "2026-10-22T08:05:00",
  name: "Maya",
  needsYou: [
    {
      id: "m1",
      threadId: "t1",
      from: "Ana Pereira",
      subject: "Friday ship date?",
      reason: "Ana needs the Friday date confirmed today.",
      decidedBy: "model:test",
    },
  ],
  canWait: [
    {
      id: "m2",
      threadId: "t2",
      from: "Ceramics Monthly",
      subject: "Glazes",
      reason: "Bulk mail.",
      decidedBy: "rule:bulk",
    },
    {
      id: "m3",
      threadId: "t3",
      from: "Adobe",
      subject: "Receipt",
      reason: "Paid.",
      decidedBy: "model:test",
    },
    {
      id: "m4",
      threadId: "t4",
      from: "Stripe",
      subject: "Paid",
      reason: "FYI.",
      decidedBy: "model:test",
    },
    {
      id: "m5",
      threadId: "t5",
      from: "LinkedIn",
      subject: "Searches",
      reason: "Social.",
      decidedBy: "rule:category",
    },
  ],
  calendar: [
    {
      id: "e1",
      summary: "Studio visit with Hearth & Co",
      start: "2026-10-22T15:00:00",
      end: "2026-10-22T16:00:00",
    },
  ],
  couldNotCheck: [],
  checked: { mail: 5, byRules: 2, byModel: 3 },
};

describe("reading the tool's result", () => {
  test("a brief parses; a refusal or anything else does not", () => {
    expect(readBrief(JSON.stringify(BRIEF))?.name).toBe("Maya");
    // As the runtime delivers a server tool's text: encoded once more.
    expect(readBrief(JSON.stringify(JSON.stringify(BRIEF)))?.name).toBe("Maya");
    expect(readBrief("Refused. Gmail is not connected.")).toBe(null);
    expect(readBrief({ not: "a string" })).toBe(null);
  });
});

describe("the card", () => {
  test("shows what needs her with its reason, folds what can wait into one row, and lists today", () => {
    const brief = readBrief(JSON.stringify(BRIEF));
    if (!brief) throw new Error("no brief");
    const card = briefCard(brief);
    expect(card.greeting).toBe("Morning, Maya.");
    expect(card.needsYou).toEqual([
      expect.objectContaining({
        title: "Ana Pereira · Friday ship date?",
        why: "Ana needs the Friday date confirmed today.",
      }),
    ]);
    expect(card.canWait).toEqual([
      expect.objectContaining({
        title: "4 emails can wait",
        why: "Ceramics Monthly, Adobe, Stripe and 1 more",
      }),
    ]);
    const view = render(<MorningBriefCard {...card} />);
    expect(view.getByText("Needs you")).toBeTruthy();
    expect(
      view.getByText("Ana needs the Friday date confirmed today."),
    ).toBeTruthy();
    expect(view.getByText("Today")).toBeTruthy();
    expect(view.getByText("Studio visit with Hearth & Co")).toBeTruthy();
    expect(view.queryByText("Couldn't check")).toBe(null);
  });

  test("says what it could not check, in the card", () => {
    const brief = readBrief(
      JSON.stringify({
        ...BRIEF,
        needsYou: [],
        canWait: [],
        calendar: [],
        couldNotCheck: [
          {
            source: "Gmail",
            why: "Gmail and Google Calendar is not connected.",
          },
        ],
      }),
    );
    if (!brief) throw new Error("no brief");
    const view = render(<MorningBriefCard {...briefCard(brief)} />);
    expect(view.getByText("Couldn't check")).toBeTruthy();
    expect(
      view.getByText("Gmail and Google Calendar is not connected."),
    ).toBeTruthy();
    // An empty brief because Gmail is missing must not read as a quiet morning.
    expect(view.queryByText(/Nothing new needs you/)).toBe(null);
  });
});
