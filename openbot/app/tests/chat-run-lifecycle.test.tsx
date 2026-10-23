import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  type Mock,
  spyOn,
  test,
} from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import type { ApprovalInboxData, ApprovalRequest } from "@/lib/approvals";
import { frameFirstDay } from "@/lib/channels/first-day";
import { type AgentChannel, channelKeys } from "@/lib/channels/queries";
import { forgetSeedClaims } from "@/lib/channels/run-lifecycle";
import { queryClient } from "@/query-client";

/**
 * Chat's run lifecycle, end to end through the real provider, `ChannelChat`, the composer and its
 * queue. Only the HTTP boundary is synthetic, and it can hold a join open the way the realtime
 * runtime does while a turn is going.
 *
 * The three Blockers from the 22 Oct parity review:
 * - a message sent right after Allow once was drawn as sent and never run;
 * - a reload mid-run dropped the pill and Stop, and the answer never came to that tab;
 * - a first day could greet twice and show "Thread <uuid> is locked".
 */

const NativeResponse = globalThis.Response;
const NativeReadableStream = globalThis.ReadableStream;
const BOT = "lifecycle-bot";

type Responder = (input: RunAgentInput) => Response;
let runRequests: RunAgentInput[] = [];
let connectCalls = 0;
let onRun: Responder;
let onConnect: (call: number) => Response;
let storedMessages: Message[] = [];
let inbox: ApprovalInboxData;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A join held open, the way the realtime runtime streams a turn that is still going. */
function heldJoin() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const body = new NativeReadableStream<Uint8Array>({
    start(opened) {
      controller = opened;
    },
  });
  return {
    response: new NativeResponse(body, {
      headers: { "content-type": "text/event-stream" },
    }),
    push(events: unknown[]) {
      for (const event of events)
        controller?.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
    },
    end() {
      controller?.close();
    },
  };
}

function idleJoin(messages: Message[]) {
  return sse([
    { type: "RUN_STARTED", threadId: "t", runId: `join-${connectCalls}` },
    { type: "MESSAGES_SNAPSHOT", messages },
    { type: "RUN_FINISHED", threadId: "t", runId: `join-${connectCalls}` },
  ]);
}

function said(id: string, text: string) {
  return [
    { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
    { type: "TEXT_MESSAGE_END", messageId: id },
  ];
}

const emptyInbox: ApprovalInboxData = {
  enabled: true,
  requests: [],
  rules: [],
  teamRules: [],
  questions: [],
};

beforeAll(() => {
  GlobalRegistrator.register();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname.startsWith("/api/plugins/for/"))
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname === "/api/approvals") return NativeResponse.json(inbox);
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: { [BOT]: { description: "Fixture", capabilities: {} } },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect")) {
        connectCalls += 1;
        return onConnect(connectCalls);
      }
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        runRequests.push(body);
        return onRun(body);
      }
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname))
        return NativeResponse.json({ messages: storedMessages });
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    },
    { preconnect: originalFetch.preconnect },
  );
});
let muted: Mock<typeof console.error> | undefined;
/** The SDK logs a refused run loudly; these tests refuse runs on purpose. */
function quiet() {
  muted = spyOn(console, "error").mockImplementation(() => {});
}
afterEach(() => {
  cleanup();
  queryClient.clear();
  forgetSeedClaims();
  muted?.mockRestore();
  muted = undefined;
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

let channelCount = 0;
function freshChannel(): AgentChannel {
  channelCount += 1;
  return {
    id: `lifecycle-channel-${channelCount}`,
    name: "Lifecycle",
    agentIds: [BOT],
    threadId: `lifecycle-thread-${channelCount}`,
    active: true,
    lastMessageAt: null,
  };
}

function reset({
  stored = [],
  join = (call: number) => idleJoin(call === 1 ? stored : []),
}: {
  stored?: Message[];
  join?: (call: number) => Response;
} = {}) {
  runRequests = [];
  connectCalls = 0;
  storedMessages = stored;
  inbox = emptyInbox;
  onConnect = join;
  onRun = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      ...said(`reply-${runRequests.length}`, `Reply ${runRequests.length}`),
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]);
}

function tree(channel: AgentChannel) {
  queryClient.setQueryData(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            ...channel,
            summary: null,
            lastMessage: null,
            lastMessageAgentId: null,
            createdAt: "2026-10-22T00:00:00.000Z",
            pinned: false,
            lastReadAt: null,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  return (
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ChannelChat channel={channel} runtimeAgentId={BOT} />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

async function type(view: ReturnType<typeof render>, text: string) {
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(view.getByRole("textbox", { name: "Message" }), text);
  await user.keyboard("{Enter}");
}

function lastUserText(input: RunAgentInput | undefined) {
  return input?.messages.filter((message) => message.role === "user").at(-1)
    ?.content;
}

/** A turn that asked before sending, ended on the approvals inbox's own wait. */
function askedBeforeSending(input: RunAgentInput) {
  return sse([
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    {
      type: "TOOL_CALL_START",
      toolCallId: "call-send",
      toolCallName: "gmail_send_reply",
      parentMessageId: "ask",
    },
    { type: "TOOL_CALL_ARGS", toolCallId: "call-send", delta: "{}" },
    { type: "TOOL_CALL_END", toolCallId: "call-send" },
    {
      type: "RUN_FINISHED",
      threadId: input.threadId,
      runId: input.runId,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "call-send",
            reason: "human_input",
            toolCallId: "call-send",
            message: "Waiting for permission. Nothing was sent.",
            metadata: { openbotWaiting: { approvalId: "approval-1" } },
          },
        ],
      },
    },
  ]);
}

function approval(channel: AgentChannel, status: string): ApprovalRequest {
  return {
    id: "approval-1",
    status,
    createdAt: "2026-10-22T00:00:00.000Z",
    action: {
      botId: BOT,
      toolRef: "google-workspace/gmail_send_reply",
      effect: "send",
      scope: "ana@hearthandco.com",
      threadId: channel.threadId,
      toolCallId: "call-send",
      args: {},
      target: null,
    },
  };
}

const LOCK_OR_ID = /locked|lock denied|[0-9a-f]{8}-[0-9a-f]{4}-|HTTP \d{3}/i;

test("a message sent after a turn that asked before acting is run, not dropped", async () => {
  const channel = freshChannel();
  reset();
  onRun = (input) =>
    runRequests.length === 1
      ? askedBeforeSending(input)
      : sse([
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          ...said("monday", "Nothing on Monday."),
          {
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          },
        ]);
  const view = render(tree(channel));
  await waitFor(() => expect(connectCalls).toBe(1));

  await type(view, "Email Ana that Tuesday works.");
  await waitFor(() => expect(runRequests).toHaveLength(1));
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );

  await type(view, "Also, what's on my calendar Monday?");
  await waitFor(() => expect(runRequests).toHaveLength(2));
  expect(lastUserText(runRequests[1])).toBe(
    "Also, what's on my calendar Monday?",
  );
  expect(await view.findByText("Nothing on Monday.")).toBeTruthy();
});

test("after Allow once, a message typed meanwhile is Queued and answered after the server's continuation", async () => {
  const channel = freshChannel();
  const continuation = heldJoin();
  reset({
    join: (call) => (call === 1 ? idleJoin([]) : continuation.response),
  });
  onRun = (input) =>
    runRequests.length === 1
      ? askedBeforeSending(input)
      : sse([
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          ...said("monday", "Nothing on Monday."),
          {
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          },
        ]);
  inbox = { ...emptyInbox, requests: [approval(channel, "pending")] };
  const view = render(tree(channel));
  await waitFor(() => expect(connectCalls).toBe(1));
  await type(view, "Email Ana that Tuesday works.");
  await waitFor(() => expect(runRequests).toHaveLength(1));
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  const asked = [
    ...runRequests[0]!.messages,
    {
      id: "ask",
      role: "assistant",
      toolCalls: [
        {
          id: "call-send",
          type: "function",
          function: { name: "gmail_send_reply", arguments: "{}" },
        },
      ],
    },
  ] as Message[];

  // Allow once, decided in the card: the inbox now says so, and the server takes the turn.
  inbox = { ...emptyInbox, requests: [approval(channel, "approved")] };
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["approvals"] });
  });
  await waitFor(() => expect(connectCalls).toBe(2));
  continuation.push([
    { type: "RUN_STARTED", threadId: channel.threadId, runId: "continuation" },
    { type: "MESSAGES_SNAPSHOT", messages: asked },
  ]);
  await view.findByRole("button", { name: "Stop the Bot" });

  await type(view, "Also, what's on my calendar Monday?");
  expect(await view.findByText("Queued")).toBeTruthy();
  expect(runRequests).toHaveLength(1);

  continuation.push([
    {
      type: "TOOL_CALL_RESULT",
      messageId: "sent",
      toolCallId: "call-send",
      content: "Sent.",
    },
    ...said("sent-reply", "Sent to Ana."),
    { type: "RUN_FINISHED", threadId: channel.threadId, runId: "continuation" },
  ]);
  continuation.end();

  expect(await view.findByText("Sent to Ana.")).toBeTruthy();
  await waitFor(() => expect(runRequests).toHaveLength(2));
  expect(lastUserText(runRequests[1])).toBe(
    "Also, what's on my calendar Monday?",
  );
  expect(await view.findByText("Nothing on Monday.")).toBeTruthy();
  expect(view.queryByText("Queued")).toBeNull();
  expect(view.container.textContent).not.toMatch(LOCK_OR_ID);
});

test("a reload mid-run re-joins the turn: Stop stays past the join deadline and the answer lands in the same tab", async () => {
  const channel = freshChannel();
  const question: Message = {
    id: "question",
    role: "user",
    content: "What does Ana still need from me?",
  };
  const running = heldJoin();
  // The second ask is the deadline's question to the runtime: which run holds the thread.
  reset({
    stored: [question],
    join: (call) =>
      call === 1
        ? running.response
        : NativeResponse.json({ threadId: channel.threadId, runId: "live" }),
  });
  const view = render(tree(channel));
  await waitFor(() => expect(connectCalls).toBe(1));
  running.push([
    { type: "RUN_STARTED", threadId: channel.threadId, runId: "live" },
    { type: "MESSAGES_SNAPSHOT", messages: [question] },
  ]);
  expect(
    await view.findByText("What does Ana still need from me?"),
  ).toBeTruthy();

  // Past the 1.5 s join deadline: a join streaming a live turn is kept, so Stop is still there.
  await act(() => new Promise((resolve) => setTimeout(resolve, 2200)));
  expect(view.getByRole("button", { name: "Stop the Bot" })).toBeTruthy();

  storedMessages = [
    question,
    {
      id: "answer",
      role: "assistant",
      content: "The 200-mug answer, by Friday.",
    },
  ];
  running.push([
    ...said("answer", "The 200-mug answer, by Friday."),
    { type: "RUN_FINISHED", threadId: channel.threadId, runId: "live" },
  ]);
  running.end();
  expect(await view.findByText("The 200-mug answer, by Friday.")).toBeTruthy();
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  expect(view.getAllByText("The 200-mug answer, by Friday.")).toHaveLength(1);
  expect(runRequests).toHaveLength(0);
}, 15_000);

test("a channel's creating message is sent once, across StrictMode and a remount", async () => {
  const channel = freshChannel();
  reset();
  stashFirstMessage(channel.id, "Book the kiln for Friday.");
  const first = render(<StrictMode>{tree(channel)}</StrictMode>);
  await waitFor(() => expect(runRequests).toHaveLength(1));
  await first.findByText("Reply 1");
  first.unmount();

  // The same start, twice: a greeting stashed again for the same channel, mounted again.
  stashFirstMessage(channel.id, "Book the kiln for Friday.");
  render(<StrictMode>{tree(channel)}</StrictMode>);
  await act(() => new Promise((resolve) => setTimeout(resolve, 2500)));
  expect(runRequests).toHaveLength(1);
}, 15_000);

test("a first day that meets another device's greeting follows it: one welcome, no second send, no lock error", async () => {
  const channel = freshChannel();
  const request = "Read my mail and tell me how you can help.";
  const otherDevice: Message = {
    id: "other-device",
    role: "user",
    content: frameFirstDay(request),
  };
  reset({
    join: (call) =>
      call === 1
        ? idleJoin([])
        : sse([
            {
              type: "RUN_STARTED",
              threadId: channel.threadId,
              runId: "theirs",
            },
            { type: "MESSAGES_SNAPSHOT", messages: [otherDevice] },
            ...said("their-answer", "You run Marlow Ceramics."),
            {
              type: "RUN_FINISHED",
              threadId: channel.threadId,
              runId: "theirs",
            },
          ]),
  });
  quiet();
  onRun = () =>
    NativeResponse.json({ error: "Thread lock denied" }, { status: 409 });
  storedMessages = [];
  stashFirstMessage(channel.id, frameFirstDay(request));
  const view = render(<StrictMode>{tree(channel)}</StrictMode>);

  expect(await view.findByText("You run Marlow Ceramics.")).toBeTruthy();
  storedMessages = [
    otherDevice,
    {
      id: "their-answer",
      role: "assistant",
      content: "You run Marlow Ceramics.",
    },
  ];
  await act(() => new Promise((resolve) => setTimeout(resolve, 2500)));
  expect(runRequests).toHaveLength(1);
  expect(view.getAllByText(/our first day/i)).toHaveLength(1);
  expect(view.container.textContent).not.toMatch(LOCK_OR_ID);
}, 15_000);

test("a message refused by the lock is Queued, not handed back, and runs when the turn holding the thread ends", async () => {
  const channel = freshChannel();
  const theirs = heldJoin();
  reset({ join: (call) => (call === 1 ? idleJoin([]) : theirs.response) });
  quiet();
  onRun = (input) =>
    runRequests.length === 1
      ? NativeResponse.json({ error: "Thread lock denied" }, { status: 409 })
      : sse([
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          ...said("weather", "Sunny on Saturday."),
          {
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          },
        ]);
  const view = render(tree(channel));
  await waitFor(() => expect(connectCalls).toBe(1));

  await type(view, "What's the weather for the market?");
  await waitFor(() => expect(connectCalls).toBe(2));
  theirs.push([
    { type: "RUN_STARTED", threadId: channel.threadId, runId: "theirs" },
    { type: "MESSAGES_SNAPSHOT", messages: [] },
  ]);
  expect(await view.findByText("Queued")).toBeTruthy();
  expect(view.getAllByText("What's the weather for the market?")).toHaveLength(
    1,
  );
  expect(
    (view.getByRole("textbox", { name: "Message" }) as HTMLElement).textContent,
  ).toBe("");
  expect(view.container.textContent).not.toMatch(LOCK_OR_ID);
  expect(runRequests).toHaveLength(1);

  theirs.push([
    ...said("their-answer", "Done with the other tab's question."),
    { type: "RUN_FINISHED", threadId: channel.threadId, runId: "theirs" },
  ]);
  theirs.end();
  await waitFor(() => expect(runRequests).toHaveLength(2));
  expect(lastUserText(runRequests[1])).toBe(
    "What's the weather for the market?",
  );
  expect(await view.findByText("Sunny on Saturday.")).toBeTruthy();
  expect(view.queryByText("Queued")).toBeNull();
}, 15_000);
