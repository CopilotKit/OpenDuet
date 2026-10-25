import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, renderHook } from "@testing-library/react";
import {
  approvedActionPhrase,
  SERVER_WORKING,
  serverWorkPhrase,
  useUnownedServerWork,
} from "@/components/shell/chat-presence";
import type { ApprovalInboxData, ApprovalRequest } from "@/lib/approvals";
import { settleReactWork } from "./settle-react-work";

/**
 * Work the server runs in a conversation that the screen did not start, such as the run after
 * Allow once: named for what it does, and never shown for the screen's own turn as it ends.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const NOW = Date.parse("2026-10-23T05:00:00Z");

function request(
  overrides: Partial<ApprovalRequest> & {
    toolRef?: string;
    args?: unknown;
    scope?: string;
  },
): ApprovalRequest {
  const {
    toolRef = "openbot/share_private_information",
    args,
    scope = "external:ana@hearth.example",
    ...rest
  } = overrides;
  return {
    id: "r",
    status: "approved",
    createdAt: "2026-10-23T04:58:00Z",
    decision: "allow_once",
    decidedAt: "2026-10-23T04:59:30Z",
    action: {
      botId: "openduet",
      toolRef,
      effect: "share_private",
      scope,
      threadId: "thread-1",
      // The shape the inbox carries: the message itself stays on the server.
      args: args ?? {
        preview: "Hi Ana, yes.",
        audience: "google-workspace: ana@hearth.example",
        recipients: 0,
      },
      target: {},
    },
    ...rest,
  };
}

const inbox = (requests: ApprovalRequest[]) =>
  ({ requests, questions: [] }) as unknown as ApprovalInboxData;

describe("what the pill says for the server's work", () => {
  test("nothing when the conversation is not busy", () => {
    expect(
      serverWorkPhrase(false, "thread-1", inbox([request({})]), NOW),
    ).toBeNull();
  });

  test("the action the person just allowed, in their words", () => {
    expect(serverWorkPhrase(true, "thread-1", inbox([request({})]), NOW)).toBe(
      "Sending your email",
    );
    expect(
      approvedActionPhrase(
        request({ toolRef: "google-workspace/gmail_send_reply", args: {} }),
      ),
    ).toBe("Sending your email");
  });

  test("an allowed action stays named after execution starts", () => {
    expect(
      serverWorkPhrase(
        true,
        "thread-1",
        inbox([request({ status: "consumed", decision: "allow_always" })]),
        NOW,
      ),
    ).toBe("Sending your email");
  });

  test("a recently completed email does not name a later server run", () => {
    const completed = request({
      status: "completed",
      completedAt: "2026-10-23T04:59:45Z",
    });
    expect(
      serverWorkPhrase(false, "thread-1", inbox([completed]), NOW),
    ).toBeNull();
    expect(serverWorkPhrase(true, "thread-1", inbox([completed]), NOW)).toBe(
      SERVER_WORKING,
    );
  });

  test("the newest completed decision does not resurrect an earlier allowed email", () => {
    expect(
      serverWorkPhrase(
        true,
        "thread-1",
        inbox([
          request({ id: "earlier", decidedAt: "2026-10-23T04:59:00Z" }),
          request({ id: "latest", status: "completed" }),
        ]),
        NOW,
      ),
    ).toBe(SERVER_WORKING);
  });

  test("a request still waiting is not counted, only one the person allowed", () => {
    expect(
      serverWorkPhrase(
        true,
        "thread-1",
        inbox([
          request({ status: "pending", decision: null, decidedAt: null }),
        ]),
        NOW,
      ),
    ).toBe(SERVER_WORKING);
  });

  test("a fresh refusal replaces an earlier allowed email immediately", () => {
    expect(
      serverWorkPhrase(
        true,
        "thread-1",
        inbox([
          request({ id: "earlier", decidedAt: "2026-10-23T04:59:00Z" }),
          request({
            id: "refused",
            decision: "deny",
            decidedAt: "2026-10-23T04:59:59Z",
          }),
        ]),
        NOW,
      ),
    ).toBe(SERVER_WORKING);
  });

  test("a message that goes nowhere with an address is not called an email", () => {
    expect(
      approvedActionPhrase(
        request({
          scope: "external:#general",
          args: { audience: "slack: #general" },
        }),
      ),
    ).toBe(SERVER_WORKING);
  });

  test("otherwise working on it: a refusal, another thread, or a decision long past", () => {
    expect(
      serverWorkPhrase(
        true,
        "thread-1",
        inbox([request({ decision: "deny" })]),
        NOW,
      ),
    ).toBe(SERVER_WORKING);
    expect(serverWorkPhrase(true, "thread-2", inbox([request({})]), NOW)).toBe(
      SERVER_WORKING,
    );
    expect(
      serverWorkPhrase(
        true,
        "thread-1",
        inbox([request({ decidedAt: "2026-10-23T04:30:00Z" })]),
        NOW,
      ),
    ).toBe(SERVER_WORKING);
    expect(serverWorkPhrase(true, "thread-1", undefined, NOW)).toBe(
      SERVER_WORKING,
    );
  });
});

describe("server work the screen did not start", () => {
  test("shows when the screen is idle", () => {
    const { result } = renderHook(() =>
      useUnownedServerWork("Sending your email", false),
    );
    expect(result.current).toBe("Sending your email");
  });

  test("is hidden for the screen's own turn, and for the moment after it ends", () => {
    const { result, rerender } = renderHook(
      ({ work, working }: { work: string | null; working: boolean }) =>
        useUnownedServerWork(work, working),
      {
        initialProps: {
          work: "Working on it" as string | null,
          working: true,
        },
      },
    );
    expect(result.current).toBeNull();
    // The turn has ended here; the server's flag comes down a moment later.
    rerender({ work: "Working on it", working: false });
    expect(result.current).toBeNull();
    rerender({ work: null, working: false });
    expect(result.current).toBeNull();
    // A later run the screen did not start shows again.
    rerender({ work: "Working on it", working: false });
    expect(result.current).toBe("Working on it");
  });
});
