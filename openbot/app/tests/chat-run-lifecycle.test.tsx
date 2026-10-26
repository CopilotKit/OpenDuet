import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  type Mock,
  mock,
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
import { type ComponentProps, StrictMode } from "react";
import { z } from "zod";
import { ChannelChat } from "@/components/channels/channel-chat";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import type { ApprovalInboxData, ApprovalRequest } from "@/lib/approvals";
import { frameFirstDay } from "@/lib/channels/first-day";
import { type AgentChannel, channelKeys } from "@/lib/channels/queries";
import {
  APPROVAL_WAITING_RESULT,
  forgetSeedClaims,
} from "@/lib/channels/run-lifecycle";
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
/** The runtime's answer to "which run holds this thread": idle unless a test says otherwise. */
let onAsk: () => Response;
let storedMessages: Message[] = [];
let inbox: ApprovalInboxData;
const busyRequestSchema = z.object({ busy: z.boolean(), runId: z.string() });
type BusyRequest = z.infer<typeof busyRequestSchema>;
let busyRequests: BusyRequest[] = [];
let onBusy: (input: BusyRequest) => Response | Promise<Response>;

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
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = (await request.json().catch(() => ({}))) as {
          forwardedProps?: { openbotAsk?: string };
        };
        // Chat's own question to the runtime: which run holds the thread. Not a join.
        if (body.forwardedProps?.openbotAsk === "live-run") return onAsk();
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
      if (/\/api\/channels\/[^/]+\/busy$/.test(url.pathname)) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = busyRequestSchema.parse(await request.json());
        busyRequests.push(body);
        return onBusy(body);
      }
      if (/\/api\/channels\/[^/]+\/activity$/.test(url.pathname))
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
let warned: Mock<typeof console.warn> | undefined;
/** The SDK logs a refused run loudly; these tests refuse runs on purpose. */
function quiet() {
  muted = spyOn(console, "error").mockImplementation(() => {});
}
/** Busy failures stay in diagnostics, without adding a user-facing turn failure. */
function captureWarnings() {
  warned = spyOn(console, "warn").mockImplementation(() => {});
  return warned;
}
afterEach(() => {
  cleanup();
  queryClient.clear();
  forgetSeedClaims();
  muted?.mockRestore();
  muted = undefined;
  warned?.mockRestore();
  warned = undefined;
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
  busyRequests = [];
  onBusy = () => new NativeResponse(null, { status: 204 });
  onConnect = join;
  onAsk = () => NativeResponse.json({ threadId: "t", joinToken: "token" });
  onRun = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      ...said(`reply-${runRequests.length}`, `Reply ${runRequests.length}`),
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]);
}

function tree(
  channel: AgentChannel,
  frontendTools?: ComponentProps<typeof CopilotKitProvider>["frontendTools"],
) {
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
      <CopilotKitProvider
        frontendTools={frontendTools}
        runtimeUrl="http://localhost/api/copilotkit"
      >
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

test.each(["fulfills", "rejects"])(
  "a delayed busy start that %s is released with the same owner after unmount",
  async (outcome) => {
    const channel = freshChannel();
    const started = Promise.withResolvers<Response>();
    const running = heldJoin();
    const failure = new TypeError("Response lost after busy claim committed");
    reset();
    const warnings = captureWarnings();
    onBusy = ({ busy }) =>
      busy ? started.promise : new NativeResponse(null, { status: 204 });
    onRun = () => running.response;
    const view = render(tree(channel));
    await waitFor(() => expect(connectCalls).toBe(1));
    await type(view, "Hello there");
    await waitFor(() => expect(runRequests).toHaveLength(1));
    expect(busyRequests).toHaveLength(1);
    const owner = busyRequests[0]!.runId;
    expect(owner).not.toBe("");
    view.unmount();

    await act(async () => {
      const input = runRequests[0]!;
      running.push([
        { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        ...said("hello-back", "Hello back."),
        { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
      ]);
      running.end();
    });
    // The turn can finish independently, but its release must wait for the start to settle.
    expect(busyRequests).toEqual([{ busy: true, runId: owner }]);
    if (outcome === "rejects") {
      started.reject(failure);
    } else {
      started.resolve(new NativeResponse(null, { status: 204 }));
    }
    await waitFor(() =>
      expect(busyRequests).toEqual([
        { busy: true, runId: owner },
        { busy: false, runId: owner },
      ]),
    );
    if (outcome === "rejects")
      expect(warnings).toHaveBeenCalledWith(
        "Could not report channel busy state.",
        failure,
      );
  },
);

test.each([
  { notification: "start", failsWhenBusy: true },
  { notification: "release", failsWhenBusy: false },
])(
  "a rejected busy $notification does not fail the turn or its next send",
  async ({ failsWhenBusy }) => {
    const channel = freshChannel();
    reset();
    const warnings = captureWarnings();
    const failure = new TypeError("Busy notification connection dropped");
    onBusy = ({ busy }) => {
      if (busy === failsWhenBusy) throw failure;
      return new NativeResponse(null, { status: 204 });
    };
    const view = render(tree(channel));
    await waitFor(() => expect(connectCalls).toBe(1));
    for (const turn of [1, 2]) {
      await type(view, `Hello ${turn}`);
      expect(await view.findByText(`Reply ${turn}`)).toBeTruthy();
      await waitFor(() =>
        expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
      );
      await waitFor(() => expect(busyRequests).toHaveLength(turn * 2));
      const start = busyRequests[(turn - 1) * 2]!;
      expect(start.busy).toBe(true);
      expect(busyRequests[(turn - 1) * 2 + 1]).toEqual({
        busy: false,
        runId: start.runId,
      });
      expect(view.queryByText("Couldn't reach the Bot. Try again.")).toBeNull();
      expect(warnings).toHaveBeenCalledTimes(turn);
      expect(warnings).toHaveBeenLastCalledWith(
        "Could not report channel busy state.",
        failure,
      );
    }
    expect(runRequests).toHaveLength(2);
    expect(busyRequests[0]!.runId).not.toBe(busyRequests[2]!.runId);
  },
);

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

test("a question sent while the card is undecided tells the Bot the truth, and what is typed after Allow once still waits for the continuation", async () => {
  const channel = freshChannel();
  const continuation = heldJoin();
  let history: Message[] = [];
  reset({
    // The mount's join, then a join after Allow once that finds the continuation not yet begun,
    // then the continuation itself.
    join: (call) =>
      call === 1
        ? idleJoin([])
        : call === 2
          ? sse([{ type: "MESSAGES_SNAPSHOT", messages: history }])
          : continuation.response,
  });
  onRun = (input) => {
    if (runRequests.length === 1) return askedBeforeSending(input);
    const reply =
      runRequests.length === 2
        ? said("leo", "Leo does your contracts.")
        : said("tuesday", "Nothing on Tuesday.");
    return sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      ...reply,
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]);
  };
  inbox = { ...emptyInbox, requests: [approval(channel, "pending")] };
  const view = render(tree(channel));
  await waitFor(() => expect(connectCalls).toBe(1));
  await type(view, "Reply to Ana that the mugs leave Thursday.");
  await waitFor(() => expect(runRequests).toHaveLength(1));
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );

  // The card still waits. A question meanwhile runs, and the Bot is told the send has not run yet.
  await type(view, "Before that, who is Leo?");
  await waitFor(() => expect(runRequests).toHaveLength(2));
  const told = runRequests[1]!.messages.filter(
    (message) => message.role === "tool" && message.toolCallId === "call-send",
  );
  expect(told).toHaveLength(1);
  expect(told[0]?.content).toBe(APPROVAL_WAITING_RESULT);
  expect(JSON.stringify(runRequests[1]!.messages)).not.toMatch(/interrupted/i);
  expect(await view.findByText("Leo does your contracts.")).toBeTruthy();
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  history = [
    ...runRequests[1]!.messages,
    { id: "leo", role: "assistant", content: "Leo does your contracts." },
  ];

  // Allow once. The first join finds the continuation not begun; the call already has a result,
  // the placeholder, and that must not pass for the continuation having landed.
  inbox = { ...emptyInbox, requests: [approval(channel, "approved")] };
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["approvals"] });
  });
  await waitFor(() => expect(connectCalls).toBe(2));
  await type(view, "What's on my calendar Tuesday?");
  expect(await view.findByText("Queued")).toBeTruthy();
  await waitFor(() => expect(connectCalls).toBe(3));
  continuation.push([
    { type: "RUN_STARTED", threadId: channel.threadId, runId: "continuation" },
    { type: "MESSAGES_SNAPSHOT", messages: history },
  ]);
  await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(runRequests).toHaveLength(2);
  expect(view.getByText("Queued")).toBeTruthy();

  // The server records the action's result and its reply.
  storedMessages = [
    ...history,
    {
      id: "sent",
      role: "tool",
      toolCallId: "call-send",
      content: "Sent.",
    } as Message,
    { id: "sent-reply", role: "assistant", content: "Sent to Ana." },
  ];
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
  await waitFor(() => expect(runRequests).toHaveLength(3));
  expect(lastUserText(runRequests[2])).toBe("What's on my calendar Tuesday?");
  // The real result takes the placeholder's place in what the Bot is sent next.
  const results = runRequests[2]!.messages.filter(
    (message) => message.role === "tool" && message.toolCallId === "call-send",
  );
  expect(results.map((message) => message.content)).toEqual(["Sent."]);
  expect(await view.findByText("Nothing on Tuesday.")).toBeTruthy();
}, 15_000);

test.each([
  {
    name: "a 500",
    refuse: () =>
      NativeResponse.json(
        {
          error:
            "Failed to initialize thread 0e2c1a44-9b7d-4c1e-8f00-3a1b2c3d4e5f",
        },
        { status: 500 },
      ),
  },
  {
    name: "a dropped connection",
    refuse: () => {
      throw new TypeError("Failed to fetch");
    },
  },
])(
  "a send that never reaches the server ($name) comes off screen, goes back in the box, and is sent once on retry",
  async ({ refuse }) => {
    const channel = freshChannel();
    reset();
    quiet();
    onRun = (input) =>
      runRequests.length === 1
        ? refuse()
        : sse([
            {
              type: "RUN_STARTED",
              threadId: input.threadId,
              runId: input.runId,
            },
            ...said("hello-back", "Hello back."),
            {
              type: "RUN_FINISHED",
              threadId: input.threadId,
              runId: input.runId,
            },
          ]);
    const view = render(tree(channel));
    await waitFor(() => expect(connectCalls).toBe(1));
    await type(view, "Hello there");
    expect(
      await view.findByText("Couldn't reach the Bot. Try again."),
    ).toBeTruthy();
    // Only the words in the box: no bubble claiming it was sent.
    await waitFor(() =>
      expect(view.getAllByText("Hello there")).toHaveLength(1),
    );
    expect(
      (view.getByRole("textbox", { name: "Message" }) as HTMLElement)
        .textContent,
    ).toBe("Hello there");
    expect(view.container.textContent).not.toMatch(LOCK_OR_ID);

    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(view.getByRole("textbox", { name: "Message" }));
    await user.keyboard("{Enter}");
    expect(await view.findByText("Hello back.")).toBeTruthy();
    expect(view.getAllByText("Hello there")).toHaveLength(1);
    expect(runRequests).toHaveLength(2);
  },
  15_000,
);

test("a model that fails mid-turn is said plainly, and still said after a reload until something newer arrives", async () => {
  const PLAIN =
    "Couldn't reach the AI model. Check your internet connection, then try again.";
  const channel = freshChannel();
  reset();
  quiet();
  onRun = (input) =>
    sse([
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      {
        type: "RUN_ERROR",
        message:
          "Failed after 3 attempts. Last error: Cannot connect to API: Unable to connect. Is the computer able to access the url?",
      },
    ]);
  const view = render(tree(channel));
  await waitFor(() => expect(connectCalls).toBe(1));
  await type(view, "What's on today?");
  expect(await view.findByText(PLAIN)).toBeTruthy();
  expect(view.container.textContent).not.toContain("Is the computer able");
  const sent = runRequests[0]!.messages.at(-1)!;

  // A reload: the thread's stored transcript still ends on the message that failed.
  cleanup();
  reset({ stored: [sent] });
  const reloaded = render(tree(channel));
  expect(await reloaded.findByText(PLAIN)).toBeTruthy();

  // Once a reply has arrived since, from anywhere, the sentence is old news and is not shown.
  cleanup();
  reset({
    stored: [
      sent,
      { id: "reply-later", role: "assistant", content: "Here's your day." },
    ],
  });
  const later = render(tree(channel));
  expect(await later.findByText("Here's your day.")).toBeTruthy();
  expect(later.queryByText(PLAIN)).toBeNull();
  window.sessionStorage.clear();
}, 15_000);

test.each(["network failure", "thread conflict"])(
  "a failed frontend-tool continuation (%s) restores the draft after the intermediate run finishes",
  async (failure) => {
    reset();
    quiet();
    const message =
      failure === "thread conflict"
        ? "The Bot couldn't continue because another turn started. Review what it already did before trying again."
        : "Couldn't reach the Bot. Try again.";
    const result = Promise.withResolvers<string>();
    const tool = mock(() => result.promise);
    const succeed = onRun;
    onRun = (input) => {
      if (runRequests.length === 2) {
        if (failure === "thread conflict")
          return NativeResponse.json(
            { error: "Thread lock denied" },
            { status: 409 },
          );
        throw new TypeError("Failed to fetch");
      }
      if (runRequests.length !== 1) return succeed(input);
      return sse([
        { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        {
          type: "TOOL_CALL_START",
          toolCallId: "look",
          toolCallName: "look",
          parentMessageId: "looking",
        },
        { type: "TOOL_CALL_ARGS", toolCallId: "look", delta: "{}" },
        { type: "TOOL_CALL_END", toolCallId: "look" },
        { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
      ]);
    };
    const view = render(
      tree(freshChannel(), [
        { name: "look", handler: tool, parameters: z.object({}) },
      ]),
    );
    await waitFor(() => expect(connectCalls).toBe(1));
    await type(view, "Look at my screen");
    await waitFor(() => expect(tool).toHaveBeenCalledTimes(1));
    expect(view.getByRole("button", { name: "Stop the Bot" })).toBeTruthy();
    expect(busyRequests).toHaveLength(1);
    await act(async () => result.resolve("Looked."));
    expect(await view.findByText(message)).toBeTruthy();
    await waitFor(() =>
      expect(view.getByRole("textbox", { name: "Message" }).textContent).toBe(
        "Look at my screen",
      ),
    );
    expect(
      runRequests[1]!.messages.filter((message) => message.role === "tool"),
    ).toMatchObject([{ toolCallId: "look", content: "Looked." }]);
    await waitFor(() => expect(busyRequests).toHaveLength(2));
    expect(busyRequests[1]).toEqual({
      busy: false,
      runId: busyRequests[0]!.runId,
    });
    expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull();
    expect(view.queryByText("Queued")).toBeNull();
    expect(view.getAllByText("Look at my screen")).toHaveLength(2);
    expect(runRequests).toHaveLength(2);
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(view.getByRole("textbox", { name: "Message" }));
    await user.keyboard("{Enter}");
    expect(await view.findByText("Reply 3")).toBeTruthy();
    expect(runRequests).toHaveLength(3);
    expect(lastUserText(runRequests[2])).toBe("Look at my screen");
    expect(runRequests[2]!.messages.slice(0, -1)).toEqual(
      runRequests[1]!.messages,
    );
    expect(tool).toHaveBeenCalledTimes(1);
    expect(view.queryByText(message)).toBeNull();
  },
);

test("a reload mid-run draws the stored transcript at once, keeps Stop past the join deadline, and lands the answer in the same tab", async () => {
  const channel = freshChannel();
  const earlier: Message[] = [
    { id: "earlier-q", role: "user", content: "Who is Leo?" },
    {
      id: "earlier-call",
      role: "assistant",
      toolCalls: [
        {
          id: "earlier-send",
          type: "function",
          function: { name: "gmail_send_reply", arguments: "{}" },
        },
      ],
    } as Message,
    {
      id: "earlier-result",
      role: "tool",
      toolCallId: "earlier-send",
      content: "Sent.",
    } as Message,
    { id: "earlier-a", role: "assistant", content: "Leo does your contracts." },
  ];
  const question: Message = {
    id: "question",
    role: "user",
    content: "What does Ana still need from me?",
  };
  const running = heldJoin();
  reset({ stored: [...earlier, question], join: () => running.response });
  onAsk = () =>
    NativeResponse.json({ threadId: channel.threadId, runId: "live" });
  const view = render(tree(channel));
  await waitFor(() => expect(connectCalls).toBe(1));

  // The join is still replaying an earlier turn, with its call not yet answered.
  running.push([
    { type: "RUN_STARTED", threadId: channel.threadId, runId: "earlier" },
    { type: "MESSAGES_SNAPSHOT", messages: earlier.slice(0, 2) },
  ]);
  // The stored transcript stands in meanwhile: the question is on screen, and so is Stop.
  expect(
    await view.findByText("What does Ana still need from me?"),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Stop the Bot" })).toBeTruthy();

  // Past the 1.5 s join deadline: a join streaming a live turn is kept, so Stop is still there.
  await act(() => new Promise((resolve) => setTimeout(resolve, 2200)));
  expect(view.getByRole("button", { name: "Stop the Bot" })).toBeTruthy();
  expect(view.getAllByText("What does Ana still need from me?")).toHaveLength(
    1,
  );

  storedMessages = [
    ...earlier,
    question,
    {
      id: "answer",
      role: "assistant",
      content: "The 200-mug answer, by Friday.",
    },
  ];
  running.push([
    { type: "RUN_FINISHED", threadId: channel.threadId, runId: "earlier" },
    { type: "RUN_STARTED", threadId: channel.threadId, runId: "live" },
    { type: "MESSAGES_SNAPSHOT", messages: [...earlier, question] },
    ...said("answer", "The 200-mug answer, by Friday."),
    { type: "RUN_FINISHED", threadId: channel.threadId, runId: "live" },
  ]);
  running.end();
  expect(await view.findByText("The 200-mug answer, by Friday.")).toBeTruthy();
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Stop the Bot" })).toBeNull(),
  );
  expect(view.getAllByText("The 200-mug answer, by Friday.")).toHaveLength(1);
  expect(view.getAllByText("What does Ana still need from me?")).toHaveLength(
    1,
  );
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
