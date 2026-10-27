import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Dialog } from "@base-ui/react/dialog";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  SHEET_EXIT_GRACE_MS,
  useSheetPresence,
} from "@/hooks/use-sheet-presence";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(() => cleanup());
afterAll(() => {
  GlobalRegistrator.unregister();
});

/** A sheet as the app's are drawn: its parent mounts it to open it, and is told when it has gone. */
function Sheet({ onClose }: { onClose: () => void }) {
  const presence = useSheetPresence();
  return (
    <Dialog.Root
      onOpenChange={(next) => {
        if (!next) presence.close(onClose);
      }}
      onOpenChangeComplete={presence.onOpenChangeComplete}
      open={presence.open}
    >
      <Dialog.Portal>
        <Dialog.Popup data-testid="sheet">
          <Dialog.Title>New task</Dialog.Title>
          <button onClick={() => presence.close(onClose)} type="button">
            Close
          </button>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const wait = (ms: number) =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

test("mounted by its parent, it opens a frame later, so its entrance has a closed state to come from", async () => {
  // Base UI only plays `data-starting-style` when `open` turns true after the dialog has mounted.
  const seen: boolean[] = [];
  function Probe() {
    seen.push(useSheetPresence().open);
    return null;
  }
  render(<Probe />);
  expect(seen[0]).toBe(false);
  expect(seen.at(-1)).toBe(true);
  const view = render(<Sheet onClose={() => {}} />);
  expect(await view.findByRole("dialog", { name: "New task" })).toBeTruthy();
});

/**
 * The sheet's exit as the browser would run it: one animation on it, finished when `end` is called,
 * or never. This DOM runs no CSS, so without it every exit would be over before it began.
 */
function exiting() {
  let end = () => {};
  const finished = new Promise<void>((resolve) => {
    end = resolve;
  });
  const before = HTMLElement.prototype.getAnimations;
  HTMLElement.prototype.getAnimations = () =>
    [{ finished, pending: false, playState: "running" }] as never;
  return {
    end: () => act(async () => end()),
    restore: () => {
      HTMLElement.prototype.getAnimations = before;
    },
  };
}

test("closed, it stays drawn through its exit and tells its parent once, after", async () => {
  let closed = 0;
  const view = render(<Sheet onClose={() => closed++} />);
  const close = await view.findByRole("button", { name: "Close" });
  const exit = exiting();
  try {
    fireEvent.click(close);
    // Not on the press: the parent would take it away before its exit could play.
    await wait(20);
    expect(closed).toBe(0);
    expect(view.getByTestId("sheet").hasAttribute("data-ending-style")).toBe(
      true,
    );
    // A second close while it goes, by Escape say, does not tell the parent twice.
    fireEvent.keyDown(view.getByTestId("sheet"), { key: "Escape" });
    await exit.end();
    await wait(20);
    expect(closed).toBe(1);
    expect(view.queryByRole("dialog")).toBeNull();
    await wait(SHEET_EXIT_GRACE_MS);
    expect(closed).toBe(1);
  } finally {
    exit.restore();
  }
});

test("an exit that never says it ended still closes, once the longest exit has had its time", async () => {
  let closed = 0;
  const view = render(<Sheet onClose={() => closed++} />);
  const close = await view.findByRole("button", { name: "Close" });
  const exit = exiting();
  try {
    fireEvent.click(close);
    await wait(SHEET_EXIT_GRACE_MS - 100);
    expect(closed).toBe(0);
    await wait(150);
    expect(closed).toBe(1);
  } finally {
    exit.restore();
  }
});
