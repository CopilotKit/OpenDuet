import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import {
  focusMessageState,
  startedTaskMessageId,
  useFocusMessage,
} from "@/lib/tasks/focus-message";
import { settleReactWork } from "./settle-react-work";

/**
 * A conversation opened from a task on Tasks shows that task's own message, not the end of a
 * conversation several tasks share. The link carries the message in the router's history state.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const scrolled: string[] = [];

/** A transcript of three messages, the one asked for well below the top. */
function Conversation() {
  const root = useRef<HTMLDivElement>(null);
  useFocusMessage(root);
  return (
    <div ref={root}>
      {["first", startedTaskMessageId("s-1"), "last"].map((id) => (
        <div
          data-message-id={id}
          key={id}
          ref={(element) => {
            if (!element) return;
            element.getBoundingClientRect = () =>
              ({ top: id === "first" ? 0 : 900 }) as DOMRect;
            element.scrollIntoView = () => {
              scrolled.push(id);
            };
          }}
        />
      ))}
    </div>
  );
}

function open() {
  const history = createMemoryHistory({ initialEntries: ["/channel/c"] });
  const router = createRouter({
    routeTree: createRootRoute({ component: Conversation }),
    history,
  });
  render(<RouterProvider router={router as never} />);
  return router;
}

test("opened with a message to focus, the conversation scrolls that message into view", async () => {
  scrolled.length = 0;
  const router = open();
  await act(() =>
    router.navigate({
      to: "/channel/c",
      state: focusMessageState(startedTaskMessageId("s-1")),
    } as never),
  );
  await waitFor(() => expect(scrolled).toContain("suggestion-s-1"));
  expect(scrolled.every((id) => id === "suggestion-s-1")).toBe(true);
});

test("opened any other way, it leaves the conversation where it opens", async () => {
  scrolled.length = 0;
  open();
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(scrolled).toEqual([]);
});

test("the person scrolling stops it, so it never fights them", async () => {
  scrolled.length = 0;
  const router = open();
  await act(() =>
    router.navigate({
      to: "/channel/c",
      state: focusMessageState(startedTaskMessageId("s-1")),
    } as never),
  );
  await waitFor(() => expect(scrolled.length).toBeGreaterThan(0));
  const frame = document.querySelector("[data-message-id]")
    ?.parentElement as HTMLElement;
  frame.dispatchEvent(new Event("wheel"));
  const after = scrolled.length;
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(scrolled.length).toBe(after);
});
