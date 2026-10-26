import { describe, expect, test } from "bun:test";
import {
  BRIEF_MAIL_CAP,
  buildMorningBrief,
  CALENDAR_LIST,
  type CallTool,
  displayName,
  firstNameOf,
  GMAIL_SEARCH,
  inboxOwner,
  openduetTools,
} from "../src/openduet/brief";

const NOW = new Date("2026-10-22T14:30:00Z");
const INITIATOR = { kind: "person" } as const;
const MAYA = "maya@marlowceramics.com";

const MAIL = [
  {
    id: "m1",
    threadId: "t1",
    from: "Ana Pereira <ana@hearthandco.com>",
    to: [MAYA],
    cc: [],
    subject: "Friday ship date?",
    date: "2026-10-22T07:10:00-07:00",
    snippet:
      "Can you confirm the mugs still ship Friday? I need to tell stores today.",
    labels: ["INBOX"],
    headers: {},
  },
  {
    id: "m2",
    threadId: "t2",
    from: "Ceramics Monthly <news@ceramicsmonthly.example>",
    to: [MAYA],
    cc: [],
    subject: "10 glazes for fall",
    date: "2026-10-22T06:00:00-07:00",
    snippet: "This month: ten glazes.",
    labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    headers: { "List-Unsubscribe": "<mailto:x@y>" },
  },
  {
    id: "m3",
    threadId: "t3",
    from: "Sam Ruiz <sam@marlowceramics.com>",
    to: [MAYA],
    cc: [],
    subject: "Friday off?",
    date: "2026-10-22T06:30:00-07:00",
    snippet: "Could I take Friday off?",
    labels: ["INBOX"],
    headers: {},
  },
];
const EVENTS = [
  {
    id: "e1",
    summary: "Studio visit with Hearth & Co",
    start: "2026-10-22T15:00:00-07:00",
    end: "2026-10-22T16:00:00-07:00",
  },
];

function connector(
  overrides: Partial<
    Record<string, () => Promise<{ text: string; isError: boolean }>>
  > = {},
): { callTool: CallTool; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    callTool: async ({ ref }) => {
      calls.push(ref);
      const override = overrides[ref];
      if (override) return override();
      if (ref === GMAIL_SEARCH)
        return { text: JSON.stringify({ messages: MAIL }), isError: false };
      if (ref === CALENDAR_LIST)
        return { text: JSON.stringify({ events: EVENTS }), isError: false };
      throw new Error(`unexpected ${ref}`);
    },
  };
}

const input = {
  actorId: "dev-local-user",
  botId: "openduet",
  initiator: INITIATOR,
  person: { name: "Maya Okafor", email: "dev@openbot.local" },
};

describe("morning brief", () => {
  test("sorts the inbox into needs you and can wait, each with its reason, and adds today's calendar", async () => {
    const { callTool } = connector();
    const brief = await buildMorningBrief(
      {
        callTool,
        model: "test-model",
        now: () => NOW,
        complete: async (prompt) =>
          prompt.includes("Friday ship date")
            ? '{"verdict":"needs_you","reason":"Ana needs the Friday date confirmed today."}'
            : '{"verdict":"needs_you","reason":"Sam needs a yes or no today."}',
      },
      input,
    );
    expect(brief.name).toBe("Maya");
    expect(brief.needsYou.map((item) => item.id)).toEqual(["m1", "m3"]);
    expect(brief.needsYou[0]).toMatchObject({
      from: "Ana Pereira",
      reason: "Ana needs the Friday date confirmed today.",
      decidedBy: "model:test-model",
    });
    expect(brief.canWait).toEqual([
      expect.objectContaining({ id: "m2", decidedBy: "rule:bulk" }),
    ]);
    expect(brief.calendar.map((event) => event.summary)).toEqual([
      "Studio visit with Hearth & Co",
    ]);
    expect(brief.couldNotCheck).toEqual([]);
    expect(brief.checked).toEqual({ mail: 3, byRules: 1, byModel: 2 });
  });

  test("a window with more mail than the brief reads says so, instead of dropping the oldest in silence", async () => {
    // A working inbox's day: more matches than the cap, newest first, so the oldest never arrive.
    const page = Array.from({ length: BRIEF_MAIL_CAP }, (_, index) => ({
      ...MAIL[1],
      id: `bulk-${index}`,
    }));
    let asked: Record<string, unknown> = {};
    const brief = await buildMorningBrief(
      {
        callTool: async ({ ref, args }) => {
          if (ref === GMAIL_SEARCH) {
            asked = args;
            return {
              text: JSON.stringify({ messages: page, resultSizeEstimate: 73 }),
              isError: false,
            };
          }
          return { text: JSON.stringify({ events: [] }), isError: false };
        },
        model: "test-model",
        complete: async () => "{}",
      },
      input,
    );
    expect(asked.maxResults).toBe(BRIEF_MAIL_CAP);
    expect(brief.checked.mail).toBe(BRIEF_MAIL_CAP);
    expect(brief.couldNotCheck).toEqual([
      {
        source: "Gmail",
        why: `Only the newest ${BRIEF_MAIL_CAP} of about 73 messages from this window were sorted. Older ones were not checked.`,
      },
    ]);
  });

  test("a window the brief read in full says nothing about a cap", async () => {
    const brief = await buildMorningBrief(
      {
        callTool: async ({ ref }) =>
          ref === GMAIL_SEARCH
            ? {
                text: JSON.stringify({ messages: MAIL, resultSizeEstimate: 3 }),
                isError: false,
              }
            : { text: JSON.stringify({ events: [] }), isError: false },
        model: "test-model",
        complete: async () =>
          '{"verdict":"can_wait","reason":"Nothing to do today."}',
      },
      input,
    );
    expect(brief.couldNotCheck).toEqual([]);
  });

  test("a source that is not connected is reported, not skipped in silence", async () => {
    const { callTool } = connector({
      [GMAIL_SEARCH]: async () => {
        throw new Error(
          "Refused. Gmail and Google Calendar is not connected for this person.",
        );
      },
      [CALENDAR_LIST]: async () => ({
        text: "The calendar could not be read (403).",
        isError: true,
      }),
    });
    const brief = await buildMorningBrief(
      { callTool, model: "test-model", complete: async () => "{}" },
      input,
    );
    expect(brief.needsYou).toEqual([]);
    expect(brief.couldNotCheck).toEqual([
      {
        source: "Gmail",
        why: "Gmail and Google Calendar is not connected for this person.",
      },
      {
        source: "Google Calendar",
        why: "The calendar could not be read (403).",
      },
    ]);
  });

  test("a message the model could not sort is shown as needing the person, and the failure is said", async () => {
    const { callTool } = connector();
    const brief = await buildMorningBrief(
      {
        callTool,
        model: "test-model",
        complete: async () => {
          throw new Error("model answered 500");
        },
      },
      input,
    );
    // The newsletter is still sorted by a rule; the two the model was needed for are not hidden.
    expect(brief.canWait.map((item) => item.id)).toEqual(["m2"]);
    expect(brief.needsYou.map((item) => [item.id, item.decidedBy])).toEqual([
      ["m1", "unsorted"],
      ["m3", "unsorted"],
    ]);
    expect(brief.couldNotCheck).toEqual([
      expect.objectContaining({ source: "Sorting" }),
    ]);
  });

  test("tells sent-to-you from copied by the inbox's own address, not a placeholder sign-in", () => {
    expect(inboxOwner("dev@openbot.local", MAIL)).toBe(MAYA);
    expect(inboxOwner(MAYA, MAIL)).toBe(MAYA);
    expect(inboxOwner(null, [])).toBe(null);
  });

  test("names a sender by name when the header has one", () => {
    expect(displayName("Ana Pereira <ana@hearthandco.com>")).toBe(
      "Ana Pereira",
    );
    expect(displayName('"Coastal Bank" <alerts@coastalbank.com>')).toBe(
      "Coastal Bank",
    );
    expect(displayName("ana@hearthandco.com")).toBe("ana@hearthandco.com");
  });

  test("greets by first name, and by no name when the name on file is an email address", () => {
    expect(firstNameOf("Maya Okafor")).toBe("Maya");
    expect(firstNameOf("  Maya  ")).toBe("Maya");
    // A single-user install keeps the sign-in email as the name.
    expect(firstNameOf("dev@openbot.local")).toBeNull();
    expect(firstNameOf("")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
  });
});

describe("the morning_brief tool", () => {
  test("returns the brief as JSON and refuses unknown arguments", async () => {
    let built = 0;
    const [tool] = openduetTools({
      actorId: "dev-local-user",
      botId: "openduet",
      initiator: INITIATOR,
      person: async () => ({ name: "Maya", email: null }),
      build: async (given) => {
        built++;
        expect(given.since).toBe("2d");
        return {
          at: NOW.toISOString(),
          name: "Maya",
          needsYou: [],
          canWait: [],
          calendar: [],
          couldNotCheck: [],
          checked: { mail: 0, byRules: 0, byModel: 0 },
        };
      },
    });
    expect(tool?.ref).toBe("openduet/morning_brief");
    expect(
      JSON.parse((await tool?.execute({ since: "2d" })) ?? "{}").name,
    ).toBe("Maya");
    expect(await tool?.execute({ since: "forever" })).toStartWith("Refused.");
    expect(built).toBe(1);
  });
});
