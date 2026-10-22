import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  ChatSuggestionCard,
  ChatSuggestionProvider,
} from "@/components/shell/chat-suggestion";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const BOT = { id: "openduet", name: "OpenDuet" };

const suggestion = (id: string, agentId: string, title: string) => ({
  id,
  agentId,
  title,
  detail: "Rosa needs an answer on the Oat Satin substitute by end of day.",
  sourceApp: "Gmail",
  sourceLink: null,
  createdAt: "2026-10-22T08:00:00Z",
});

/** Answers the suggestions list, and records every start and dismiss the card sends. */
function serve(suggestions: unknown[]) {
  const calls: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/proactive/suggestions/")) {
      calls.push(`${init?.method ?? "GET"} ${url.replace(/^.*\/api/, "/api")}`);
      return Response.json({ suggestion: suggestions[0] });
    }
    if (url.includes("/api/proactive/suggestions"))
      return Response.json({ suggestions });
    if (url.includes("/api/proactive/settings"))
      return Response.json({ settings: [] });
    return Response.json({});
  }) as unknown as typeof fetch;
  return calls;
}

function inChat(node: ReactNode, bot: typeof BOT | null = BOT) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      {bot ? (
        <ChatSuggestionProvider bot={bot}>{node}</ChatSuggestionProvider>
      ) : (
        node
      )}
    </QueryClientProvider>,
  );
}

describe("the suggestion above Chat's composer", () => {
  test("shows the Bot's newest suggestion with its source, and none of another Bot's", async () => {
    serve([
      suggestion("s2", "other-bot", "Somebody else's idea"),
      suggestion("s1", "openduet", "Answer Rosa about the glaze substitute"),
    ]);
    const view = inChat(<ChatSuggestionCard />);
    await waitFor(() =>
      expect(
        view.getByText("Answer Rosa about the glaze substitute"),
      ).toBeTruthy(),
    );
    expect(view.getByText("OpenDuet could take this on")).toBeTruthy();
    expect(view.getByText("From Gmail")).toBeTruthy();
    expect(view.queryByText("Somebody else's idea")).toBe(null);
  });

  test("Start starts it and says so; Hide dismisses it", async () => {
    const calls = serve([
      suggestion("s1", "openduet", "Answer Rosa about the glaze substitute"),
    ]);
    const view = inChat(<ChatSuggestionCard />);
    await waitFor(() => view.getByRole("button", { name: "Start" }));
    fireEvent.click(view.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe(
        "Started. OpenDuet is on it.",
      ),
    );
    expect(calls).toContain("POST /api/proactive/suggestions/s1/start");

    cleanup();
    const hidden = serve([
      suggestion("s1", "openduet", "Answer Rosa about the glaze substitute"),
    ]);
    const again = inChat(<ChatSuggestionCard />);
    await waitFor(() => again.getByRole("button", { name: "Hide" }));
    fireEvent.click(again.getByRole("button", { name: "Hide" }));
    await waitFor(() =>
      expect(hidden).toContain("POST /api/proactive/suggestions/s1/dismiss"),
    );
  });

  test("draws nothing outside Chat, or when the Bot has nothing to suggest", async () => {
    serve([suggestion("s1", "openduet", "Answer Rosa")]);
    const outside = inChat(<ChatSuggestionCard />, null);
    expect(outside.container.textContent).toBe("");

    cleanup();
    serve([]);
    const empty = inChat(<ChatSuggestionCard />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(empty.container.textContent).toBe("");
  });
});
