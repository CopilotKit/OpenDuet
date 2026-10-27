import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  hasReducedMotionListener,
  MotionConfig,
  MotionGlobalConfig,
  prefersReducedMotion,
} from "motion/react";
import { SwipeToAnswer } from "@/components/shell/swipe-to-answer";
import { runMotionFrames as runFrames } from "./run-motion-frames";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  MotionGlobalConfig.useManualTiming = true;
});
afterEach(() => cleanup());
afterAll(() => {
  MotionGlobalConfig.useManualTiming = false;
  GlobalRegistrator.unregister();
});

const TITLE = "Answer Rosa about the glaze substitute";
/**
 * The drag that answers. The test DOM lays nothing out, so the card measures 0 wide and the
 * threshold is the component's least distance.
 */
const THRESHOLD = 96;
/**
 * Where a card flown right ends: just past the screen's edge, from where it sits at rest. The test
 * DOM's window is 1024 wide and lays the card out at 0, and the card clears the edge by 16.
 */
const OFF_SCREEN = 1024 + 16;

/**
 * A card in the swipe, held by a finger on its title, with what it was asked to do recorded. Each
 * move of the finger is followed by a frame, so what the drag draws is drawn.
 */
function swipeCard({ reduced = false } = {}) {
  const answers: string[] = [];
  const node = (
    <SwipeToAnswer
      disabled={false}
      onHide={() => answers.push("hide")}
      onStart={() => answers.push("start")}
    >
      <div>
        <p>{TITLE}</p>
        <button type="button">Start</button>
      </div>
    </SwipeToAnswer>
  );
  const view = render(
    reduced ? <MotionConfig reducedMotion="always">{node}</MotionConfig> : node,
  );
  const title = view.getByText(TITLE);
  const part = (selector: string) => {
    const found = view.container.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`nothing matches ${selector}`);
    return found;
  };
  const at = { pointerId: 7, pointerType: "touch", clientX: 160, clientY: 40 };
  const content = part("[data-swipe-content]");
  return {
    answers,
    content,
    slab: part("[data-swipe-slab]"),
    /** The layer that moves and tilts, holding the card, its tint and its marks. */
    layer: content.parentElement as HTMLElement,
    tint: (side: "start" | "hide") => part(`[data-swipe-tint="${side}"]`),
    mark: (side: "start" | "hide") => part(`[data-swipe-mark="${side}"]`),
    /** A finger down on the title and moved `across`, still held. */
    hold: async (across: number) => {
      fireEvent.pointerDown(title, at);
      fireEvent.pointerMove(title, { ...at, clientX: at.clientX + across });
      await runFrames();
    },
    move: async (across: number) => {
      fireEvent.pointerMove(title, { ...at, clientX: at.clientX + across });
      await runFrames();
    },
    release: (across: number) =>
      fireEvent.pointerUp(title, { ...at, clientX: at.clientX + across }),
  };
}

/** The blur radius a layer is drawn with, 0 when it has none. */
const blurOf = (element: HTMLElement) => {
  const found = /blur\(([\d.]+)px\)/.exec(element.style.filter);
  return found ? Number(found[1]) : 0;
};
const opacityOf = (element: HTMLElement) => Number(element.style.opacity);
const travelOf = (element: HTMLElement) =>
  Number(/translateX\((-?[\d.]+)px\)/.exec(element.style.transform)?.[1] ?? 0);

describe("the card, while it is slid", () => {
  test("blurs its content and tints green as the drag goes right, more the further it goes", async () => {
    const card = swipeCard();
    await card.hold(THRESHOLD * 0.25);
    const quarter = blurOf(card.content);
    const quarterTint = opacityOf(card.tint("start"));
    // The content fades on the blur's own ramp: already going a quarter of the way.
    const quarterContent = opacityOf(card.content);
    expect(quarterContent).toBeLessThan(1);
    expect(quarterContent).toBeGreaterThan(0.4);
    // Already unreadable a quarter of the way: the card reads as on its way the moment it moves.
    expect(quarter).toBeGreaterThan(4);
    expect(quarterTint).toBeGreaterThan(0);
    expect(opacityOf(card.tint("hide"))).toBe(0);

    await card.move(THRESHOLD * 0.6);
    expect(blurOf(card.content)).toBeGreaterThan(quarter);
    expect(opacityOf(card.tint("start"))).toBeGreaterThan(quarterTint);

    await card.move(THRESHOLD);
    expect(opacityOf(card.tint("start"))).toBe(1);
    expect(blurOf(card.content)).toBeGreaterThanOrEqual(12);
    expect(blurOf(card.content)).toBeLessThanOrEqual(16);
    // The blur is the content's own, drawn on an opaque slab of the card's colour.
    expect(card.content.style.filter).toMatch(/^blur\(/);
    expect(opacityOf(card.slab)).toBe(1);
    // Clipped to the card's own corners, the card token, so the slab keeps its edge.
    expect(card.content.style.clipPath).toBe(
      "inset(0 round var(--duet-radius-card))",
    );
    // And faded to a ghost under the tint, so nothing dark in it is blurred out to that edge.
    expect(opacityOf(card.content)).toBeCloseTo(0.4, 2);
    // And it still tilts toward where it is going.
    expect(card.layer.style.transform).toContain("rotate(4deg)");

    // Further on it is no blurrier: the threshold is as far as it goes.
    await card.move(THRESHOLD * 1.5);
    expect(blurOf(card.content)).toBe(14);
    card.release(THRESHOLD * 0.2);
  });

  test("dragged left, it blurs the same and tints grey instead of green", async () => {
    const card = swipeCard();
    await card.hold(-THRESHOLD * 0.6);
    expect(opacityOf(card.tint("hide"))).toBeGreaterThan(0);
    expect(blurOf(card.content)).toBeGreaterThan(4);
    expect(opacityOf(card.tint("start"))).toBe(0);
    expect(card.layer.style.transform).toContain("rotate(-");
    card.release(-THRESHOLD * 0.2);
  });

  test("at rest, and back at rest after a short drag, it has no blur, tint, slab or mark", async () => {
    const card = swipeCard();
    const atRest = () => {
      // `none`, not a zero blur: any filter would cut the card's glass off from what is behind it.
      expect(card.content.style.filter).toBe("none");
      expect(opacityOf(card.content)).toBe(1);
      expect(card.content.style.clipPath).toBe("none");
      expect(opacityOf(card.slab)).toBe(0);
      expect(opacityOf(card.tint("start"))).toBe(0);
      expect(opacityOf(card.tint("hide"))).toBe(0);
      expect(opacityOf(card.mark("start"))).toBe(0);
      expect(opacityOf(card.mark("hide"))).toBe(0);
      expect(travelOf(card.layer)).toBe(0);
    };
    atRest();

    await card.hold(THRESHOLD * 0.6);
    expect(blurOf(card.content)).toBeGreaterThan(0);
    card.release(THRESHOLD * 0.6);
    // A few frames in it is on its way back, still a little blurred.
    await runFrames(4);
    expect(travelOf(card.layer)).toBeLessThan(THRESHOLD * 0.6);
    expect(blurOf(card.content)).toBeGreaterThan(0);
    // Springs back, frame by frame. It never goes past its place, so Hide's side never shows, and
    // the last two pixels of the way are drawn as the card at rest, not as a faint hand-off.
    for (let frame = 0; frame < 90; frame++) {
      await runFrames();
      const travel = travelOf(card.layer);
      expect(travel).toBeGreaterThanOrEqual(0);
      expect(opacityOf(card.tint("hide"))).toBe(0);
      expect(opacityOf(card.mark("hide"))).toBe(0);
      if (travel < 2) {
        expect(card.content.style.filter).toBe("none");
        expect(opacityOf(card.slab)).toBe(0);
        expect(opacityOf(card.tint("start"))).toBe(0);
        expect(opacityOf(card.mark("start"))).toBe(0);
      }
    }
    atRest();
    expect(card.answers).toEqual([]);
  });

  test("a mark rides on the card: an outlined ring on the way, filled in at the threshold", async () => {
    const card = swipeCard();
    expect(card.mark("start").getAttribute("data-state")).toBe("ring");
    await card.hold(THRESHOLD * 0.6);
    expect(opacityOf(card.mark("start"))).toBe(1);
    expect(card.mark("start").getAttribute("data-state")).toBe("ring");
    expect(card.mark("start").textContent).toBe("Start");
    expect(opacityOf(card.mark("hide"))).toBe(0);
    // Inside the card's own layer, above the blur: it moves and tilts with the card but stays sharp.
    expect(card.mark("start").parentElement).toBe(card.layer);
    expect(card.content.contains(card.mark("start"))).toBe(false);
    expect(card.mark("start").style.filter).toBe("");

    await card.move(THRESHOLD);
    expect(card.mark("start").getAttribute("data-state")).toBe("filled");
    // Back short of it, and the disc is a ring again: letting go would no longer do it.
    await card.move(THRESHOLD * 0.8);
    expect(card.mark("start").getAttribute("data-state")).toBe("ring");
    card.release(THRESHOLD * 0.2);
  });

  test("toward Hide the mark is the grey one, with Hide under it, and it fills at the threshold too", async () => {
    const card = swipeCard();
    await card.hold(-THRESHOLD);
    expect(card.mark("hide").getAttribute("data-state")).toBe("filled");
    expect(opacityOf(card.mark("hide"))).toBe(1);
    expect(card.mark("hide").textContent).toBe("Hide");
    expect(opacityOf(card.mark("start"))).toBe(0);
    card.release(-THRESHOLD * 0.2);
  });

  test("let go past the threshold, it is seen flying off still blurred, and answers once it has left the screen", async () => {
    const card = swipeCard();
    await card.hold(THRESHOLD + 20);
    expect(opacityOf(card.tint("start"))).toBe(1);
    card.release(THRESHOLD + 20);
    // A tenth of a second in: further out than it was let go, but still on the screen, as blurred
    // as it gets, with its mark filled. Nothing is sent while it can still be seen.
    await runFrames(6);
    const midway = travelOf(card.layer);
    expect(midway).toBeGreaterThan(THRESHOLD + 20);
    expect(opacityOf(card.layer)).toBe(1);
    expect(midway).toBeLessThan(OFF_SCREEN);
    expect(blurOf(card.content)).toBe(14);
    expect(card.mark("start").getAttribute("data-state")).toBe("filled");
    expect(card.answers).toEqual([]);
    // Most of the way, still going.
    await runFrames(8);
    expect(travelOf(card.layer)).toBeGreaterThan(midway);
    expect(travelOf(card.layer)).toBeLessThan(OFF_SCREEN);
    expect(card.answers).toEqual([]);
    // Just past the screen's edge, and answered on the frame it got there: not on a timer, which
    // would not have run yet.
    await runFrames(4);
    expect(travelOf(card.layer)).toBe(OFF_SCREEN);
    expect(card.answers).toEqual(["start"]);
    // Faded out over the second half of the way, so it dissolves at the edge of what shows it
    // rather than being cut off by it.
    expect(opacityOf(card.layer)).toBe(0);
  });

  test("let go past the threshold in a tab that gets no frames, it still answers, once", async () => {
    const card = swipeCard();
    await card.hold(-(THRESHOLD + 20));
    card.release(-(THRESHOLD + 20));
    // No frames at all, as for a tab in the background: the flight never finishes.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 450)));
    expect(card.answers).toEqual(["hide"]);
    // And when frames come back and the flight does finish, it does not answer again.
    await runFrames(30);
    expect(card.answers).toEqual(["hide"]);
  });
});

describe("the card, slid with reduced motion", () => {
  /**
   * Holds a card the way reduced motion should leave it: it never blurs or tilts, the tint and the
   * mark fade in with the drag, the mark still fills, and past the threshold it answers where it is
   * let go, without flying, and is at rest again.
   */
  async function slidCalmly(card: ReturnType<typeof swipeCard>) {
    await card.hold(THRESHOLD * 0.6);
    expect(opacityOf(card.tint("start"))).toBeGreaterThan(0);
    expect(opacityOf(card.mark("start"))).toBe(1);
    expect(card.content.style.filter).toBe("none");
    expect(opacityOf(card.slab)).toBe(0);
    expect(card.layer.style.transform).not.toContain("rotate");

    await card.move(THRESHOLD);
    expect(card.mark("start").getAttribute("data-state")).toBe("filled");
    expect(opacityOf(card.tint("start"))).toBe(1);
    expect(card.content.style.filter).toBe("none");
    expect(card.layer.style.transform).not.toContain("rotate");
    card.release(THRESHOLD);
    await runFrames();
    expect(card.answers).toEqual(["start"]);
    expect(travelOf(card.layer)).toBe(0);
    expect(opacityOf(card.tint("start"))).toBe(0);
  }

  test("asked for by the device, with no MotionConfig above the card", async () => {
    /*
     * What motion reads from `matchMedia("(prefers-reduced-motion)")` on a device set to reduce
     * motion. Motion decides whether it is in a browser once, when its module is first evaluated,
     * and under `bun test` that is before any DOM exists, so here it never asks `matchMedia` at all.
     * The answer goes where motion keeps it, and the app's own setup is left alone: no MotionConfig,
     * which by default never reduces.
     */
    const before = {
      listening: hasReducedMotionListener.current,
      prefers: prefersReducedMotion.current,
    };
    hasReducedMotionListener.current = true;
    prefersReducedMotion.current = true;
    try {
      await slidCalmly(swipeCard());
    } finally {
      hasReducedMotionListener.current = before.listening;
      prefersReducedMotion.current = before.prefers;
    }
  });

  test("asked for by a MotionConfig above the card", async () => {
    await slidCalmly(swipeCard({ reduced: true }));
  });
});
