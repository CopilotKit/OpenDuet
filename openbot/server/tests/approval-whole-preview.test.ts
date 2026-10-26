import { describe, expect, test } from "bun:test";
import { createApprovalService } from "../src/approvals/service";
import type {
  ApprovalAction,
  ApprovalRecord,
  ApprovalStore,
} from "../src/approvals/types";
import { APPROVAL_FIELDS_CUT, approvalFields } from "../src/delivery/opentag";
import { shareTargetOf } from "../src/plugins/share-target";
import { createPrivateShareCheck } from "../src/proactive/private-share";

/**
 * An email the Bot wants to send is shown whole before Allow once, in the parts its recipient sees,
 * and Allow once lets out that email and no other.
 *
 * The release review's repro: a reply of 414 characters raised a "Send email" card that stopped at
 * "…moves from Friday to S", with no ellipsis and nothing to open; Details showed the same 280
 * characters with the subject glued on as the body's last line and `"recipients": 0`; Allow once
 * sent all 414 to the fake Google. These run the same path: the connector's send described by
 * `shareTargetOf`, put to the person by the private-share check, and read back the way the app reads
 * its inbox.
 */

const OWNER = "owner-1";
const BODY = [
  "Hi Sam,",
  "",
  "The glaze we ordered for your mugs is delayed at the supplier, and they cannot promise a date.",
  "We can substitute Oat Satin, which matched in every test tile we fired this week, or wait.",
  "If we substitute, nothing else about the order changes; if we wait, it could be two weeks.",
  "Either way the ship date moves from Friday to Saturday, because the kiln is booked Friday.",
  "",
  "Thanks,",
  "Maya",
].join("\n");
const REPLY = {
  threadId: "thread-sam",
  inReplyTo: "message-sam",
  to: ["Sam <sam@example.test>"],
  subject: "Re: Glaze delay: substitute?",
  body: BODY,
};
const continuation = (runId: string) => ({
  runId,
  threadId: "conversation-1",
  toolCallId: `call-${runId}`,
  toolName: "mcp__google-workspace__gmail_send_reply",
  args: {},
  messages: [{ id: "u1", role: "user" as const, content: "Reply to Sam" }],
  state: {},
  context: [],
  forwardedProps: {},
});

/** The ledger, in memory: opened, decided and spent as the real store does, by digest. */
function ledger() {
  const records = new Map<string, ApprovalRecord>();
  const store: ApprovalStore = {
    enabled: async () => true,
    setEnabled: async () => {},
    open: async (action: ApprovalAction) => {
      const row: ApprovalRecord = {
        id: `approval-${records.size + 1}`,
        ownerUserId: action.actorId,
        action: structuredClone(action),
        status: "pending",
        decision: null,
        result: null,
        createdAt: new Date(),
        decidedAt: null,
        consumedAt: null,
        completedAt: null,
      };
      records.set(row.id, row);
      return structuredClone(row);
    },
    get: async (_owner, id) => structuredClone(records.get(id) as never),
    list: async () => [...records.values()].map((row) => structuredClone(row)),
    decide: async (_owner, id, decision) => {
      const row = records.get(id) as ApprovalRecord;
      row.decision = decision;
      row.status = decision === "deny" ? "denied" : "approved";
      row.decidedAt = new Date();
      return structuredClone(row);
    },
    consume: async (_owner, id, digest) => {
      const row = records.get(id);
      if (row?.status !== "approved" || row.action.actionDigest !== digest)
        return false;
      row.status = "consumed";
      row.consumedAt = new Date();
      return true;
    },
    saveResult: async () => true,
    finish: async () => {},
    rules: async () => [],
    revoke: async () => {},
  };
  return { store, records };
}

/** The send, as the plugin store puts it to the check (plugins/plugin-store/calls.ts). */
function sendInput(args: Record<string, unknown>, runId: string) {
  const target = shareTargetOf("google-workspace", "gmail_send_reply", args);
  if (!target) throw new Error("not a send");
  return {
    ownerUserId: OWNER,
    botId: "bot-1",
    audience: target.audience,
    content: target.content,
    message: target.message,
    origin: { kind: "unknown" as const },
    continuation: continuation(runId),
  };
}

describe("an email put to the person before it is sent", () => {
  test("is asked about whole: the full body, the subject on its own, and its recipients counted", async () => {
    const { store, records } = ledger();
    const check = createPrivateShareCheck({ approvals: store });
    expect(BODY.length).toBeGreaterThan(280);

    const verdict = await check(sendInput(REPLY, "run-1"));
    expect(verdict.status).toBe("pending");
    const [asked] = [...records.values()];
    const args = asked?.action.args as Record<string, unknown>;
    expect(args.body).toBe(BODY);
    expect(String(args.body)).not.toContain("Glaze delay");
    expect(args.subject).toBe("Re: Glaze delay: substitute?");
    expect(args.to).toEqual(["Sam <sam@example.test>"]);
    expect(args.recipients).toBe(1);
    expect(args.alsoSent).toEqual({
      threadId: "thread-sam",
      inReplyTo: "message-sam",
    });
    expect(args).not.toHaveProperty("preview");
  });

  test("counts every distinct addressee, copies included", async () => {
    const { store, records } = ledger();
    await createPrivateShareCheck({ approvals: store })(
      sendInput(
        {
          ...REPLY,
          to: ["sam@example.test", "ana@example.test"],
          cc: ["ops@example.test", "sam@example.test"],
        },
        "run-1",
      ),
    );
    const [asked] = [...records.values()];
    expect(asked?.action.args).toMatchObject({ recipients: 3 });
  });

  test("reaches the app's inbox whole, however long, with secrets still masked", async () => {
    const { store } = ledger();
    const long = `${BODY}\n\n${"P.S. One more line about the order. ".repeat(120)}`;
    expect(long.length).toBeGreaterThan(2000);
    await createPrivateShareCheck({ approvals: store })(
      sendInput(
        {
          ...REPLY,
          to: Array.from(
            { length: 25 },
            (_, index) => `p${index}@example.test`,
          ),
          body: `${long}\napi_key=sk-live-123`,
        },
        "run-1",
      ),
    );
    const inbox = await createApprovalService(store).inbox(OWNER);
    const args = inbox.requests[0]?.action.args as Record<string, unknown>;
    // Not 1,999 characters and an ellipsis, and not the first 20 of 25 recipients.
    expect(args.body).toBe(`${long}\napi_key=[private value]`);
    expect(args.to).toHaveLength(25);
  });

  test("Allow once lets out the email that was shown, and not one that changed after it", async () => {
    const { store, records } = ledger();
    const check = createPrivateShareCheck({ approvals: store });
    await check(sendInput(REPLY, "run-1"));
    const [asked] = [...records.values()];
    await store.decide(OWNER, asked?.id as string, "allow_once");

    // The Bot sends again with a longer body than the one the person read: a new question.
    const changed = await check(
      sendInput(
        { ...REPLY, body: `${BODY}\nP.S. Also forwarding the invoice.` },
        "run-1",
      ),
    );
    expect(changed.status).toBe("pending");
    // Nor with another recipient added, nor another subject.
    for (const altered of [
      { ...REPLY, cc: ["someone@example.test"] },
      { ...REPLY, subject: "Re: Glaze delay" },
    ])
      expect((await check(sendInput(altered, "run-1"))).status).toBe("pending");

    // The email that was shown goes, once.
    expect((await check(sendInput(REPLY, "run-1"))).status).toBe("allowed");
    expect((await check(sendInput(REPLY, "run-1"))).status).toBe("denied");
  });
});

describe("an approval sent to chat, which has room for less", () => {
  test("says it is cut short and where to read all of it, rather than ending on an ellipsis", () => {
    const long = approvalFields({
      audience: "google-workspace: sam",
      body: "x".repeat(400),
    });
    expect(long.at(-1)).toEqual(APPROVAL_FIELDS_CUT);
    expect(long.find((field) => field.label === "body")?.value).toHaveLength(
      300,
    );
    const short = approvalFields({
      audience: "google-workspace: sam",
      body: "Hi Sam",
    });
    expect(short).not.toContainEqual(APPROVAL_FIELDS_CUT);
  });
});
