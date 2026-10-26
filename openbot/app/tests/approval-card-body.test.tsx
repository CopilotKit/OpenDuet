import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ApprovalCard, FOLD_CHARS } from "@/components/approvals/approval-card";
import type { ApprovalRequest } from "@/lib/approvals";

/**
 * The body of what a Bot wants to send, on the card that asks for Allow once.
 *
 * It was a box of fixed height over a body the server had cut to 280 characters, so the card
 * stopped mid-word with nothing to open. The whole body is on the card now: a long one is folded,
 * and "Show all" under it says how much there is and opens it in place.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

function request(body: string): ApprovalRequest {
  return {
    id: "approval-1",
    status: "pending",
    decision: null,
    result: null,
    createdAt: new Date().toISOString(),
    decidedAt: null,
    action: {
      botId: "bot-1",
      toolRef: "openbot/share_private_information",
      effect: "share_private",
      scope: "external:sam@example.test",
      threadId: "t",
      args: {
        audience: "google-workspace: sam@example.test",
        to: ["sam@example.test"],
        subject: "Re: Glaze delay",
        body,
      },
      target: {},
    },
  } as unknown as ApprovalRequest;
}

const LONG = `Hi Sam,\n\n${"The glaze is delayed; we can substitute Oat Satin or wait two weeks. ".repeat(10)}The ship date moves from Friday to Saturday.\n\nThanks,\nMaya`;

test("a long body is all on the card, folded, with Show all saying how much there is", () => {
  expect(LONG.length).toBeGreaterThan(FOLD_CHARS);
  const view = render(
    <ApprovalCard onDecide={() => {}} request={request(LONG)} />,
  );
  const body = view.getByText(
    (_, element) => element?.textContent === LONG && element.tagName === "P",
  );
  // Nothing is held back from the page, folded or not: the end of the email is there.
  expect(body.textContent).toContain("moves from Friday to Saturday.");
  expect(body.getAttribute("data-folded")).toBe("true");

  const more = view.getByRole("button", { name: /Show all/ });
  expect(more.textContent).toContain(
    `Show all ${LONG.length.toLocaleString()} characters`,
  );
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(more.getAttribute("aria-controls")).toBe(body.id);

  fireEvent.click(more);
  expect(body.getAttribute("data-folded")).toBeNull();
  expect(
    view
      .getByRole("button", { name: /Show less/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

test("the subject is its own field, and not the body's last line", () => {
  const view = render(
    <ApprovalCard onDecide={() => {}} request={request("Hi Sam")} />,
  );
  expect(view.getByText("Re: Glaze delay")).toBeTruthy();
  expect(view.getByText("Hi Sam").textContent).toBe("Hi Sam");
});

test("a short body is shown as it is, with nothing to open", () => {
  const view = render(
    <ApprovalCard onDecide={() => {}} request={request("Hi Sam, yes.")} />,
  );
  expect(view.queryByRole("button", { name: /Show all/ })).toBeNull();
  expect(view.getByText("Hi Sam, yes.").getAttribute("data-folded")).toBeNull();
});
