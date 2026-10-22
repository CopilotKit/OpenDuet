import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  ChatPresenceProvider,
  stepFor,
  THINKING,
  useChatOrb,
  useChatStep,
  useReportChatPresence,
} from "@/components/shell/chat-presence";
import { ShellHeader } from "@/components/shell/header";
import { authKeys } from "@/lib/auth/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The pill under the header's orb says what the Bot is doing right now: the step it is running, or
 * that it is thinking, and nothing once the turn is over or Chat is gone.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const asked = (id: string, content: string): Message => ({
  id,
  role: "user",
  content,
});

/** The Bot calling a tool, answered when `result` is given. */
function called(id: string, name: string, result?: string): Message[] {
  const call: Message = {
    id: `${id}-call`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify({ query: "Q3 budget" }) },
      },
    ],
  };
  return result === undefined
    ? [call]
    : [
        call,
        { id: `${id}-result`, role: "tool", toolCallId: id, content: result },
      ];
}

const SEARCH = "mcp__exa__web_search_exa";
const FETCH = "mcp__exa__web_fetch_exa";

describe("the step the pill names", () => {
  test("a step still running is named as its line names it", () => {
    const messages = [asked("u1", "What changed?"), ...called("s", SEARCH)];
    expect(stepFor(messages, true)).toBe("Search the web…");
  });

  test("the morning brief is named in the words its own line uses", () => {
    const messages = [
      asked("u1", "What needs me this morning?"),
      ...called("b", "morning_brief"),
    ];
    expect(stepFor(messages, true)).toBe("Reading your mail and calendar…");
  });

  test("the newest running step wins over an earlier one", () => {
    const messages = [
      asked("u1", "What changed?"),
      ...called("s", SEARCH),
      ...called("f", FETCH),
    ];
    expect(stepFor(messages, true)).toBe("Read web pages…");
  });

  test("a step that has its result is not running", () => {
    const messages = [
      asked("u1", "What changed?"),
      ...called("s", SEARCH),
      ...called("f", FETCH, '"Page text"'),
    ];
    expect(stepFor(messages, true)).toBe("Search the web…");
  });

  test("working with no step running is thinking", () => {
    expect(stepFor([asked("u1", "Hi")], true)).toBe(THINKING);
    const answered = [
      asked("u1", "What changed?"),
      ...called("s", SEARCH, '"Results"'),
    ];
    expect(stepFor(answered, true)).toBe(THINKING);
  });

  test("a call an earlier turn left unanswered is not this turn's step", () => {
    const messages = [
      asked("u1", "What changed?"),
      ...called("s", SEARCH),
      asked("u2", "Never mind, what's on today?"),
    ];
    expect(stepFor(messages, true)).toBe(THINKING);
  });

  test("with the turn over there is nothing to say, running step or not", () => {
    const messages = [asked("u1", "What changed?"), ...called("s", SEARCH)];
    expect(stepFor(messages, false)).toBeNull();
    expect(stepFor([], false)).toBeNull();
  });
});

/**
 * The header over whatever `show` puts under it, in one router for the whole test, so swapping
 * Chat for another screen changes that and nothing else.
 */
function renderHeader(first: ReactNode, floating = true) {
  let show: (screen: ReactNode) => void = () => {};
  function Screen() {
    const [screen, setScreen] = useState(first);
    show = setScreen;
    return screen;
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(authKeys.currentUser(), {
    id: "u",
    email: "maya@example.com",
    name: "Maya",
    role: "user",
    onboarding: null,
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <ChatPresenceProvider>
          <ShellHeader floating={floating} menuOpen={false} onMenu={() => {}} />
          <Screen />
        </ChatPresenceProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // The transcript draws a lone tool call through CopilotKit, so Chat needs its provider.
  const view = render(
    <QueryClientProvider client={client}>
      <CopilotKitProvider>
        <RouterProvider router={router as never} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  return {
    view,
    show: (screen: ReactNode) => act(() => show(screen)),
    pill: () =>
      view.container.querySelector("[aria-live='polite'] [data-shown]"),
  };
}

/** Chat's conversation, drawn under the header as the Chat tab draws it. */
function Chat({
  busy = false,
  messages,
}: {
  busy?: boolean;
  messages: Message[];
}) {
  return (
    <ConversationView
      busy={busy}
      inShell
      messages={messages}
      onSubmit={() => {}}
      pending={busy}
    />
  );
}

const RUNNING = [asked("u1", "What changed?"), ...called("s", SEARCH)];
const ANSWERED = [
  asked("u1", "What changed?"),
  ...called("s", SEARCH, '"Results"'),
];

describe("the pill under the orb", () => {
  test("names the running step while the Bot works, and fades out when the turn ends", async () => {
    const { view, show, pill } = renderHeader(<Chat busy messages={RUNNING} />);
    await view.findByRole("link", { name: /chat$/ });
    expect(pill()?.textContent).toBe("Search the web…");
    expect(pill()?.getAttribute("data-shown")).toBe("true");
    expect(pill()?.getAttribute("aria-hidden")).toBeNull();

    show(<Chat busy messages={ANSWERED} />);
    expect(pill()?.textContent).toBe(THINKING);

    // It keeps its last words while it fades, hidden from screen readers.
    show(<Chat messages={ANSWERED} />);
    expect(pill()?.getAttribute("data-shown")).toBe("false");
    expect(pill()?.getAttribute("aria-hidden")).toBe("true");
    expect(pill()?.textContent).toBe(THINKING);
  });

  test("rests hidden with nobody reporting, inside a live region that is already there", async () => {
    const { view, pill } = renderHeader(null);
    await view.findByRole("link", { name: /chat$/ });
    expect(view.container.querySelector("[aria-live='polite']")).not.toBeNull();
    expect(pill()?.getAttribute("data-shown")).toBe("false");
    expect(pill()?.textContent).toBe("");
  });

  test("is gone with Chat, mid-turn included", async () => {
    const { view, show, pill } = renderHeader(<Chat busy messages={RUNNING} />);
    await view.findByRole("link", { name: /chat$/ });
    expect(pill()?.getAttribute("data-shown")).toBe("true");

    show(null);
    expect(pill()?.getAttribute("data-shown")).toBe("false");
  });

  test("is only on the floating header", async () => {
    const { view } = renderHeader(<Chat busy messages={RUNNING} />, false);
    await view.findByRole("link", { name: /chat$/ });
    expect(view.container.querySelector("[aria-live='polite']")).toBeNull();
  });
});

test("a keystroke does not reach the pill, and a new step does not reach the orb", () => {
  let report: ReturnType<typeof useReportChatPresence>;
  let nextStep: (step: string) => void = () => {};
  const renders = { step: 0, orb: 0 };

  function Reporter() {
    const [step, setStep] = useState<string | null>(THINKING);
    nextStep = setStep;
    report = useReportChatPresence(true, {
      working: true,
      failed: false,
      step,
    });
    return null;
  }
  function StepProbe() {
    renders.step++;
    return <output data-probe="step">{useChatStep()}</output>;
  }
  function OrbProbe() {
    renders.orb++;
    return <output data-probe="orb">{useChatOrb().state}</output>;
  }

  const view = render(
    <ChatPresenceProvider>
      <Reporter />
      <StepProbe />
      <OrbProbe />
    </ChatPresenceProvider>,
  );
  const probe = (name: string) =>
    view.container.querySelector(`[data-probe='${name}']`)?.textContent;
  expect(probe("step")).toBe(THINKING);

  const atStart = { ...renders };
  act(() => report?.onTextChange("A correction"));
  expect(renders.orb).toBeGreaterThan(atStart.orb);
  expect(renders.step).toBe(atStart.step);

  const afterTyping = { ...renders };
  act(() => nextStep("Search the web…"));
  expect(probe("step")).toBe("Search the web…");
  expect(renders.step).toBeGreaterThan(afterTyping.step);
  expect(renders.orb).toBe(afterTyping.orb);
});
