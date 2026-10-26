import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MorningBriefCard } from "@/components/duet/morning-brief-card";
import { ConversationSendContext } from "@/components/channels/conversation-send";
import {
  briefCard,
  readBrief,
  StartableBrief,
  startRequest,
} from "@/lib/copilot/morning-brief-tool";

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

describe("Start on what needs her", () => {
  const brief = () => {
    const parsed = readBrief(JSON.stringify(BRIEF));
    if (!parsed) throw new Error("no brief");
    return parsed;
  };

  test("asks the Bot, in her words, to take the email on", () => {
    const first = brief().needsYou[0];
    if (!first) throw new Error("no row");
    expect(startRequest(first)).toBe(
      "Take care of Ana Pereira's email: Friday ship date?",
    );
    expect(startRequest({ ...first, subject: "" })).toBe(
      "Take care of Ana Pereira's email.",
    );
  });

  test("sends through the conversation and then reads Started", () => {
    const send = mock((_text: string) => true);
    const view = render(
      <ConversationSendContext.Provider
        value={{ send, isLatestTurn: () => true }}
      >
        <StartableBrief brief={brief()} />
      </ConversationSendContext.Provider>,
    );
    fireEvent.click(
      view.getByRole("button", {
        name: "Start: Ana Pereira · Friday ship date?",
      }),
    );
    expect(send).toHaveBeenCalledWith(
      "Take care of Ana Pereira's email: Friday ship date?",
    );
    const done = view.getByRole("button", {
      name: "Started",
    }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
  });

  test("a conversation that can't take it now leaves the row as it was", () => {
    const view = render(
      <ConversationSendContext.Provider
        value={{ send: () => false, isLatestTurn: () => true }}
      >
        <StartableBrief brief={brief()} />
      </ConversationSendContext.Provider>,
    );
    const start = view.getByRole("button", {
      name: "Start: Ana Pereira · Friday ship date?",
    });
    fireEvent.click(start);
    expect(view.queryByRole("button", { name: "Started" })).toBe(null);
  });

  test("outside a conversation the brief has nothing to press", () => {
    const view = render(<StartableBrief brief={brief()} />);
    expect(view.queryByRole("button")).toBe(null);
    expect(
      view.getByText("Ana needs the Friday date confirmed today."),
    ).toBeTruthy();
  });
});

describe("a long brief", () => {
  const mailOf = (count: number, decidedBy = "model:triage") =>
    Array.from({ length: count }, (_, index) => ({
      id: `m${index}`,
      threadId: `t${index}`,
      from: `Sender ${index}`,
      subject: `Subject ${index}`,
      reason: `Reason ${index}`,
      decidedBy,
    }));
  const briefWith = (needsYou: ReturnType<typeof mailOf>) => {
    const parsed = readBrief(JSON.stringify({ ...BRIEF, needsYou }));
    if (!parsed) throw new Error("no brief");
    return parsed;
  };

  test("shows five rows that need her, and the rest one tap away", () => {
    const view = render(
      <MorningBriefCard {...briefCard(briefWith(mailOf(27)))} />,
    );
    expect(view.getByText("Sender 4 · Subject 4")).toBeTruthy();
    expect(view.queryByText("Sender 5 · Subject 5")).toBe(null);

    fireEvent.click(
      view.getByRole("button", { name: "Show 22 more in Needs you" }),
    );
    expect(view.getByText("Sender 26 · Subject 26")).toBeTruthy();
    expect(view.queryByRole("button", { name: /^Show \d+ more/ })).toBe(null);
  });

  test("a section one row over is shown whole, since Show 1 more saves nothing", () => {
    const view = render(
      <MorningBriefCard {...briefCard(briefWith(mailOf(6)))} />,
    );
    expect(view.getByText("Sender 5 · Subject 5")).toBeTruthy();
    expect(view.queryByRole("button", { name: /^Show \d+ more/ })).toBe(null);
  });

  test("mail that could not be sorted goes last, and Start still takes on the row it is on", () => {
    const unsorted = mailOf(1, "unsorted").map((item) => ({
      ...item,
      id: "u0",
      from: "Unsorted",
    }));
    const brief = briefWith([...unsorted, ...mailOf(1)]);
    expect(briefCard(brief).needsYou.map((row) => row.id)).toEqual([
      "m0",
      "u0",
    ]);

    const send = mock((_text: string) => true);
    const view = render(
      <ConversationSendContext.Provider
        value={{ send, isLatestTurn: () => true }}
      >
        <StartableBrief brief={brief} />
      </ConversationSendContext.Provider>,
    );
    fireEvent.click(
      view.getByRole("button", { name: "Start: Sender 0 · Subject 0" }),
    );
    expect(send).toHaveBeenCalledWith(
      "Take care of Sender 0's email: Subject 0",
    );
  });
});
