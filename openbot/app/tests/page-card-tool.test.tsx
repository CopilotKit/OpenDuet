import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { ConversationView } from "@/components/channels/conversation-view";
import { PageCardTool } from "@/lib/copilot/page-card-tool";
import { settleReactWork } from "./settle-react-work";

/**
 * The card as a person meets it in Chat: drawn by the real renderer, in the real transcript, under
 * the Bot's line about what it made.
 */

const originalFetch = globalThis.fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "Not found" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const saved = {
  id: "prep-1",
  botId: "openduet",
  kind: "page",
  title: "Hearth & Co studio visit",
  summary: null,
  createdAt: "2026-10-22T12:52:00.000Z",
  updatedAt: "2026-10-22T12:52:00.000Z",
  slideCount: 0,
  preview: { blocks: [{ type: "text", text: "Bring the glaze samples." }] },
};

/** The Bot makes the page first and says its line after, as models usually do. */
function made(result: string): Message[] {
  return [
    { id: "u1", role: "user", content: "Prep me for the studio visit." },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "make_page",
            arguments: JSON.stringify({ kind: "page", title: saved.title }),
          },
        },
      ],
    },
    { id: "t1", role: "tool", toolCallId: "call-1", content: result },
    {
      id: "a2",
      role: "assistant",
      content: "I put the visit on one page. It's a 2-minute read.",
    },
  ];
}

const queries = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Chat({ messages }: { messages: Message[] }) {
  return (
    <QueryClientProvider client={queries}>
      <CopilotKitProvider>
        <PageCardTool />
        <ConversationView messages={messages} onSubmit={() => {}} />
      </CopilotKitProvider>
    </QueryClientProvider>
  );
}

test("the card is drawn under the Bot's line about the page, and links to it", async () => {
  const view = render(<Chat messages={made(JSON.stringify(saved))} />);
  const card = await view.findByRole("link", {
    name: /Hearth & Co studio visit/,
  });
  expect(card.getAttribute("href")).toBe("/pages/prep-1");
  expect(card.textContent).toContain("Updated");
  const line = view.getByText(/It's a 2-minute read/);
  // The line comes first in the document, the card under it.
  expect(
    line.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("a refused call draws no card", async () => {
  const view = render(
    <Chat
      messages={made(
        "Refused. make_page could not save this. blocks: Required. Fix it and call make_page again.",
      )}
    />,
  );
  await view.findByText(/It's a 2-minute read/);
  expect(view.queryByRole("link", { name: /Hearth & Co/ })).toBeNull();
});
