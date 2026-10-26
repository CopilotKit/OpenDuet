import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ConversationSendContext } from "@/components/channels/conversation-send";
import { ReplyHoldProvider } from "@/components/channels/reply-hold";
import { BuildInProvider, useArrivedLive } from "@/components/duet/build-in";
import {
  type BriefItem,
  MorningBriefCard,
} from "@/components/duet/morning-brief-card";
import { ReplyChips } from "@/lib/copilot/reply-chips-tool";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/*
 * A generated card builds in a piece at a time when it arrives live, and is drawn whole when it is
 * read back from history (components/duet/build-in.tsx). Eli, on the live demo: "It feels very fast
 * and hard to follow."
 */

const rows = (prefix: string, count: number): BriefItem[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`,
    title: `${prefix} ${index}`,
    why: `Why ${index}`,
  }));

const orders = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-build-in]"), (node) =>
    Number(node.getAttribute("data-build-in")),
  );

function Brief({ live }: { live: boolean }) {
  return (
    <BuildInProvider value={live}>
      <MorningBriefCard
        canWait={rows("Wait", 1)}
        date="Monday, October 26"
        greeting="Morning."
        needsYou={rows("Needs", 8)}
        today={rows("Today", 2)}
      />
    </BuildInProvider>
  );
}

describe("a brief arriving live", () => {
  test("builds in top to bottom: greeting, then each section's label and the rows it shows", () => {
    const view = render(<Brief live />);
    // The card and its greeting (0, 0), Needs you's label (1), its five rows and the four rules
    // between them (2–6), Show 3 more (7), Can wait (8, 9), Today (10, 11, 12) with its rule (12).
    expect(orders(view.container)).toEqual([
      0, 0, 1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 12,
    ]);
  });

  test("rows that Show more reveals later are drawn as they are", () => {
    const view = render(<Brief live />);
    fireEvent.click(
      view.getByRole("button", { name: "Show 3 more in Needs you" }),
    );
    // The nearest piece above a revealed row is the card itself, not a row of its own.
    const pieceOf = (text: string) =>
      view
        .getByText(text)
        .closest("[data-build-in]")
        ?.getAttribute("data-build-in");
    expect(pieceOf("Needs 7")).toBe("0");
    expect(pieceOf("Needs 4")).toBe("6");
  });
});

test("a brief read back from history is drawn whole", () => {
  const view = render(<Brief live={false} />);
  expect(orders(view.container)).toEqual([]);
  expect(view.getByText("Needs 4")).toBeTruthy();
});

describe("arriving live", () => {
  function Probe({ running }: { running: boolean }) {
    return <span>{useArrivedLive(running) ? "live" : "whole"}</span>;
  }

  test("a card that was still running when first drawn stays live once it completes", () => {
    const view = render(<Probe running />);
    view.rerender(<Probe running={false} />);
    expect(view.getByText("live")).toBeTruthy();
  });

  test("a card first drawn complete, outside a turn being written, is from history", () => {
    const view = render(<Probe running={false} />);
    expect(view.getByText("whole")).toBeTruthy();
  });

  test("a card first drawn complete while its turn is still being written arrived live", () => {
    const view = render(
      <ReplyHoldProvider value>
        <Probe running={false} />
      </ReplyHoldProvider>,
    );
    expect(view.getByText("live")).toBeTruthy();
  });
});

test("reply chips offered while the turn is written arrive one after another", () => {
  const conversation = { send: () => true, isLatestTurn: () => true };
  const view = render(
    <ConversationSendContext.Provider value={conversation}>
      <ReplyHoldProvider value>
        <ReplyChips replies={["Sounds right", "Something's off", "Later"]} />
      </ReplyHoldProvider>
    </ConversationSendContext.Provider>,
  );
  expect(orders(view.container)).toEqual([0, 1, 2]);
  expect(view.getAllByRole("button")).toHaveLength(3);
});
