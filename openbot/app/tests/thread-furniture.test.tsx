import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import {
  ChatTranscript,
  seenMessageId,
} from "@/components/channels/chat-transcript";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import { appConfig } from "@/lib/generated/application-config";
import { settleReactWork } from "./settle-react-work";

/**
 * The thread's furniture (parity-spec 2.13): "OpenDuet is AI and can make mistakes." once under the
 * last thing in every thread, and "Seen" under the person's newest message once the Bot has it,
 * until the Bot answers in words.
 */

let realFetch: typeof fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ enabled: true, requests: [], questions: [] })) as never;
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

const noRenderers = {
  copilotkit: { renderToolCalls: [], subscribe: () => ({ unsubscribe() {} }) },
  executingToolCallIds: new Set<string>(),
} as never;

function draw(messages: Message[], busy = false) {
  return render(
    <CopilotKitContext.Provider value={noRenderers}>
      <QueryClientProvider client={new QueryClient()}>
        <ChatTranscript busy={busy} messages={messages} />
      </QueryClientProvider>
    </CopilotKitContext.Provider>,
  );
}

const asked: Message = {
  id: "u1",
  role: "user",
  content: "Anything from Priya?",
};
const searching: Message = {
  id: "a1",
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id: "t1",
      type: "function",
      function: {
        name: "mcp__google-workspace__gmail_search_messages",
        arguments: "{}",
      },
    },
  ],
};
const answer: Message = {
  id: "a2",
  role: "assistant",
  content: "Yes. She needs your VAT sign-off by Thursday.",
};

const FOOTER = `${appConfig.brand.productName} is AI and can make mistakes.`;

describe("the footer", () => {
  test("sits once under the last thing in the thread", async () => {
    const view = draw([asked, answer]);
    await view.findByText(FOOTER);
    expect(view.getAllByText(FOOTER)).toHaveLength(1);
  });

  test("is not drawn over an empty thread", () => {
    const view = draw([]);
    expect(view.queryByText(FOOTER)).toBeNull();
  });
});

describe("Seen", () => {
  const seen = (messages: Message[], busy: boolean) =>
    seenMessageId(toVisibleChatItems(messages), busy);

  test("shows under the person's newest message once the Bot has the turn", () => {
    expect(seen([asked], true)).toBe("u1");
    // The Bot has done something since, even with the turn over.
    expect(seen([asked, searching], false)).toBe("u1");
  });

  test("not before the Bot has it", () => {
    expect(seen([asked], false)).toBeNull();
  });

  test("goes when the Bot answers in words under it", () => {
    expect(seen([asked, searching, answer], false)).toBeNull();
    expect(seen([asked, answer], true)).toBeNull();
  });

  test("only on the newest of the person's messages", () => {
    const again: Message = { id: "u2", role: "user", content: "And Sam?" };
    expect(seen([asked, answer, again], true)).toBe("u2");
  });

  test("is drawn in the thread", async () => {
    const view = draw([asked], true);
    expect(await view.findByText("Seen")).toBeTruthy();
    cleanup();
    const answered = draw([asked, answer]);
    await answered.findByText(FOOTER);
    expect(answered.queryByText("Seen")).toBeNull();
  });
});
