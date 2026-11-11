import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { CopilotKitContext } from "@copilotkit/react-core/v2/context";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  ReadAloudButton,
  ReadAloudContext,
  useReadAloud,
} from "@/components/channels/read-aloud";
import { FIRST_DAY_REQUEST } from "@/components/shell/first-day";
import { frameFirstDay } from "@/lib/channels/first-day";
import { speechText } from "@/lib/speech-text";

let spoken: SpeechSynthesisUtterance[] = [];
let canceled = 0;
let fail = false;
class Utterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  spoken = [];
  canceled = 0;
  fail = false;
});
afterAll(() => GlobalRegistrator.unregister());
function install() {
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    value: Utterance,
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      speak(utterance: SpeechSynthesisUtterance) {
        if (fail) throw new Error("Unavailable");
        spoken.push(utterance);
      },
      cancel() {
        canceled++;
      },
    },
  });
}
function Harness({
  scope = "one",
  blocked = false,
  text = "**Hello**",
  show = true,
}) {
  const playback = useReadAloud(scope, blocked);
  return (
    <ReadAloudContext.Provider value={playback}>
      {show && <ReadAloudButton id="a" text={text} />}
      <ReadAloudButton id="b" text="Second" />
      <p role="status">{playback.error}</p>
    </ReadAloudContext.Provider>
  );
}
test("speech keeps prose, labels, inline code and block boundaries, omitting code and destinations", () => {
  expect(
    speechText(
      "# Hello\n\n**World** [label](https://example.com) `value` ![diagram](x)\n\n```js\nsecret()\n```\n\n- First\n- Second",
    ),
  ).toBe("Hello\nWorld label value diagram\nFirst\nSecond");
  expect(
    speechText(
      "[ref][id]\n\n[id]: https://example.com\n\n<div>\n\nWords\n\n</div>",
    ),
  ).toBe("ref\nWords");
  expect(speechText("| A | B |\n|---|---|\n| C | D |")).toBe("A\nB\nC\nD");
  expect(speechText(" \n```\ncode\n``` ")).toBe("");
});
test("click starts, switching cancels, stale callbacks cannot stop a new message, Stop cancels", () => {
  install();
  const view = render(<Harness />);
  expect(spoken).toHaveLength(0);
  fireEvent.click(view.getAllByRole("button", { name: "Read aloud" })[0]);
  expect(spoken[0].text).toBe("Hello");
  const lateEnd = spoken[0].onend;
  fireEvent.click(view.getByRole("button", { name: "Read aloud" }));
  expect(spoken).toHaveLength(2);
  expect(canceled).toBe(1);
  act(() => lateEnd?.call(spoken[0], {} as SpeechSynthesisEvent));
  expect(view.getByRole("button", { name: "Stop reading" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Stop reading" }));
  expect(canceled).toBe(2);
});
test("completion and errors restore controls; thrown errors are announced", () => {
  install();
  const view = render(<Harness />);
  fireEvent.click(view.getAllByRole("button")[0]);
  act(() => spoken[0].onend?.({} as SpeechSynthesisEvent));
  expect(view.queryByRole("button", { name: "Stop reading" })).toBeNull();
  fireEvent.click(view.getAllByRole("button")[0]);
  act(() => spoken[1].onerror?.({} as SpeechSynthesisErrorEvent));
  expect(view.getByRole("status").textContent).toContain("Could not read");
  fail = true;
  fireEvent.click(view.getAllByRole("button")[0]);
  expect(view.getByRole("status").textContent).toContain("Could not read");
});
for (const change of [
  "scope",
  "blocked",
  "text",
  "show",
  "unmount",
  "pagehide",
] as const) {
  test(`${change} stops playback`, () => {
    install();
    const view = render(<Harness />);
    fireEvent.click(view.getAllByRole("button")[0]);
    if (change === "unmount") view.unmount();
    else if (change === "pagehide")
      act(() => window.dispatchEvent(new Event("pagehide")));
    else
      view.rerender(
        <Harness
          {...{
            [change]:
              change === "blocked"
                ? true
                : change === "show"
                  ? false
                  : "changed",
          }}
        />,
      );
    expect(canceled).toBe(1);
  });
}
test("unsupported browsers, blocked playback and empty prose have no control", () => {
  install();
  const view = render(<Harness blocked />);
  expect(view.queryByRole("button")).toBeNull();
  view.rerender(<Harness text={"```\ncode\n```"} />);
  expect(view.getAllByRole("button")).toHaveLength(1);
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: undefined,
  });
  view.rerender(<Harness />);
  expect(view.queryByRole("button")).toBeNull();
});

test("transcript offers one icon per assistant message, including first-day answers, only when idle", () => {
  install();
  const messages = [
    { id: "u", role: "user" as const, content: "Question" },
    {
      id: "a",
      role: "assistant" as const,
      content: "One paragraph.\n\nAnother paragraph.",
    },
    { id: "empty", role: "assistant" as const, content: "" },
    {
      id: "tool",
      role: "tool" as const,
      toolCallId: "call",
      content: "Tool output",
    },
  ];
  const client = new QueryClient();
  const context = {
    copilotkit: {
      renderToolCalls: [],
      subscribe: () => ({ unsubscribe() {} }),
    },
    executingToolCallIds: new Set<string>(),
  } as never;
  const draw = (busy: boolean, firstDay = false) => (
    <CopilotKitContext.Provider value={context}>
      <QueryClientProvider client={client}>
        <ChatTranscript
          busy={busy}
          messages={
            firstDay
              ? [
                  {
                    id: "first",
                    role: "user",
                    content: frameFirstDay(FIRST_DAY_REQUEST),
                  },
                  { id: "answer", role: "assistant", content: "Hello there." },
                ]
              : messages
          }
        />
      </QueryClientProvider>
    </CopilotKitContext.Provider>
  );
  const view = render(draw(false));
  const button = view.getByRole("button", { name: "Read aloud" });
  expect(button.textContent).toBe("");
  expect(button.getAttribute("title")).toBe("Read aloud");
  expect(button.tagName).toBe("BUTTON");
  expect(view.queryByRole("alert")).toBeNull();
  fail = true;
  fireEvent.click(button);
  expect(view.getByRole("alert").textContent).toContain("Could not read");
  expect(view.getByRole("alert").classList.contains("sr-only")).toBe(false);
  fail = false;
  view.rerender(draw(true));
  expect(view.queryByRole("button", { name: "Read aloud" })).toBeNull();
  view.rerender(draw(false, true));
  expect(view.getAllByRole("button", { name: "Read aloud" })).toHaveLength(1);
});

test("separate transcripts share playback ownership without canceling the new owner on unmount", () => {
  install();
  const first = render(<Harness scope="first" />);
  const second = render(<Harness scope="second" />);
  fireEvent.click(first.container.querySelector("button")!);
  const staleError = spoken[0].onerror;
  fireEvent.click(second.container.querySelector("button")!);
  expect(canceled).toBe(1);
  expect(
    first.container.querySelector('[aria-label="Stop reading"]'),
  ).toBeNull();
  act(() => staleError?.call(spoken[0], {} as SpeechSynthesisErrorEvent));
  first.unmount();
  expect(canceled).toBe(1);
  expect(
    second.container.querySelector('[aria-label="Stop reading"]'),
  ).toBeTruthy();
});

test("URL-only links are omitted and HTML line breaks preserve word boundaries", () => {
  expect(
    speechText(
      "See https://example.com/path and <https://example.com>. [Guide](https://example.com)",
    ),
  ).toBe("See and . Guide");
  expect(speechText("Hello<br>world<br />again")).toBe("Hello\nworld\nagain");
});

test("keyboard users can focus and start/stop speech with Enter and Space in Strict Mode", async () => {
  install();
  const user = userEvent.setup({ document: window.document });
  const view = render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  await user.tab();
  expect(document.activeElement).toBe(view.getAllByRole("button")[0]);
  await user.keyboard("{Enter}");
  expect(spoken).toHaveLength(1);
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Stop reading",
  );
  await user.keyboard(" ");
  expect(canceled).toBe(1);
  expect(view.queryByRole("button", { name: "Stop reading" })).toBeNull();
});

test("rapid repeated requests do not autoplay or leave a stale error in a restarted message", () => {
  install();
  const view = render(<Harness />);
  const button = view.getAllByRole("button")[0];
  fireEvent.click(button);
  const staleError = spoken[0].onerror;
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(spoken).toHaveLength(2);
  expect(canceled).toBe(1);
  act(() => staleError?.call(spoken[0], {} as SpeechSynthesisErrorEvent));
  expect(view.getByRole("status").textContent).toBe("");
  expect(view.getByRole("button", { name: "Stop reading" })).toBeTruthy();
});

test("natural speech preserves nested lists, escaping, multilingual prose and incomplete Markdown", () => {
  expect(
    speechText(
      "## Plan\n\n> *Hello* and **welcome**.\n\n1. First\n   - Nested\n2. Second\n\n\\*literal\\* café — مرحبا 世界",
    ),
  ).toBe(
    "Plan\nHello and welcome.\nFirst\nNested\nSecond\n*literal* café — مرحبا 世界",
  );
  expect(speechText("**Unfinished")).toBe("**Unfinished");
  expect(speechText("<div>hidden markup</div>")).toBe("");
  expect(speechText("before <em>emphasis</em> after")).toBe(
    "before emphasis after",
  );
  expect(speechText("   \n\n")).toBe("");
  expect(speechText("Long sentence. ".repeat(2000)).length).toBeGreaterThan(
    20000,
  );
});

test("conversation changes clear errors from the previous conversation", () => {
  install();
  const view = render(<Harness />);
  fail = true;
  fireEvent.click(view.getAllByRole("button")[0]);
  expect(view.getByRole("status").textContent).toContain("Could not read");
  view.rerender(<Harness scope="other" />);
  expect(view.getByRole("status").textContent).toBe("");
});
