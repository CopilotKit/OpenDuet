import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { MorningBriefCard } from "@/components/duet/morning-brief-card";
import type { ApprovalRequest } from "@/lib/approvals";

/*
 * The swaps that replace one state with the next in place: Start becoming Started on a brief's row,
 * and an approval's answers becoming the line that says who decided. Each plays only when the change
 * happens on screen; drawn already changed, it is drawn still.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(() => cleanup());
afterAll(() => {
  GlobalRegistrator.unregister();
});

function reducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** A brief with one row that can be started, started on its first press. */
function Brief({ startedAlready = false }: { startedAlready?: boolean }) {
  const [started, setStarted] = useState(startedAlready);
  return (
    <MorningBriefCard
      canWait={[]}
      date="Monday, October 26"
      greeting="Morning, Maya."
      needsYou={[
        {
          id: "ana",
          title: "Ana Ruiz · Revised invoice",
          why: "Asked twice whether the total is final.",
          action: {
            label: "Start",
            name: "Start: Ana Ruiz · Revised invoice",
            ...(started ? { done: "Started" } : {}),
            onPress: () => setStarted(true),
          },
        },
      ]}
    />
  );
}

const label = (container: HTMLElement, state: "ready" | "done") =>
  container.querySelector<HTMLElement>(`[data-row-action="${state}"]`);

test("pressed, Start turns into Started in place, the new words rising out of a blur", () => {
  reducedMotion(false);
  const view = render(<Brief />);
  // Drawn as it is on the first paint: nothing to arrive from.
  expect(label(view.container, "ready")?.style.opacity ?? "").not.toBe("0");
  fireEvent.click(view.getByRole("button", { name: /^Start: Ana/ }));
  const button = view.getByRole("button", { name: "Started" });
  expect(button.hasAttribute("disabled")).toBe(true);
  const done = label(view.container, "done");
  expect(done?.textContent).toBe("Started");
  // On its way in: transparent, below its place and blurred, until motion draws it there.
  expect(done?.style.opacity).toBe("0");
  expect(done?.style.filter).toBe("blur(2px)");
  expect(done?.style.transform).toContain("translateY(4px)");
});

test("with reduced motion the words only cross-fade", () => {
  reducedMotion(true);
  const view = render(<Brief />);
  fireEvent.click(view.getByRole("button", { name: /^Start: Ana/ }));
  const done = label(view.container, "done");
  expect(done?.style.opacity).toBe("0");
  expect(done?.style.filter ?? "").toBe("");
  expect(done?.style.transform ?? "").toBe("");
  reducedMotion(false);
});

test("a row drawn already started is drawn still", () => {
  reducedMotion(false);
  const view = render(<Brief startedAlready />);
  const done = label(view.container, "done");
  expect(done?.textContent).toBe("Started");
  expect(done?.style.opacity ?? "").not.toBe("0");
  expect(label(view.container, "ready")).toBeNull();
});

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: "a1",
  status: "approved",
  createdAt: "2026-10-26T09:00:00Z",
  decision: "allow_once",
  decidedAt: "2026-10-26T09:01:00Z",
  action: {
    botId: "openduet",
    toolRef: "gmail/GMAIL_SEND_EMAIL",
    effect: "write",
    scope: "external",
    threadId: "t1",
    toolCallId: "call-1",
    args: { to: "ana@hearthandco.com" },
    target: null,
    policy: { behaviour: "ask", source: "default", reason: "" },
  },
  ...over,
});

test("decided while it was on screen, the line saying so arrives, its check landing", () => {
  reducedMotion(false);
  const view = render(<ApprovalCard compact decidedNow request={request()} />);
  const line = view.container.querySelector<HTMLElement>("[data-decided-line]");
  expect(line?.textContent).toContain("Allowed once by you");
  expect(line?.style.opacity).toBe("0");
  expect(line?.querySelector(".duet-check-land")).toBeTruthy();
  const pill = view.container.querySelector<HTMLElement>("[data-outcome]");
  expect(pill?.style.opacity).toBe("0");
});

test("read back from history, a decided card is drawn still", () => {
  reducedMotion(false);
  const view = render(<ApprovalCard compact request={request()} />);
  const line = view.container.querySelector<HTMLElement>("[data-decided-line]");
  expect(line?.textContent).toContain("Allowed once by you");
  expect(line?.style.opacity ?? "").not.toBe("0");
  expect(line?.querySelector(".duet-check-land")).toBeNull();
});

test("a card that was waiting and is decided in place swaps its answers for the line", () => {
  reducedMotion(false);
  const waiting = request({
    status: "pending",
    decision: null,
    decidedAt: null,
  });
  const view = render(<ApprovalCard onDecide={() => {}} request={waiting} />);
  expect(view.getByRole("button", { name: "Allow once" })).toBeTruthy();
  view.rerender(<ApprovalCard onDecide={() => {}} request={request()} />);
  expect(view.queryByRole("button", { name: "Allow once" })).toBeNull();
  const line = view.container.querySelector<HTMLElement>("[data-decided-line]");
  expect(line?.style.opacity).toBe("0");
  expect(line?.querySelector(".duet-check-land")).toBeTruthy();
});
