import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import {
  finishedForYou,
  inboxPollFor,
  useFinishedForYou,
} from "@/components/shell/finished-for-you";
import type { ApprovalInboxData, ApprovalRequest } from "@/lib/approvals";
import { settleReactWork } from "./settle-react-work";

/**
 * The header's orb plays a check when something the person allowed the Bot to do is done. What
 * counts is read off the approvals inbox: a request they were asked about, allowed, and that
 * completed while the app was open, once each.
 */

const originalFetch = global.fetch;
let inbox: ApprovalInboxData;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // A read the inbox's own polling makes in between gets whatever the test last set.
  global.fetch = Object.assign(async () => Response.json(inbox), {
    preconnect: originalFetch.preconnect,
  });
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  global.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const SENT = "2026-10-22T09:00:00.000Z";

/** A request to reply to Sam, which the gate put to the person, at one point in its life. */
function reply(
  id: string,
  status: ApprovalRequest["status"],
  more: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    id,
    status,
    createdAt: SENT,
    action: {
      botId: "duet",
      toolRef: "gmail/GMAIL_REPLY_TO_THREAD",
      effect: "send",
      scope: "external:sam@example.com",
      threadId: "t1",
      args: { body: "Yes, take Friday off." },
      target: null,
      policy: { behaviour: "ask", source: "default", reason: "It sends mail." },
    },
    ...more,
  };
}

const allowed = {
  decision: "allow_once" as const,
  decidedAt: new Date().toISOString(),
};
const done = { ...allowed, completedAt: new Date().toISOString() };

function inboxOf(...requests: ApprovalRequest[]): ApprovalInboxData {
  return { enabled: true, requests, rules: [], teamRules: [], questions: [] };
}

/** The hook under a query client of its own, and a way to hand it the inbox's next read. */
async function mount(first?: ApprovalInboxData) {
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (first) {
    inbox = first;
    queries.setQueryData(["approvals"], first);
  }
  const fired: string[] = [];
  function Probe() {
    useFinishedForYou((request) => fired.push(request.id));
    return null;
  }
  await act(async () => {
    render(
      <QueryClientProvider client={queries}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  // The cache tells its observers on a zero timeout of its own, so each read waits one out.
  const read = async (next: ApprovalInboxData) => {
    inbox = next;
    await act(async () => {
      queries.setQueryData(["approvals"], next);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return { fired, read };
}

describe("what counts as finished for the person", () => {
  test("allowed once or always, asked, completed and without an error", () => {
    expect(finishedForYou(reply("a", "completed", done))).toBe(true);
    expect(
      finishedForYou(
        reply("a", "completed", { ...done, decision: "allow_always" }),
      ),
    ).toBe(true);
  });

  test("not a refusal, which also ends completed when the Bot is told", () => {
    expect(
      finishedForYou(
        reply("a", "completed", {
          decision: "deny",
          result: { error: "The person declined." },
        }),
      ),
    ).toBe(false);
    // Nor "I did it myself": the Bot did not do it.
    for (const decision of ["deny", "handled"] as const)
      expect(finishedForYou(reply("a", "completed", { decision }))).toBe(false);
  });

  test("not one that failed, nor one a saved rule decided, nor one still running", () => {
    expect(
      finishedForYou(
        reply("a", "completed", { ...done, result: { error: "Bounced." } }),
      ),
    ).toBe(false);
    const ruled = reply("a", "completed", done);
    ruled.action = { ...ruled.action, policy: undefined };
    expect(finishedForYou(ruled)).toBe(false);
    expect(finishedForYou(reply("a", "consumed", allowed))).toBe(false);
  });
});

describe("useFinishedForYou", async () => {
  test("fires once for a request that goes pending, approved, completed", async () => {
    const { fired, read } = await mount(inboxOf());
    await read(inboxOf(reply("r1", "pending")));
    await read(inboxOf(reply("r1", "approved", allowed)));
    await read(inboxOf(reply("r1", "consumed", allowed)));
    expect(fired).toEqual([]);

    await read(inboxOf(reply("r1", "completed", done)));
    expect(fired).toEqual(["r1"]);

    // Read again, and again: still once.
    await read(inboxOf(reply("r1", "completed", done)));
    await read(inboxOf(reply("r2", "pending"), reply("r1", "completed", done)));
    expect(fired).toEqual(["r1"]);
  });

  test("never fires for what had already completed when the app opened", async () => {
    const old = reply("old", "completed", done);
    const { fired, read } = await mount(inboxOf(old));
    await read(inboxOf(reply("r1", "pending"), old));
    await read(inboxOf(reply("r1", "completed", done), old));
    expect(fired).toEqual(["r1"]);
  });

  test("takes its first read as what is old, even when it arrives after mounting", async () => {
    const { fired, read } = await mount();
    await read(inboxOf(reply("old", "completed", done)));
    expect(fired).toEqual([]);
    await read(
      inboxOf(reply("new", "completed", done), reply("old", "completed", done)),
    );
    expect(fired).toEqual(["new"]);
  });

  test("never fires for a refusal", async () => {
    const { fired, read } = await mount(inboxOf());
    await read(inboxOf(reply("r1", "pending")));
    await read(inboxOf(reply("r1", "denied", { decision: "deny" })));
    await read(
      inboxOf(
        reply("r1", "completed", {
          decision: "deny",
          result: { error: "The person declined." },
        }),
      ),
    );
    expect(fired).toEqual([]);
  });
});

describe("how often the inbox is read", () => {
  test("every couple of seconds while something allowed runs, every ten otherwise", () => {
    const now = Date.parse(SENT) + 30_000;
    const running = reply("r1", "consumed", {
      decision: "allow_once",
      decidedAt: SENT,
    });
    expect(inboxPollFor(inboxOf(running), now)).toBe(2_000);
    expect(inboxPollFor(inboxOf(reply("r1", "pending")), now)).toBe(10_000);
    expect(inboxPollFor(undefined, now)).toBe(10_000);
    // One left approved long ago is not waited on forever.
    expect(inboxPollFor(inboxOf(running), now + 10 * 60_000)).toBe(10_000);
  });
});
