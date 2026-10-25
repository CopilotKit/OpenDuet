import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { approvalInboxOptions } from "@/lib/approvals";
import { settleReactWork } from "./settle-react-work";

/**
 * A gated call that is the only step of its turn keeps its approval card in the conversation.
 *
 * A run of steps folds into one line with the cards for its waiting calls beside it
 * (`ToolActivity`), but a single call keeps a line of its own, and that line had no card: the
 * request waited in Tasks while the conversation showed a step that never finished. Reply chips made
 * it the common case, because a tapped answer is often followed by the send and nothing else.
 */

let approvals: unknown[] = [];
let asked = 0;
const decisions: { path: string; method?: string; body?: BodyInit | null }[] =
  [];
let realFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/decision")) {
        decisions.push({
          path: String(input),
          method: init?.method,
          body: init?.body,
        });
        return Response.json({ ok: true });
      }
      if (String(input).endsWith("/api/approvals")) {
        asked += 1;
        if (decisions.length > 0)
          return Response.json({ error: "Inbox unavailable" }, { status: 503 });
        return Response.json({
          enabled: true,
          requests: approvals,
          questions: [],
        });
      }
      return Response.json({});
    },
    { preconnect: realFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  approvals = [];
  asked = 0;
  decisions.length = 0;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

const SEND = "mcp__google-workspace__gmail_send_reply";

/** The person's tapped answer, then the Bot's one call: the send, still waiting on its result. */
const turn: Message[] = [
  { id: "user-1", role: "user", content: "Double-wall boxes" },
  {
    id: "assistant-1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "toolu_send",
        type: "function",
        function: {
          name: SEND,
          arguments: JSON.stringify({
            to: "sam@marlowceramics.com",
            body: "Hi Sam, please use the double-wall boxes for the Hearth order.",
          }),
        },
      },
    ],
  },
];

const waitingSend = (toolCallId: string) => ({
  id: `approval-${toolCallId}`,
  status: "pending",
  createdAt: "2026-10-22T20:04:43Z",
  action: {
    botId: "openduet",
    toolRef: "openbot/share_private_information",
    effect: "share_private",
    scope: "external:sam@marlowceramics.com",
    threadId: "thread",
    toolCallId,
    args: {
      recipient_email: "sam@marlowceramics.com",
      subject: "Re: Which box for the Hearth order?",
      body: "Hi Sam, please use the double-wall boxes for the Hearth order.",
    },
    target: {},
    policy: { behaviour: "ask", source: "rule", reason: "Emails ask first." },
  },
});

/**
 * The transcript asks CopilotKit for a renderer per call. None is registered for a connector tool,
 * which is the case under test: the call is drawn by the transcript's own line.
 */
const noRenderers = {
  copilotkit: {
    renderToolCalls: [],
    subscribe: () => ({ unsubscribe() {} }),
  },
  executingToolCallIds: new Set<string>(),
} as never;

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <CopilotKitContext.Provider value={noRenderers}>
      <QueryClientProvider client={client}>
        <ChatTranscript messages={turn} />
      </QueryClientProvider>
    </CopilotKitContext.Provider>,
  );
  return { ...view, client };
}

test("a gated call alone in its turn draws its approval card under its own line", async () => {
  approvals = [waitingSend("toolu_send")];
  const view = draw();
  expect(await view.findByRole("button", { name: "Allow once" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Refuse" })).toBeTruthy();
  // Held on its card, the line waits for the person rather than claiming to send.
  expect(view.getByText("Waiting for your OK to send your email")).toBeTruthy();
});

test("a request for some other call draws nothing under this one", async () => {
  approvals = [waitingSend("toolu_other")];
  const view = draw();
  await waitFor(() => expect(asked).toBeGreaterThan(0));
  await settleReactWork();
  expect(view.getByText("Sending your email")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Allow once" })).toBeNull();
});

test("an accepted inline refusal stays decided when the inbox refresh fails", async () => {
  approvals = [waitingSend("toolu_send")];
  const view = draw();
  const key = approvalInboxOptions().queryKey;
  fireEvent.click(await view.findByRole("button", { name: "Refuse" }));
  await waitFor(() =>
    expect(view.client.getQueryState(key)?.status).toBe("error"),
  );
  expect(decisions).toEqual([
    {
      path: "/api/approvals/approval-toolu_send/decision",
      method: "POST",
      body: '{"decision":"deny"}',
    },
  ]);
  await waitFor(() =>
    expect(
      view.queryAllByRole("region", { name: "Waiting for your approval" })
        .length,
    ).toBe(0),
  );
  expect(view.queryByRole("button", { name: "Allow once" })).toBeNull();
  expect(view.queryByRole("button", { name: "Refuse" })).toBeNull();
  expect(
    view.client.getQueryData(approvalInboxOptions().queryKey)?.requests[0],
  ).toMatchObject({
    id: "approval-toolu_send",
    status: "denied",
    decision: "deny",
    decidedAt: expect.any(String),
  });
});

test("a send the person declined is never named as sent", async () => {
  approvals = [];
  const declined: Message[] = [
    ...turn,
    {
      id: "result-1",
      role: "tool",
      toolCallId: "toolu_send",
      content:
        "The person declined this action when you asked for their approval, so it was not done.",
    },
  ];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <CopilotKitContext.Provider value={noRenderers}>
      <QueryClientProvider client={client}>
        <ChatTranscript messages={declined} />
      </QueryClientProvider>
    </CopilotKitContext.Provider>,
  );
  expect(await view.findByText("You declined: Send your email")).toBeTruthy();
  expect(view.queryByText(/Sent your email/)).toBeNull();
});
