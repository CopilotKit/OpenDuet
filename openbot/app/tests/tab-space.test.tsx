import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { useTabSpace } from "@/components/shell/app-shell";
import { settleReactWork } from "./settle-react-work";

/**
 * The space kept for the tab bar is the bar's real height, so at a large text size the bar does not
 * cover Chat's composer. At a 32px root the bar is 128px tall, not 64.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

let barHeight = 64;
let resized: (() => void) | null = null;

function Column() {
  const column = useRef<HTMLDivElement>(null);
  useTabSpace(column);
  return (
    <div ref={column}>
      <nav
        aria-label="Main"
        ref={(nav) => {
          if (nav)
            nav.getBoundingClientRect = () =>
              ({ height: barHeight }) as DOMRect;
        }}
      />
    </div>
  );
}

test("the inset is the bar's height plus its 22px gap, and follows it as text grows", () => {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resized = callback;
    }
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  try {
    barHeight = 64;
    const view = render(<Column />);
    const host = view.container.firstElementChild as HTMLElement;
    expect(host.style.getPropertyValue("--duet-tab-space")).toBe("86px");
    // The person's text size doubles: the bar is 128px tall.
    barHeight = 128;
    act(() => resized?.());
    expect(host.style.getPropertyValue("--duet-tab-space")).toBe("150px");
  } finally {
    globalThis.ResizeObserver = original;
  }
});
