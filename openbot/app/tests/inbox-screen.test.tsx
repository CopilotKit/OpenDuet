import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InboxScreen } from "@/components/shell/inbox-screen";
import { agentKeys } from "@/lib/agents/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The Inbox tab: what is waiting on the person, each item answered where it is shown, and a plain
 * sentence when nothing is.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

let inbox: Record<string, unknown> = {};
const sent: { path: string; body: unknown }[] = [];
function serving() {
  sent.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET") {
      sent.push({
        path: url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({ ok: true });
    }
    if (url === "/api/approvals") return Response.json(inbox);
    return Response.json({});
  }) as unknown as typeof fetch;
}

function draw() {
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "openduet", name: "OpenDuet" },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <InboxScreen />
    </QueryClientProvider>,
  );
}

const email = {
  id: "mail-1",
  status: "pending",
  createdAt: "2026-10-21T14:59:00Z",
  action: {
    botId: "openduet",
    toolRef: "gmail/GMAIL_SEND_EMAIL",
    effect: "write",
    scope: "ana@hearth.example",
    threadId: "thread",
    toolCallId: "call-1",
    args: {
      recipient_email: "ana@hearth.example",
      subject: "Ship date for your mugs",
      body: "Hi Ana, could we ship on Tuesday instead?",
    },
    target: {},
    policy: { behaviour: "ask", source: "rule", reason: "Emails ask first." },
  },
};

test("with nothing waiting it says so", async () => {
  inbox = { requests: [], questions: [] };
  serving();
  const view = draw();
  expect(await view.findByText("Nothing has needed you today.")).toBeTruthy();
  expect(view.queryByRole("list", { name: "Waiting on you" })).toBeNull();
});

test("a decided action is not waiting, so it is not listed", async () => {
  inbox = {
    requests: [{ ...email, status: "completed", decision: "allow_once" }],
    questions: [],
  };
  serving();
  const view = draw();
  expect(await view.findByText("Nothing has needed you today.")).toBeTruthy();
});

test("a waiting email is drawn as the film's card and answered from it", async () => {
  inbox = { requests: [email], questions: [] };
  serving();
  const view = draw();
  const card = await view.findByRole("region", {
    name: "Waiting for your approval",
  });
  expect(card.textContent).toContain("Send email");
  expect(card.textContent).toContain("ana@hearth.example");
  expect(card.textContent).toContain("Ship date for your mugs");
  expect(card.textContent).toContain("could we ship on Tuesday");
  expect(view.getByRole("button", { name: "Refuse" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Always allow" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/mail-1/decision",
      body: { decision: "allow_once" },
    }),
  );
});

test("Refuse sends a refusal", async () => {
  inbox = { requests: [email], questions: [] };
  serving();
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "Refuse" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/mail-1/decision",
      body: { decision: "deny" },
    }),
  );
});

test("a question is answered in place", async () => {
  inbox = {
    requests: [],
    questions: [
      {
        id: "q-1",
        botId: "openduet",
        threadId: "thread",
        question: "Which deck should I review?",
        createdAt: "2026-10-21T10:00:00Z",
      },
    ],
  };
  serving();
  const view = draw();
  expect(await view.findByText("OpenDuet asks")).toBeTruthy();
  expect(view.getByText("Which deck should I review?")).toBeTruthy();
  const send = view.getByRole("button", { name: "Send answer" });
  expect(send.hasAttribute("disabled")).toBe(true);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(
    view.getByRole("textbox", { name: "Your answer" }),
    "The launch deck",
  );
  await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
  fireEvent.click(send);
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/questions/q-1/respond",
      body: { response: "The launch deck" },
    }),
  );
});
