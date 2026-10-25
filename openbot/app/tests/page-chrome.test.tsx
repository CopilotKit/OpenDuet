import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { frameChannelHello } from "@openbot/shared/channel-hello";
import { frameCheckIn } from "@openbot/shared/check-in";
import { frameFiring } from "@openbot/shared/routine-firing";
import {
  frameTaskBrief,
  frameTaskInput,
  frameTaskReply,
} from "@openbot/shared/task-brief";
import {
  environmentManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { Streamdown } from "streamdown";
import * as chat from "@/components/channels/channel-chat";
import { toMessageContent } from "@/components/channels/channel-chat";
import { PageShell } from "@/components/layout/page-shell";
import { useEdgeSwipeBack } from "@/components/shell/app-shell";
import { PageHeader } from "@/components/shell/header";
import {
  PageChromeProvider,
  usePageChrome,
} from "@/components/shell/page-chrome";
import { tabForPath } from "@/components/shell/tab-bar";
import {
  conversationTitle,
  firstPersonMessage,
  plainText,
} from "@/lib/channels/conversation-title";
import { frameFirstDay } from "@/lib/channels/first-day";
import { channelKeys } from "@/lib/channels/queries";
import { Route as ConversationRoute } from "@/routes/_authed/_app/channel/$channelId";
import { settleReactWork } from "./settle-react-work";

/**
 * Every screen that is not a tab is a page in one chrome (parity-spec 2.9): a back disc, the page's
 * title in a pill, and no menu disc, avatar disc or tab bar. Bots, Connections, Settings and a
 * conversation opened from the menu all draw it, and none draws a header of its own.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function Swipeable() {
  const swipe = useEdgeSwipeBack();
  return (
    <div data-testid="page" {...swipe}>
      <p>One Bot</p>
    </div>
  );
}

function Conversation() {
  usePageChrome({ title: "Ship date with Ana", column: "phone" });
  return <p>The conversation</p>;
}

function draw(
  entries: string[],
  client = new QueryClient(),
  realConversation = false,
) {
  const root = createRootRoute({
    component: () => (
      <PageChromeProvider>
        <PageHeader />
        <main>
          <Outlet />
        </main>
      </PageChromeProvider>
    ),
  });
  const authed = createRoute({ getParentRoute: () => root, id: "_authed" });
  const app = createRoute({ getParentRoute: () => authed, id: "_app" });
  const routes = [
    createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => <p>Chat</p>,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/bots",
      component: () => (
        <PageShell description="The Bots you work with." title="Bots">
          <p>Bot rows</p>
        </PageShell>
      ),
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/bots/one",
      component: () => (
        <PageShell
          backButton={{ label: "Bots", linkProps: { to: "/bots" } }}
          title="OpenDuet"
        >
          <p>One Bot</p>
        </PageShell>
      ),
    }),
    authed.addChildren([
      app.addChildren([
        createRoute({
          getParentRoute: () => app,
          path: "/channel/$channelId",
          component: realConversation
            ? ConversationRoute.options.component
            : Conversation,
        }),
      ]),
    ]),
    createRoute({
      getParentRoute: () => root,
      path: "/swipe",
      component: Swipeable,
    }),
  ];
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: entries }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

function header(view: ReturnType<typeof render>) {
  return view.container.querySelector("header") as HTMLElement;
}

test("a page from the menu gets the back disc and its title in the pill, and nothing else", async () => {
  const { view } = draw(["/bots"]);
  await view.findByText("Bot rows");
  const chrome = header(view);
  expect(within(chrome).getByRole("button", { name: "Back" })).toBeTruthy();
  expect(chrome.textContent).toContain("Bots");
  // No menu disc and no avatar disc on a page.
  expect(within(chrome).queryByRole("button", { name: "Menu" })).toBeNull();
  expect(
    within(chrome).queryByRole("link", { name: "Your settings" }),
  ).toBeNull();
  // The page names itself once, in the pill; its heading stays for screen readers.
  const heading = view.getByRole("heading", { level: 1, name: "Bots" });
  expect(heading.className).toContain("sr-only");
  // No bar of its own above the page, and no Back link inside it.
  expect(view.queryByRole("link", { name: "Bots" })).toBeNull();
});

test("a conversation opened from the menu is a page too, named by what it is about", async () => {
  const { view } = draw(["/channel/c1"]);
  await view.findByText("The conversation");
  expect(header(view).textContent).toContain("Ship date with Ana");
  // `/channel/<id>` is not the Chat tab, so the shell draws it with no tab bar.
  expect(tabForPath("/channel/c1")).toBeNull();
});

test("back goes back through history", async () => {
  const { view, router } = draw(["/"]);
  await view.findByText("Chat");
  await act(() => router.navigate({ to: "/bots" }));
  await view.findByText("Bot rows");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Back" }));
  });
  await view.findByText("Chat");
  expect(router.state.location.pathname).toBe("/");
});

test("opened cold, back goes to the list the page came from", async () => {
  const { view, router } = draw(["/bots/one"]);
  await view.findByText("One Bot");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Back" }));
  });
  await view.findByText("Bot rows");
  expect(router.state.location.pathname).toBe("/bots");
});

test("a swipe in from the left edge goes back; one from the middle does not", async () => {
  const { view, router } = draw(["/"]);
  await view.findByText("Chat");
  await act(() => router.navigate({ to: "/swipe" as never }));
  const page = await view.findByTestId("page");
  const swipe = async (fromX: number, toX: number) =>
    act(async () => {
      fireEvent.touchStart(page, {
        touches: [{ clientX: fromX, clientY: 400 }],
      });
      fireEvent.touchEnd(page, {
        changedTouches: [{ clientX: toX, clientY: 410 }],
      });
    });
  await swipe(200, 320);
  expect(router.state.location.pathname).toBe("/swipe");
  await swipe(6, 140);
  await view.findByText("Chat");
  expect(router.state.location.pathname).toBe("/");
});

test("leaving a page takes its title out of the pill", async () => {
  const { view, router } = draw(["/bots"]);
  await view.findByText("Bot rows");
  await act(() => router.navigate({ to: "/" }));
  await view.findByText("Chat");
  expect(header(view).textContent).not.toContain("Bots");
});

describe("what a conversation is called", () => {
  const taskAsk = "Draft the launch email";
  const task = frameTaskBrief(taskAsk);
  const hello = frameChannelHello({ name: "Launch", purpose: "Plan it" });
  const checkIn = frameCheckIn({
    checkedAt: "2026-10-25T12:00:00Z",
    offers: [{ id: "launch", title: "Draft the launch email", why: "Friday" }],
  });

  describe("message-origin selection contract", () => {
    // Keep the known origins closed and review new producers against this manifest.
    type Origin =
      | "person"
      | "framed first day"
      | "legacy first day with mail"
      | "legacy first day without mail"
      | "routine firing"
      | "task brief"
      | "channel hello"
      | "check-in";
    type ContractCase = {
      content: string;
      // Null preserves the selector's unresolved policy for app-only transcripts.
      eligibleWords: string | null;
    };
    const firstDayWithMail =
      "Get to know me. Look through my recent mail and this week's calendar.";
    const origins = {
      person: { content: taskAsk, eligibleWords: taskAsk },
      "framed first day": {
        content: frameFirstDay(firstDayWithMail),
        eligibleWords: null,
      },
      "legacy first day with mail": {
        content: firstDayWithMail,
        eligibleWords: null,
      },
      "legacy first day without mail": {
        content:
          "Get to know me. My Gmail and Google Calendar aren't connected yet.",
        eligibleWords: null,
      },
      "routine firing": {
        content: frameFiring("Check release notes"),
        eligibleWords: null,
      },
      // Wrapping the ordinary person's task must recover exactly the same words.
      "task brief": { content: task, eligibleWords: taskAsk },
      "channel hello": { content: hello, eligibleWords: null },
      "check-in": { content: checkIn, eligibleWords: null },
    } satisfies Record<Origin, ContractCase>;
    const otherPersonWords = "Ship date with Ana";
    const cases = Object.entries(origins).flatMap(
      ([origin, { content, eligibleWords }]) => [
        {
          origin,
          arrangement: "alone",
          contents: [content],
          expected: eligibleWords,
        },
        {
          origin,
          arrangement: "before ordinary person text",
          contents: [content, otherPersonWords],
          expected: eligibleWords ?? otherPersonWords,
        },
        {
          origin,
          arrangement: "after ordinary person text",
          contents: [otherPersonWords, content],
          expected: otherPersonWords,
        },
      ],
    );

    test.each(cases)("$origin $arrangement", ({ contents, expected }) => {
      expect(
        firstPersonMessage(
          contents.map((content, index) => ({
            id: String(index),
            role: "user",
            content,
          })),
        ),
      ).toBe(expected);
    });
  });

  test.each([
    { name: "a task alone", contents: [task], expected: taskAsk },
    {
      name: "a task before later words",
      contents: [task, "Ship date with Ana"],
      expected: taskAsk,
    },
    {
      name: "a channel hello",
      contents: [hello, "Ship date with Ana"],
      expected: "Ship date with Ana",
    },
    {
      name: "a check-in",
      contents: [checkIn, "Ship date with Ana"],
      expected: "Ship date with Ana",
    },
  ])("the person's words survive $name", ({ contents, expected }) => {
    expect(
      firstPersonMessage(
        contents.map((content, index) => ({
          id: String(index),
          role: "user",
          content,
        })),
      ),
    ).toBe(expected);
  });

  test("app frames never leak through the last-message fallback", () => {
    for (const [lastMessage, expected] of [
      [task, taskAsk],
      [hello, "New channel: Launch"],
      [checkIn, "Checked mail and calendar and found: Draft the launch email"],
      [frameFiring("Check release notes"), "Check release notes"],
    ]) {
      expect(conversationTitle({ lastMessage })).toBe(expected);
    }
  });

  test("task replies and accepted words are decoded once", () => {
    for (const content of [
      frameTaskBrief(hello),
      frameTaskReply(taskAsk, hello),
      frameTaskInput("Instructions for the model", {
        id: "reply",
        text: hello,
      }),
    ]) {
      const firstMessage = firstPersonMessage([
        { id: "task", role: "user", content },
      ]);
      expect(firstMessage).toBe(hello);
      expect(conversationTitle({ lastMessage: content })).toBe(
        plainText(hello),
      );
      expect(conversationTitle({ firstMessage })).toBe(plainText(hello));
    }
    expect(conversationTitle({ summary: hello, firstMessage: taskAsk })).toBe(
      plainText(hello),
    );
  });

  test("the first attachment caption names the conversation before later text", () => {
    const content = toMessageContent("Plan the **launch**", [
      {
        id: "photo",
        type: "image",
        status: "ready",
        source: { type: "url", value: "/api/attachments/photo" },
        metadata: { attachmentId: "photo" },
      },
    ]);
    const firstMessage = firstPersonMessage([
      { id: "caption", role: "user", content },
      { id: "later", role: "user", content: "Later message" },
    ]);
    expect(conversationTitle({ firstMessage })).toBe("Plan the launch");
  });

  test.each([
    "Get to know me. Look through my recent mail and this week's calendar.",
    "Get to know me. My Gmail and Google Calendar aren't connected yet.",
  ])("a legacy first-day request is skipped: %s", (content) => {
    expect(
      firstPersonMessage([
        { id: "first-day", role: "user", content },
        { id: "request", role: "user", content: "Ship date with Ana" },
      ]),
    ).toBe("Ship date with Ana");
  });

  test("the first-day request never becomes the fallback title", () => {
    const request =
      "Get to know me. Look through my recent mail and this week's calendar.";
    expect(conversationTitle({ lastMessage: frameFirstDay(request) })).toBe(
      "Getting to know you",
    );
    expect(
      conversationTitle({
        firstMessage: firstPersonMessage([
          { id: "first-day", role: "user", content: request },
        ]),
        lastMessage: request,
      }),
    ).toBe("Getting to know you");
    expect(
      conversationTitle({
        summary: "Your studio",
        lastMessage: frameFirstDay(request),
      }),
    ).toBe("Your studio");
  });
  test("its summary, then what was last said, never the Bot's name", () => {
    expect(
      conversationTitle({ summary: "Ship date with Ana", lastMessage: "Sure" }),
    ).toBe("Ship date with Ana");
    expect(
      conversationTitle({ summary: null, lastMessage: "Sure, Friday" }),
    ).toBe("Sure, Friday");
    expect(conversationTitle({ summary: null, lastMessage: null })).toBe(
      "New conversation",
    );
  });

  test.each([
    ["[launch plan][plan]\n\n[plan]: /launch", "launch plan"],
    ["[launch plan][]\n\n[launch plan]: /launch", "launch plan"],
    ["[launch plan]\n\n[launch plan]: /launch", "launch plan"],
    ["![chart][plan] ![plan][] ![plan]\n\n[plan]: /launch", "chart plan plan"],
    [
      "[**launch** and `plan`][ Plan  Name ]\n\n[plan name]: /launch",
      "launch and plan",
    ],
    [
      '[plan]:\n  /launch\n  "hidden destination title"\n\n[launch plan][plan]',
      "launch plan",
    ],
    ["[launch][a\\*b]\n\n[a\\*b]: /launch", "launch"],
    [
      "[missing][plan] [missing][] [missing]",
      "[missing][plan] [missing][] [missing]",
    ],
    ["\\[launch\\]\\[plan\\]\n\n[plan]: /launch", "[launch][plan]"],
    ["Use `[plan]` and [plan]\n\n[plan]: /launch", "Use [plan] and plan"],
    ["[plan]\n\n~~~md\n[plan]: /launch\n~~~", "[plan] [plan]: /launch"],
  ])("reference Markdown keeps visible content: %s", (markdown, expected) => {
    expect(plainText(markdown)).toBe(expected);
  });

  test.each(["[plan]: /launch", "[^plan]: hidden footnote body"])(
    "reference definitions alone do not become a conversation title: %s",
    (summary) => {
      expect(
        conversationTitle({
          summary,
          firstMessage: "Draft the launch plan",
        }),
      ).toBe("Draft the launch plan");
      expect(conversationTitle({ summary })).toBe("New conversation");
    },
  );

  test("never the markdown the Bot wrote", () => {
    for (const [input, expected] of [
      ["Calculate 2 * 3", "Calculate 2 * 3"],
      // Punctuation can bound emphasis, but an identifier stays literal.
      ["Discuss (_launch_)", "Discuss (launch)"],
      ["Discuss (foo__bar)", "Discuss (foo__bar)"],
      ["Use \\* literally", "Use * literally"],
      // Valid link destinations project; literal expressions keep their parentheses.
      ["Explain [x](/a)", "Explain x"],
      ["Explain f[x](a + b)", "Explain f[x](a + b)"],
      ["[![foo [bar](/url)](/image)](/target)", "[foo bar](/target)"],
      ["Keep * and ` literal", "Keep * and ` literal"],
      ["Inspect:\n````ts\nconst x = 1;\n`````", "Inspect: const x = 1;"],
      ["Inspect:\n~~~ts\nconst x = 1;\n~~~", "Inspect: const x = 1;"],
      [
        "Inspect:\n```ts\nfoo__bar * 2 [x](/literal)\n```",
        "Inspect: foo__bar * 2 [x](/literal)",
      ],
      [
        "Inspect:\n~~~ts\nfoo__bar * 2 [x](/literal)\n~~~",
        "Inspect: foo__bar * 2 [x](/literal)",
      ],
      [
        "Keep ` before\n~~~ts\n[x](/literal)\n~~~\n`after`",
        "Keep ` before [x](/literal) after",
      ],
      [
        "Inspect:\n```ts\nfoo__bar * 2 [x](/literal)",
        "Inspect: foo__bar * 2 [x](/literal)",
      ],
      [
        "*emphasis* **strong *nested*** ~~strike~~ foo*bar*baz",
        "emphasis strong nested strike foobarbaz",
      ],
    ]) {
      expect(plainText(input)).toBe(expected);
    }
    expect(
      conversationTitle({
        summary: null,
        lastMessage: "**What I think you do:** You run _Marlow_ Ceramics",
      }),
    ).toBe("What I think you do: You run Marlow Ceramics");
    expect(
      plainText("# Plan\n\n- for `Friday`, see [the doc](https://x.y)"),
    ).toBe("Plan for Friday, see the doc");
    for (const [markdown, title] of [
      ["> - Launch plan", "Launch plan"],
      ["> # Launch plan", "Launch plan"],
    ]) {
      expect(plainText(markdown)).toBe(title);
    }
    for (const url of ["", "/a(b(c))d", "/a\\)b\\(c", "</(>", '/a "("']) {
      expect(plainText(`[the doc](${url}) ![chart](${url})`)).toBe(
        "the doc chart",
      );
    }
    expect(
      plainText("**Use** `__init__` and ``a * b; `x`; [doc](a(b)c)`` _now_"),
    ).toBe("Use __init__ and a * b; `x`; [doc](a(b)c) now");
    expect(plainText("[docs](https://example.com/`) and `a*b`")).toBe(
      "docs and a*b",
    );
    expect(plainText("[Budget [2026]](/budget) ![icon [v2]](/icon)")).toBe(
      "Budget [2026] icon [v2]",
    );
    // An identifier's underscores are not emphasis.
    expect(plainText("Inspect foo__bar")).toBe("Inspect foo__bar");
    expect(plainText("Ran gmail_search_messages")).toBe(
      "Ran gmail_search_messages",
    );
  });
});

// This closed corpus tests semantic families, not permutations of Markdown punctuation.
const titleMarkdown = {
  multiplication: "Calculate 2 * 3",
  escaped: "Use \\* literally",
  quotedList: "> - Launch plan",
  quotedHeading: "> # Launch plan",
  nestedImage: "[![foo [bar](/url)](/image)](/target)",
  invalidLink: "Explain f[x](a + b)",
  underscore: "Discuss (_launch_)",
  backtickFence: "Inspect:\n```ts\nconst x = 1;\n```",
  tildeFence: "Inspect:\n~~~ts\nconst x = 1;\n~~~",
  unmatched: "Use ` literally.",
  inlineCode: "Then `code`",
  paragraphs: "Use ` literally.\n\nThen `code`",
  quotedFence: "> ```ts\n> const x = 1;\n> ```",
  bareFence: "```ts\nconst x = 1;\n```",
  atx: "## Launch plan ##",
  setext: "Launch plan\n===",
  referenceFull: "[launch plan][plan]\n\n[plan]: /launch",
  referenceCollapsed: "[launch plan][]\n\n[launch plan]: /launch",
  referenceShortcut: "[launch plan]\n\n[launch plan]: /launch",
  referenceLabel: "launch plan",
  definition: "[plan]: /launch",
  flanking: 'Explain a*"b"*c',
  strong: "**What I think you do:** You run _Marlow_ Ceramics",
  literalCode: "**Use** `__init__` and ``a * b; `x`; [doc](a(b)c)`` _now_",
  link: "[the doc](/a(b(c))d)",
  image: "![chart](/chart)",
  identifiers: "Inspect foo__bar and gmail_search_messages",
  nestedEmphasis: "*emphasis* **strong *nested*** ~~strike~~ foo*bar*baz",
  blockParagraphs: "> - Launch plan\n\nDiscuss (_launch_)",
} as const;
type TitleWitness = keyof typeof titleMarkdown;
type MarkdownFamily =
  | "literal/escaped text"
  | "paragraph boundaries"
  | "blockquotes"
  | "lists"
  | "headings"
  | "inline code"
  | "fenced code"
  | "emphasis"
  | "strong emphasis"
  | "inline links"
  | "images"
  | "reference links"
  | "reference definitions";
const titleCoverage = {
  "literal/escaped text": [
    "multiplication",
    "escaped",
    "invalidLink",
    "flanking",
    "identifiers",
  ],
  "paragraph boundaries": [
    "unmatched",
    "inlineCode",
    "paragraphs",
    "blockParagraphs",
  ],
  blockquotes: ["quotedList", "quotedHeading", "quotedFence"],
  lists: ["quotedList"],
  headings: ["quotedHeading", "atx", "setext"],
  "inline code": ["inlineCode", "literalCode"],
  "fenced code": ["backtickFence", "tildeFence", "quotedFence", "bareFence"],
  emphasis: ["underscore", "nestedEmphasis"],
  "strong emphasis": ["strong", "nestedEmphasis", "literalCode"],
  "inline links": ["link", "nestedImage"],
  images: ["image", "nestedImage"],
  "reference links": [
    "referenceFull",
    "referenceCollapsed",
    "referenceShortcut",
    "referenceLabel",
  ],
  "reference definitions": [
    "definition",
    "referenceFull",
    "referenceCollapsed",
    "referenceShortcut",
  ],
} satisfies Record<MarkdownFamily, readonly [TitleWitness, ...TitleWitness[]]>;
const titleFindingWitnesses = {
  "P3-T12": ["paragraphs"],
  "P3-T13": ["quotedFence"],
  "P3-T14": ["atx", "setext"],
  "P3-T15": ["referenceFull", "referenceCollapsed", "referenceShortcut"],
  "P3-T16": ["flanking"],
} satisfies Record<
  `P3-T${12 | 13 | 14 | 15 | 16}`,
  readonly [TitleWitness, ...TitleWitness[]]
>;
const normalizeTitleText = (text: string) => text.replace(/\s+/g, " ").trim();

/** Actual renderer output: static document semantics, without streaming completion repair. */
async function renderedTitleText(markdown: string): Promise<string> {
  const view = render(
    <Streamdown
      mode="static"
      parseIncompleteMarkdown={false}
      controls={false}
      lineNumbers={false}
    >
      {markdown}
    </Streamdown>,
  );
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof Element)) return "";
    // Only content contributes: language labels, action labels and SVGs are renderer chrome.
    if (
      node.matches(
        'button:not([data-streamdown="link"]), [role="button"], svg, script, style, [data-streamdown="image-fallback"], [data-streamdown="code-block-header"], [data-streamdown="code-block-actions"]',
      )
    )
      return "";
    if (node.tagName === "IMG") return node.getAttribute("alt") ?? "";
    if (node.matches('[data-streamdown="code-block-body"]')) {
      const code = node.querySelector("code");
      if (!code) throw new Error("Streamdown code content is missing");
      // Streamdown lays code lines out as block spans instead of literal newline nodes.
      return ` ${Array.from(code.children, (line) => line.textContent ?? "").join("\n")} `;
    }
    const text = Array.from(node.childNodes, read).join("");
    return /^(P|H[1-6]|LI|BLOCKQUOTE|PRE|BR)$/.test(node.tagName)
      ? ` ${text} `
      : text;
  };
  try {
    // Flush the actual lazy code renderer and image effects before reading or unmounting.
    await act(async () => {});
    return normalizeTitleText(read(view.container));
  } finally {
    await act(async () => view.unmount());
  }
}

describe("title Markdown semantic contract", () => {
  test("the bounded manifest covers every family and reported finding", () => {
    expect(Object.keys(titleMarkdown).length).toBeLessThanOrEqual(32);
    expect(Object.keys(titleCoverage)).toHaveLength(13);
    expect(Object.keys(titleFindingWitnesses)).toHaveLength(5);
    const covered = new Set(Object.values(titleCoverage).flat());
    expect(Object.keys(titleMarkdown).sort()).toEqual([...covered].sort());
    for (const witnesses of [
      ...Object.values(titleCoverage),
      ...Object.values(titleFindingWitnesses),
    ]) {
      expect(witnesses.length).toBeGreaterThan(0);
      for (const witness of witnesses) {
        expect(covered.has(witness)).toBe(true);
        expect(titleMarkdown[witness].length).toBeLessThan(120);
      }
    }
  });
  test.each(Object.entries(titleMarkdown))(
    "renderer-visible words survive %s",
    async (_name, markdown) => {
      expect(normalizeTitleText(plainText(markdown))).toBe(
        await renderedTitleText(markdown),
      );
    },
  );
  test.each([
    ["paragraphs", "unmatched", "inlineCode"],
    ["blockParagraphs", "quotedList", "underscore"],
  ] satisfies [TitleWitness, TitleWitness, TitleWitness][])(
    "independent paragraphs preserve boundaries in %s",
    async (joined, first, second) => {
      const expected = normalizeTitleText(
        `${await renderedTitleText(titleMarkdown[first])} ${await renderedTitleText(titleMarkdown[second])}`,
      );
      expect(`${titleMarkdown[first]}\n\n${titleMarkdown[second]}`).toBe(
        titleMarkdown[joined],
      );
      expect(await renderedTitleText(titleMarkdown[joined])).toBe(expected);
      expect(plainText(titleMarkdown[joined])).toBe(expected);
    },
  );
  test.each([
    ["quotedFence", "bareFence"],
    ["referenceFull", "referenceLabel"],
    ["referenceCollapsed", "referenceLabel"],
    ["referenceShortcut", "referenceLabel"],
  ] satisfies [TitleWitness, TitleWitness][])(
    "content equivalence excludes metadata in %s",
    async (wrapped, content) => {
      const expected = await renderedTitleText(titleMarkdown[content]);
      expect(await renderedTitleText(titleMarkdown[wrapped])).toBe(expected);
      expect(plainText(titleMarkdown[wrapped])).toBe(expected);
    },
  );
});

describe("opening a conversation by its link", () => {
  type Loader = (input: {
    context: { queryClient: QueryClient };
    params: { channelId: string };
  }) => Promise<{ gone: boolean }>;
  const load = ConversationRoute.options.loader as unknown as Loader;
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function seeded(agentIds: string[], said = false) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(channelKeys.detail("c1"), {
      id: "c1",
      name: "OpenDuet",
      agentIds,
      threadId: "t",
      active: true,
      lastMessageAt: said ? "2026-10-01" : null,
    });
    return queryClient;
  }

  test.each([503, 200])(
    "a mounted title recovers after history returns %i and resets on navigation",
    async (status) => {
      const client = seeded(["openduet"], true);
      client.setQueryDefaults([], { retry: false, staleTime: Infinity });
      client.setQueryData(channelKeys.list(), { pages: [], pageParams: [] });
      const loader = spyOn(ConversationRoute, "useLoaderData").mockReturnValue({
        gone: false,
      });
      const transcript = spyOn(chat, "ChannelChat").mockReturnValue(<div />);
      const wasServer = environmentManager.isServer();
      environmentManager.setIsServer(() => false);
      let available = false;
      const messages = [{ id: "first", role: "user", content: "Launch plan" }];
      const reply = async () =>
        Response.json(
          { messages: available ? messages : [] },
          { status: available ? 200 : status },
        );
      globalThis.fetch = Object.assign(reply, {
        preconnect: realFetch.preconnect,
      });
      try {
        const { view, router } = draw(["/channel/c1"], client, true);
        await view.findByRole("heading", { name: "Conversation" });
        const title = within(header(view));
        available = true;
        await title.findByText("Launch plan", {}, { timeout: 7_000 });
        client.setQueryData(channelKeys.detail("c2"), {
          id: "c2",
          name: "OpenDuet",
          agentIds: ["openduet"],
          threadId: "t2",
          active: true,
          lastMessageAt: "2026-10-01",
        });
        available = false;
        await act(() =>
          router.navigate({
            to: "/channel/$channelId",
            params: { channelId: "c2" },
          }),
        );
        await view.findByRole("heading", { name: "Conversation" });
        expect(header(view).textContent).not.toContain("Launch plan");
        available = true;
        messages[0].content = "Budget for next quarter";
        await act(() =>
          client.invalidateQueries({
            queryKey: ["channels", "first-message", "t2"],
          }),
        );
        await title.findByText("Budget for next quarter");
        messages[0].content = "Later budget update";
        await act(() =>
          client.invalidateQueries({
            queryKey: ["channels", "first-message", "t2"],
          }),
        );
        expect(header(view).textContent).toContain("Budget for next quarter");
        expect(header(view).textContent).not.toContain("Later budget update");
      } finally {
        cleanup();
        client.clear();
        loader.mockRestore();
        transcript.mockRestore();
        environmentManager.setIsServer(() => wasServer);
      }
    },
    10_000,
  );

  test("a group goes to its shared transcript before this page draws", async () => {
    let thrown: unknown;
    try {
      await load({
        context: { queryClient: seeded(["a", "b"]) },
        params: { channelId: "c1" },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      options: { to: "/group/$channelId", params: { channelId: "c1" } },
    });
  });

  test("a conversation with one Bot draws here", async () => {
    expect(
      await load({
        context: { queryClient: seeded(["openduet"]) },
        params: { channelId: "c1" },
      }),
    ).toEqual({ gone: false });
  });

  test("a conversation that no longer exists is told apart from one that failed to load", async () => {
    const answering = (status: number) =>
      (async () =>
        Response.json(
          { error: "Couldn't find that conversation." },
          { status },
        )) as never;
    globalThis.fetch = answering(404);
    expect(
      await load({
        context: {
          queryClient: new QueryClient({
            defaultOptions: { queries: { retry: false } },
          }),
        },
        params: { channelId: "gone" },
      }),
    ).toEqual({ gone: true });
    globalThis.fetch = answering(500);
    expect(
      await load({
        context: {
          queryClient: new QueryClient({
            defaultOptions: { queries: { retry: false } },
          }),
        },
        params: { channelId: "broken" },
      }),
    ).toEqual({ gone: false });
  });
});
