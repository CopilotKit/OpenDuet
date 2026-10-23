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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
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

/**
 * Answers the suggestions list, and records every start and dismiss the card sends. With `hold`,
 * a start or dismiss is recorded and never answered, so the card stays pending.
 */
function serve(suggestions: unknown[], { hold = false } = {}) {
  const calls: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/proactive/suggestions/")) {
      calls.push(`${init?.method ?? "GET"} ${url.replace(/^.*\/api/, "/api")}`);
      if (hold) return new Promise<never>(() => {});
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

/**
 * A finger on the card's title moved `across` to the right (negative for left) and `down`, then
 * lifted. With `turn`, it moves down first and then across, the way a scroll that wanders does.
 */
function drag(
  target: Element,
  across: number,
  { down = 0, pointerType = "touch", turn = false } = {},
) {
  const at = { pointerId: 7, pointerType, clientX: 160, clientY: 40 };
  fireEvent.pointerDown(target, at);
  if (turn)
    fireEvent.pointerMove(target, { ...at, clientY: at.clientY + down });
  const end = {
    ...at,
    clientX: at.clientX + across,
    clientY: at.clientY + down,
  };
  fireEvent.pointerMove(target, end);
  fireEvent.pointerUp(target, end);
}

/**
 * Waits longer than a card takes to fly off, so an answer a drag would send has been sent, with
 * what that sets off counted as part of the drag.
 */
const flown = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));

describe("dragging the suggestion card", () => {
  const TITLE = "Answer Rosa about the glaze substitute";

  test("the card is what the swipe blurs, crisp at rest, with its Start and Hide marks on it", async () => {
    serve([suggestion("s1", "openduet", TITLE)]);
    const view = inChat(<ChatSuggestionCard />);
    const title = await view.findByText(TITLE);
    const content = title.closest<HTMLElement>("[data-swipe-content]");
    if (!content)
      throw new Error("the card is not inside the swipe's content layer");
    // The whole card, glass and all, so a drag blurs every word of it. At rest, no filter at all.
    expect(content.querySelector("[role=region]")).toBeTruthy();
    expect(content.style.filter).toBe("none");
    const layer = content.parentElement as HTMLElement;
    for (const side of ["start", "hide"]) {
      const mark = layer.querySelector<HTMLElement>(
        `[data-swipe-mark="${side}"]`,
      );
      expect(mark?.getAttribute("aria-hidden")).toBe("true");
      expect(mark?.style.opacity).toBe("0");
    }
  });

  test("dragged right past the threshold, it starts and says so", async () => {
    const calls = serve([suggestion("s1", "openduet", TITLE)]);
    const view = inChat(<ChatSuggestionCard />);
    drag(await view.findByText(TITLE), 200);
    await flown();
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe(
        "Started. OpenDuet is on it.",
      ),
    );
    expect(calls).toEqual(["POST /api/proactive/suggestions/s1/start"]);
  });

  test("dragged left past the threshold, it hides", async () => {
    const calls = serve([suggestion("s1", "openduet", TITLE)]);
    const view = inChat(<ChatSuggestionCard />);
    drag(await view.findByText(TITLE), -200);
    await flown();
    expect(calls).toEqual(["POST /api/proactive/suggestions/s1/dismiss"]);
  });

  test("dragged right past the threshold with a mouse, it starts too", async () => {
    const calls = serve([suggestion("s1", "openduet", TITLE)]);
    const view = inChat(<ChatSuggestionCard />);
    drag(await view.findByText(TITLE), 200, { pointerType: "mouse" });
    await flown();
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe(
        "Started. OpenDuet is on it.",
      ),
    );
    expect(calls).toEqual(["POST /api/proactive/suggestions/s1/start"]);
  });

  test("a short drag either way, by finger or mouse, does neither", async () => {
    const calls = serve([suggestion("s1", "openduet", TITLE)]);
    const view = inChat(<ChatSuggestionCard />);
    const title = await view.findByText(TITLE);
    drag(title, 40);
    drag(title, -40);
    drag(title, 40, { pointerType: "mouse" });
    drag(title, -40, { pointerType: "mouse" });
    await flown();
    expect(calls).toEqual([]);
    expect(view.getByText(TITLE)).toBeTruthy();
  });

  test("a mouse click on Start that wobbles a few pixels still starts it, once", async () => {
    const calls = serve([suggestion("s1", "openduet", TITLE)]);
    const view = inChat(<ChatSuggestionCard />);
    const start = await view.findByRole("button", { name: "Start" });
    drag(start, 3, { pointerType: "mouse" });
    fireEvent.click(start);
    await flown();
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe(
        "Started. OpenDuet is on it.",
      ),
    );
    expect(calls).toEqual(["POST /api/proactive/suggestions/s1/start"]);
  });

  test("a mostly vertical drag is a scroll, even if it wanders sideways after", async () => {
    const calls = serve([suggestion("s1", "openduet", TITLE)]);
    const view = inChat(<ChatSuggestionCard />);
    const title = await view.findByText(TITLE);
    drag(title, 30, { down: 160 });
    drag(title, 200, { down: 60, turn: true });
    await flown();
    expect(calls).toEqual([]);
  });

  test("while Start is on its way, the card can't be dragged", async () => {
    const calls = serve([suggestion("s1", "openduet", TITLE)], {
      hold: true,
    });
    const view = inChat(<ChatSuggestionCard />);
    fireEvent.click(await view.findByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(
        (view.getByRole("button", { name: "Hide" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    drag(view.getByText(TITLE), -200);
    await flown();
    expect(calls).toEqual(["POST /api/proactive/suggestions/s1/start"]);
  });
});
