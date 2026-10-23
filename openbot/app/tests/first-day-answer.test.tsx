import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  ChatTranscript,
  FIRST_DAY_REPLIES,
  firstDayParts,
} from "@/components/channels/chat-transcript";
import { FIRST_DAY_REQUEST_WITHOUT_MAIL } from "@/components/channels/first-day-greeting";
import { ConversationSendContext } from "@/components/channels/conversation-send";
import { FIRST_DAY_REQUEST } from "@/components/shell/first-day";
import { frameFirstDay } from "@/lib/channels/first-day";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The first day's answer in S11's shape: one bubble per part, and "Sounds right" and "Something's
 * off" under it, drawn by the app once the run has ended, until the person says something.
 */

const originalFetch = globalThis.fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // The greeting reads the account for a first name; nobody is signed in here.
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "Not signed in" }, { status: 401 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  // The greeting caches the signed-in person in the app's one query client; leave it empty.
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const WHO =
  "You run Marlow Ceramics, a small studio at 41 Alder St, with Sam on packing and Leo on glazes.";
const HELP = [
  "How I'll help:",
  "",
  "- Chase Hearth & Co's 200-mug order before Friday",
  "- Draft your reply to Rosa about the glaze substitute",
  "- Keep the Makers Market booth on your calendar",
].join("\n");
const CLOSE = "If any of these sound off, just let me know and I'll learn.";
const ANSWER = [WHO, HELP, CLOSE].join("\n\n");

const opened: Message = {
  id: "first-day",
  role: "user",
  content: frameFirstDay(FIRST_DAY_REQUEST),
};
const answered: Message = { id: "answer", role: "assistant", content: ANSWER };

function draw(messages: Message[], busy = false) {
  const sent: string[] = [];
  const view = render(
    <ConversationSendContext.Provider
      value={{
        send: (text) => {
          sent.push(text);
          return true;
        },
        isLatestTurn: () => true,
      }}
    >
      <ChatTranscript busy={busy} messages={messages} />
    </ConversationSendContext.Provider>,
  );
  return Object.assign(view, { sent });
}

const bubbleTexts = (view: ReturnType<typeof render>) =>
  Array.from(view.container.querySelectorAll('[data-slot="bubble"]')).map(
    (bubble) => bubble.textContent?.trim() ?? "",
  );

test("the answer's parts are cut at blank lines, a heading kept with its list", () => {
  expect(firstDayParts(ANSWER)).toEqual([WHO, HELP, CLOSE]);
  // Bullets with no line between them, or a blank line inside the list, stay one part.
  expect(
    firstDayParts(`${WHO}\n\nHow I'll help:\n- a\n- b\n\n- c\n\n${CLOSE}`),
  ).toEqual([WHO, "How I'll help:\n- a\n- b\n\n- c", CLOSE]);
  // An answer with no blank lines is one part, as written.
  expect(firstDayParts(WHO)).toEqual([WHO]);
});

test("the first day's answer is drawn one bubble per part, after the welcome and the plan", async () => {
  const view = draw([opened, answered]);
  await settleReactWork();

  const bubbles = bubbleTexts(view);
  // Welcome, plan, then who you are, how I'll help and the close.
  expect(bubbles).toHaveLength(5);
  expect(bubbles[2]).toBe(WHO);
  expect(bubbles[3]).toContain("How I'll help:");
  expect(bubbles[3]).toContain(
    "Chase Hearth & Co's 200-mug order before Friday",
  );
  expect(bubbles[4]).toBe(CLOSE);
});

test("once the run has ended, the app offers Sounds right and Something's off, and a tap sends it", async () => {
  const view = draw([opened, answered]);
  await settleReactWork();

  const chips = view.getByRole("group", { name: "Suggested replies" });
  expect(
    Array.from(chips.querySelectorAll("button")).map((b) => b.textContent),
  ).toEqual([...FIRST_DAY_REPLIES]);
  // Under the answer: the last thing in the transcript.
  const close = view.getByText(CLOSE);
  expect(
    close.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "Something's off" }));
  expect(view.sent).toEqual(["Something's off"]);
});

test("no replies while the run is still going", async () => {
  const view = draw([opened, answered], true);
  await settleReactWork();
  expect(view.queryByRole("group", { name: "Suggested replies" })).toBeNull();
});

test("no replies once the person has said something", async () => {
  const view = draw([
    opened,
    answered,
    { id: "reply", role: "user", content: "Sounds right" },
    { id: "next", role: "assistant", content: "Good. I'll start there." },
  ]);
  await settleReactWork();
  expect(view.queryByRole("group", { name: "Suggested replies" })).toBeNull();
  // And an answer after the first day's is an ordinary bubble, not split.
  expect(bubbleTexts(view).at(-1)).toBe("Good. I'll start there.");
});

test("no replies on a first day without mail, which says no who-you-are to agree with", async () => {
  const view = draw([
    {
      id: "first-day",
      role: "user",
      content: frameFirstDay(FIRST_DAY_REQUEST_WITHOUT_MAIL, { mail: false }),
    },
    {
      id: "answer",
      role: "assistant",
      content: "Right now I can do a few things.",
    },
  ]);
  await settleReactWork();
  expect(view.queryByRole("group", { name: "Suggested replies" })).toBeNull();
});

test("no replies before there is an answer to reply to", async () => {
  const view = draw([opened]);
  await settleReactWork();
  expect(view.queryByRole("group", { name: "Suggested replies" })).toBeNull();
});
