import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import { FINISH_MS } from "@/components/duet/mic-orb";
import {
  type ChatPresence,
  ChatPresenceProvider,
  LANDING_MS,
  orbStateFor,
  useChatOrb,
  useReportChatPresence,
  useReportFinish,
} from "@/components/shell/chat-presence";
import { ShellHeader } from "@/components/shell/header";
import { authKeys } from "@/lib/auth/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The header's orb follows Chat, as the film's phone header does: it thinks while the Bot has the
 * turn, listens while the person types, lands a finished answer, and rests everywhere else.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const AT_REST: ChatPresence = {
  chat: true,
  working: false,
  drafting: false,
  edits: 0,
  answers: 0,
  finishes: 0,
};
const on = (presence: Partial<ChatPresence>) => ({ ...AT_REST, ...presence });

describe("the orb's state for what Chat is doing", () => {
  test("rests with nothing going on", () => {
    expect(orbStateFor(AT_REST, false)).toBe("idle");
  });

  test("thinks while the Bot has the turn", () => {
    expect(orbStateFor(on({ working: true }), false)).toBe("thinking");
  });

  test("listens while there is something in the composer", () => {
    expect(orbStateFor(on({ drafting: true }), false)).toBe("listening");
  });

  test("keeps thinking when a correction is typed mid-answer", () => {
    expect(orbStateFor(on({ working: true, drafting: true }), false)).toBe(
      "thinking",
    );
  });

  test("lands an answer, and typing cuts the landing short", () => {
    expect(orbStateFor(AT_REST, true)).toBe("done");
    expect(orbStateFor(on({ drafting: true }), true)).toBe("listening");
  });

  test("rests on a screen that is not Chat, whatever was left behind", () => {
    const away = on({ chat: false, working: true, drafting: true });
    expect(orbStateFor(away, false)).toBe("idle");
    expect(orbStateFor(away, true)).toBe("idle");
  });

  test("plays a finish over anything, on any screen", () => {
    expect(orbStateFor(on({ working: true }), false, true)).toBe("finished");
    expect(orbStateFor(on({ drafting: true }), true, true)).toBe("finished");
    expect(orbStateFor(on({ chat: false }), false, true)).toBe("finished");
  });
});

type Turn = { working: boolean; failed?: boolean; enabled?: boolean };

/** The two ends of the wire: Chat reporting a turn, and the header reading the orb off it. */
function Harness({
  turn,
  chat = true,
  onReport,
}: {
  turn: Turn;
  chat?: boolean;
  onReport?: (report: ReturnType<typeof useReportChatPresence>) => void;
}) {
  return (
    <ChatPresenceProvider>
      {chat ? <Reporter onReport={onReport} turn={turn} /> : null}
      <Probe />
    </ChatPresenceProvider>
  );
}

function Reporter({
  turn,
  onReport,
}: {
  turn: Turn;
  onReport?: (report: ReturnType<typeof useReportChatPresence>) => void;
}) {
  const report = useReportChatPresence(turn.enabled ?? true, {
    working: turn.working,
    failed: turn.failed ?? false,
  });
  onReport?.(report);
  return null;
}

function Probe() {
  const { state, keystrokes } = useChatOrb();
  return <output data-keystrokes={keystrokes} data-state={state} />;
}

const orbOf = (view: { container: HTMLElement }) =>
  view.container.querySelector("output")?.getAttribute("data-state");
const keystrokesOf = (view: { container: HTMLElement }) =>
  Number(
    view.container.querySelector("output")?.getAttribute("data-keystrokes"),
  );

describe("Chat reporting to the header", () => {
  test("with nobody reporting, the orb rests", () => {
    const view = render(<Harness chat={false} turn={{ working: false }} />);
    expect(orbOf(view)).toBe("idle");
  });

  test("a turn thinks, its answer lands, and the orb rests once the landing has played", () => {
    jest.useFakeTimers();
    const view = render(<Harness turn={{ working: false }} />);
    expect(orbOf(view)).toBe("idle");

    view.rerender(<Harness turn={{ working: true }} />);
    expect(orbOf(view)).toBe("thinking");

    view.rerender(<Harness turn={{ working: false }} />);
    expect(orbOf(view)).toBe("done");

    act(() => jest.advanceTimersByTime(LANDING_MS - 1));
    expect(orbOf(view)).toBe("done");
    act(() => jest.advanceTimersByTime(1));
    expect(orbOf(view)).toBe("idle");
  });

  test("a turn that failed does not land", () => {
    const view = render(<Harness turn={{ working: true }} />);
    view.rerender(<Harness turn={{ working: false, failed: true }} />);
    expect(orbOf(view)).toBe("idle");
  });

  test("a turn somebody stopped does not land", () => {
    let report: ReturnType<typeof useReportChatPresence>;
    const keep = (r: typeof report) => {
      report = r;
    };
    const view = render(<Harness onReport={keep} turn={{ working: true }} />);
    act(() => report?.onStop());
    view.rerender(<Harness onReport={keep} turn={{ working: false }} />);
    expect(orbOf(view)).toBe("idle");

    // The next turn is a fresh one: its answer lands.
    view.rerender(<Harness onReport={keep} turn={{ working: true }} />);
    view.rerender(<Harness onReport={keep} turn={{ working: false }} />);
    expect(orbOf(view)).toBe("done");
  });

  test("leaving Chat mid-turn rests the orb rather than landing it", () => {
    const view = render(<Harness turn={{ working: true }} />);
    expect(orbOf(view)).toBe("thinking");
    view.rerender(<Harness chat={false} turn={{ working: true }} />);
    expect(orbOf(view)).toBe("idle");
  });

  test("leaving Chat during a landing rests the orb at once", () => {
    const view = render(<Harness turn={{ working: true }} />);
    view.rerender(<Harness turn={{ working: false }} />);
    expect(orbOf(view)).toBe("done");
    view.rerender(<Harness chat={false} turn={{ working: false }} />);
    expect(orbOf(view)).toBe("idle");
  });

  test("a conversation that is not Chat's reports nothing", () => {
    const view = render(<Harness turn={{ working: true, enabled: false }} />);
    expect(orbOf(view)).toBe("idle");
  });

  test("typing listens and counts each edit; an emptied box rests", () => {
    let report: ReturnType<typeof useReportChatPresence>;
    const view = render(
      <Harness
        onReport={(r) => {
          report = r;
        }}
        turn={{ working: false }}
      />,
    );
    const before = keystrokesOf(view);

    act(() => report?.onTextChange("H"));
    expect(orbOf(view)).toBe("listening");
    act(() => report?.onTextChange("Hi"));
    expect(keystrokesOf(view)).toBe(before + 2);

    // The same text again is not an edit.
    act(() => report?.onTextChange("Hi"));
    expect(keystrokesOf(view)).toBe(before + 2);

    act(() => report?.onTextChange(""));
    expect(orbOf(view)).toBe("idle");
  });

  test("a box holding only spaces is not a draft", () => {
    let report: ReturnType<typeof useReportChatPresence>;
    const view = render(
      <Harness
        onReport={(r) => {
          report = r;
        }}
        turn={{ working: false }}
      />,
    );
    act(() => report?.onTextChange("  \n"));
    expect(orbOf(view)).toBe("idle");
  });
});

describe("Chat's conversation reporting its turn", () => {
  function Chat({
    busy = false,
    restoring = false,
    stopped,
    inShell = true,
  }: {
    busy?: boolean;
    restoring?: boolean;
    stopped?: string;
    inShell?: boolean;
  }) {
    return (
      <ChatPresenceProvider>
        <ConversationView
          busy={busy}
          inShell={inShell}
          messages={[]}
          onSubmit={() => {}}
          pending={busy}
          restoring={restoring}
          {...(stopped ? { stopped } : {})}
        />
        <Probe />
      </ChatPresenceProvider>
    );
  }

  test("a turn thinks, and its answer lands", () => {
    const view = render(<Chat />);
    view.rerender(<Chat busy />);
    expect(orbOf(view)).toBe("thinking");
    view.rerender(<Chat />);
    expect(orbOf(view)).toBe("done");
  });

  test("restoring history is not a turn, so opening Chat does not land anything", () => {
    // Joining the thread is a run of its own, and the agent reports it as running while it lasts.
    const view = render(<Chat busy restoring />);
    expect(orbOf(view)).toBe("idle");
    view.rerender(<Chat />);
    expect(orbOf(view)).toBe("idle");
  });

  test("a turn that ended in a failure does not land", () => {
    const view = render(<Chat busy />);
    view.rerender(<Chat stopped="The Bot stopped responding." />);
    expect(orbOf(view)).toBe("idle");
  });

  test("a conversation outside Chat leaves the orb resting", () => {
    const view = render(<Chat busy inShell={false} />);
    expect(orbOf(view)).toBe("idle");
  });
});

describe("a finish reported to the header", () => {
  function Finisher({ keep }: { keep: (finish: () => void) => void }) {
    keep(useReportFinish());
    return null;
  }

  test("plays over a turn for as long as it lasts, then the orb is back to thinking", () => {
    jest.useFakeTimers();
    let finish = () => {};
    const view = render(
      <ChatPresenceProvider>
        <Reporter turn={{ working: true }} />
        <Finisher
          keep={(f) => {
            finish = f;
          }}
        />
        <Probe />
      </ChatPresenceProvider>,
    );
    expect(orbOf(view)).toBe("thinking");

    act(() => finish());
    expect(orbOf(view)).toBe("finished");
    act(() => jest.advanceTimersByTime(FINISH_MS - 1));
    expect(orbOf(view)).toBe("finished");
    act(() => jest.advanceTimersByTime(1));
    expect(orbOf(view)).toBe("thinking");
  });

  test("plays away from Chat too, and rests after", () => {
    jest.useFakeTimers();
    let finish = () => {};
    const view = render(
      <ChatPresenceProvider>
        <Finisher
          keep={(f) => {
            finish = f;
          }}
        />
        <Probe />
      </ChatPresenceProvider>,
    );
    expect(orbOf(view)).toBe("idle");
    act(() => finish());
    expect(orbOf(view)).toBe("finished");
    act(() => jest.advanceTimersByTime(FINISH_MS));
    expect(orbOf(view)).toBe("idle");
  });

  test("outside the shell there is nothing to report to", () => {
    let finish = () => {};
    render(
      <Finisher
        keep={(f) => {
          finish = f;
        }}
      />,
    );
    expect(() => finish()).not.toThrow();
  });
});

/** Type into the composer the way its own tests do: a text paste at the caret. */
function typeInto(container: HTMLElement, words: string) {
  const editor = container.querySelector("[contenteditable]") as HTMLElement;
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(caret);
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? words : ""),
    },
  });
}

test("the composer reports what is typed, and the empty box a send leaves", async () => {
  const seen: string[] = [];
  const view = render(
    <Composer
      compact
      onSubmit={async () => {}}
      onTextChange={(text) => seen.push(text)}
    />,
  );
  await act(async () => typeInto(view.container, "ship it"));
  expect(seen.at(-1)).toBe("ship it");

  await act(async () => {
    fireEvent.click(view.getByLabelText("Send message"));
  });
  expect(seen.at(-1)).toBe("");
});

test("the header's orb is the one Chat reports to", async () => {
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
          <ShellHeader floating menuOpen={false} onMenu={() => {}} />
          <Reporter turn={{ working: true }} />
        </ChatPresenceProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const link = await view.findByRole("link", { name: /chat$/ });
  expect(link.querySelector("[data-state]")?.getAttribute("data-state")).toBe(
    "thinking",
  );
});
