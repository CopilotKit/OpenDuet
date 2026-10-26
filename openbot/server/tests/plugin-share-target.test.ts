import { describe, expect, test } from "bun:test";
import { shareTargetOf } from "../src/plugins/share-target";

describe("which connector writes send content to other people", () => {
  test("a message, a post, a reply and an email are sends, addressed to their recipients", () => {
    const slack = shareTargetOf("slack", "slack_send_message", {
      channel: "C123",
      text: "The Q3 numbers are in",
    });
    expect(slack).toEqual({
      audience: expect.objectContaining({
        kind: "external",
        id: "C123",
        recipientUserIds: [],
      }),
      content: "The Q3 numbers are in",
      message: { to: ["C123"] },
    });
    expect(
      shareTargetOf("gmail", "GMAIL_SEND_EMAIL", { to: "x@y.test", body: "hi" })
        ?.audience.id,
    ).toBe("x@y.test");
    expect(
      shareTargetOf("teams", "postMessage", {
        chatId: "19:abc",
        content: "hi",
      }),
    ).not.toBeNull();
    expect(
      shareTargetOf("linear", "create_comment", { issueId: "L-1", body: "hi" }),
    ).not.toBeNull();
  });

  test("a write that stages or changes the owner's own data is not", () => {
    expect(
      shareTargetOf("gmail", "create_draft", { to: "x@y.test", body: "hi" }),
    ).toBeNull();
    expect(shareTargetOf("notion", "update_page", { text: "hi" })).toBeNull();
    expect(shareTargetOf("linear", "create_issue", { title: "hi" })).toBeNull();
  });
});

/*
 * The release review's email: the approval card showed the body's first 280 characters, with the
 * subject glued on as the body's last line, and Details said "recipients": 0 while the fake Google
 * received all 414 characters. The send is described here in its parts, whole.
 */
describe("what an email send is described as", () => {
  const BODY = [
    "Hi Sam,",
    "",
    `The glaze order is delayed. ${"We can substitute Oat Satin, which matches in every test tile we fired. ".repeat(5)}`,
    "The ship date moves from Friday to Saturday.",
    "",
    "Thanks,",
    "Maya",
  ].join("\n");
  const reply = {
    threadId: "t-1",
    inReplyTo: "m-1",
    to: ["Sam <sam@example.test>"],
    cc: ["ops@example.test"],
    subject: "Re: Glaze delay: substitute?",
    body: BODY,
  };

  test("keeps the whole body, with nothing cut and no subject in it", () => {
    const target = shareTargetOf("google-workspace", "gmail_send_reply", reply);
    expect(BODY.length).toBeGreaterThan(280);
    expect(target?.content).toBe(BODY);
    expect(target?.content).not.toContain("Glaze delay: substitute?");
  });

  test("names the subject, every recipient and the rest of the call apart", () => {
    const target = shareTargetOf("google-workspace", "gmail_send_reply", reply);
    expect(target?.message).toEqual({
      to: ["Sam <sam@example.test>"],
      cc: ["ops@example.test"],
      subject: "Re: Glaze delay: substitute?",
      alsoSent: { threadId: "t-1", inReplyTo: "m-1" },
    });
  });

  test("keeps the scope it always had, so a saved Always allow still matches", () => {
    expect(
      shareTargetOf("google-workspace", "gmail_send_reply", reply)?.audience,
    ).toMatchObject({
      id: "Sam <sam@example.test> ops@example.test",
      label: "google-workspace: Sam <sam@example.test> ops@example.test",
    });
  });

  test("addresses a Composio send by its recipient, not by the tool's name", () => {
    const target = shareTargetOf("gmail", "GMAIL_SEND_EMAIL", {
      recipient_email: "ana@example.test",
      extra_recipients: ["bo@example.test", "cy@example.test"],
      subject: "Hello",
      body: "Hi Ana",
      attachment: { name: "plan.pdf", s3key: "k" },
    });
    expect(target?.audience.id).toBe(
      "ana@example.test bo@example.test, cy@example.test",
    );
    expect(target?.message).toEqual({
      to: ["ana@example.test", "bo@example.test", "cy@example.test"],
      subject: "Hello",
      // An attachment is part of what goes; it travels with the approval rather than unseen.
      alsoSent: { attachment: { name: "plan.pdf", s3key: "k" } },
    });
  });

  test("a send with no body carries its arguments whole, never cut", () => {
    const blocks = Array.from({ length: 600 }, (_, index) => `row ${index}`);
    const target = shareTargetOf("slack", "chat_post", {
      channel: "C1",
      rows: blocks,
    });
    expect(target?.content).toBe(
      JSON.stringify({ channel: "C1", rows: blocks }),
    );
    expect(target?.content.length).toBeGreaterThan(4000);
  });

  test("reads a comma in a quoted display name as part of the name", () => {
    expect(
      shareTargetOf("gmail", "GMAIL_SEND_EMAIL", {
        to: '"Rivera, Sam" <sam@example.test>, ana@example.test',
        body: "hi",
      })?.message.to,
    ).toEqual(['"Rivera, Sam" <sam@example.test>', "ana@example.test"]);
  });
});
