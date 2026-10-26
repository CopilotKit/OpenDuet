import { expect, test } from "bun:test";
import {
  approvalOutcome,
  approvalPlace,
  clockTime,
  decisionReceipt,
  describeApproval,
  personWasAsked,
} from "@/lib/approval-view";
import type { ApprovalRequest } from "@/lib/approvals";

const action = (
  toolRef: string,
  args: unknown,
): Pick<ApprovalRequest, "action"> => ({
  action: {
    botId: "openduet",
    toolRef,
    effect: "write",
    scope: "*",
    threadId: "t",
    args,
    target: {},
  },
});

test("an app's send tool reads as the action, with the app named apart", () => {
  const view = describeApproval(
    action("gmail/GMAIL_SEND_EMAIL", {
      recipient_email: "ana@example.com",
      subject: "Ship date",
      body: "Hi Ana",
      thread_id: "abc",
    }),
  );
  expect(view.title).toBe("Send email");
  expect(view.app).toBe("Gmail");
  expect(view.kind).toBe("mail");
  expect(view.fields).toEqual([
    { label: "To", value: "ana@example.com" },
    { label: "Subject", value: "Ship date" },
  ]);
  expect(view.body).toBe("Hi Ana");
});

test("a browser action keeps what it acts on and drops the page plumbing", () => {
  const view = describeApproval(
    action("computer_click", { element: "Pay now", ref: "e7", snapshotId: 3 }),
  );
  expect(view.title).toBe("Click");
  expect(view.app).toBeNull();
  expect(view.kind).toBe("browser");
  expect(view.fields).toEqual([{ label: "Element", value: "Pay now" }]);
});

test("a command on the person's computer is a command", () => {
  const view = describeApproval(
    action("host/run_command", { command: "ls -la" }),
  );
  expect(view.title).toBe("Run command");
  expect(view.kind).toBe("command");
  expect(view.fields).toEqual([{ label: "Command", value: "ls -la" }]);
});

test("who decided, in the person's words", () => {
  expect(decisionReceipt({ decision: "allow_once" })).toBe(
    "Allowed once by you",
  );
  expect(decisionReceipt({ decision: "deny" })).toBe("Refused by you");
  expect(decisionReceipt({ decision: "handled" })).toBe("You did it yourself");
  expect(decisionReceipt({ decision: null })).toBeNull();
});

test("how it ended: sent, refused, or did not work", () => {
  const mail = action("gmail/GMAIL_SEND_EMAIL", {}).action;
  expect(
    approvalOutcome({ status: "completed", result: null, action: mail }),
  ).toEqual({
    label: "Sent",
    tone: "green",
  });
  expect(
    approvalOutcome({
      status: "completed",
      result: { error: "boom" },
      action: mail,
    }),
  ).toEqual({ label: "Didn't work", tone: "amber" });
  expect(
    approvalOutcome({ status: "denied", result: null, action: mail }),
  ).toEqual({
    label: "Refused",
    tone: "red",
  });
  expect(
    approvalOutcome({ status: "pending", result: null, action: mail }),
  ).toBeNull();
});

test("a time today is a clock time; an earlier one is a date", () => {
  const now = new Date(2026, 9, 21, 15, 0);
  expect(clockTime(new Date(2026, 9, 21, 14, 59).toISOString(), now)).toMatch(
    /2:59/,
  );
  expect(clockTime(new Date(2026, 9, 20, 9, 0).toISOString(), now)).toMatch(
    /20/,
  );
  expect(clockTime("not a date", now)).toBe("");
});

test("a send the private-share check asks about reads as the email it is", () => {
  const view = describeApproval({
    action: {
      toolRef: "openbot/share_private_information",
      args: {
        audience: "google-workspace: ana@hearthandco.example",
        recipients: 0,
        contentDigest: "9f2c",
        preview:
          "Hi Ana, our kiln is down until Monday. Could we ship on Tuesday?\nShip date for your mugs",
      },
    },
  } as never);
  expect(view).toEqual({
    title: "Send email",
    app: "Gmail",
    kind: "mail",
    fields: [{ label: "To", value: "ana@hearthandco.example" }],
    body: "Hi Ana, our kiln is down until Monday. Could we ship on Tuesday?\nShip date for your mugs",
  });
});

test("a send put to the person by the share check counts as asked, and reads its place without the marker", () => {
  const share = {
    action: {
      toolRef: "openbot/share_private_information",
      scope: "external:ana@hearthandco.example",
      args: {},
    },
  } as never;
  expect(personWasAsked(share)).toBe(true);
  expect(approvalPlace(share)).toBe("ana@hearthandco.example");
  expect(
    personWasAsked({
      action: {
        toolRef: "google-workspace/gmail_send_reply",
        scope: "x",
        args: {},
      },
    } as never),
  ).toBe(false);
});

/*
 * The release review's email: the card showed 280 characters cut mid-word, the subject glued on as
 * the body's last line, and Details said "recipients": 0. The check now sends the message in its
 * parts, whole, and the card reads each one where it goes.
 */
test("a send the share check asks about shows its recipients, subject and whole body apart", () => {
  const body = `Hi Sam,\n\n${"The glaze is delayed, and we can substitute Oat Satin. ".repeat(12)}\n\nThanks,\nMaya`;
  const view = describeApproval({
    action: {
      toolRef: "openbot/share_private_information",
      args: {
        audience: "google-workspace: Sam <sam@example.test> ops@example.test",
        recipients: 2,
        to: ["Sam <sam@example.test>"],
        cc: ["ops@example.test"],
        subject: "Re: Glaze delay: substitute?",
        body,
        alsoSent: { threadId: "t-1" },
        contentDigest: "9f2c",
      },
    },
  } as never);
  expect(view.title).toBe("Send email");
  expect(view.fields).toEqual([
    { label: "To", value: "Sam <sam@example.test>" },
    { label: "Cc", value: "ops@example.test" },
    { label: "Subject", value: "Re: Glaze delay: substitute?" },
  ]);
  expect(view.body).toBe(body);
  expect(view.body).not.toContain("Glaze delay: substitute?");
});
