import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { MicOrb } from "@/components/duet/mic-orb";
import {
  drawMicOrb,
  FINISH_HELD,
  FINISH_S,
  finishPhase,
  type OrbPose,
  oklch,
  palette,
  RAYS,
  track,
} from "@/components/duet/mic-orb-draw";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

const REST: OrbPose = {
  ta: 1.6,
  listen: 0,
  think: 0,
  done: 0,
  smile: 0,
  tilt: 0,
  ax: 0,
  ay: 0.04,
  blink: 0,
  nod: 0,
  key: 0,
  doneAge: -1,
  noticeAge: -1,
  finishAge: -1,
  breath: 0,
};

/**
 * Just enough of a 2D context to run the drawing: it keeps the shadow blur through save and
 * restore, counts the strokes drawn with a glow, which is how a lit grille slot is drawn, counts
 * every stroke, and counts the frames drawn, each of which starts by clearing the canvas.
 */
function fakeContext() {
  const stack: number[] = [];
  const gradient = { addColorStop: () => {} };
  const ctx = {
    shadowBlur: 0,
    litStrokes: 0,
    strokes: 0,
    draws: 0,
    save() {
      stack.push(this.shadowBlur);
    },
    restore() {
      this.shadowBlur = stack.pop() ?? 0;
    },
    stroke() {
      this.strokes++;
      if (this.shadowBlur > 0) this.litStrokes++;
    },
    clearRect() {
      this.draws++;
    },
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  };
  return new Proxy(ctx, {
    get: (target, key) =>
      key in target ? target[key as keyof typeof target] : () => {},
    set: (target, key, value) => {
      (target as Record<string | symbol, unknown>)[key] = value;
      return true;
    },
  });
}

/** Every stroke one frame draws: the grilles' slots, the rim, and a finish's rays and check. */
const strokesOf = (pose: OrbPose) => {
  const ctx = fakeContext();
  drawMicOrb(ctx as unknown as CanvasRenderingContext2D, 60, pose, {
    dark: false,
  });
  return ctx.strokes;
};

const litSlots = (pose: OrbPose) => {
  const ctx = fakeContext();
  drawMicOrb(ctx as unknown as CanvasRenderingContext2D, 60, pose, {
    dark: false,
  });
  return ctx.litStrokes;
};

describe("the orb's motion", () => {
  test("an eased key arrives and a spring overshoots, then both settle on the target", () => {
    const eased = { from: 0, keys: [{ at: 1, to: 1, ease: 0.4 }] };
    expect(track(eased, 0.5)).toBe(0);
    expect(track(eased, 1.2)).toBeGreaterThan(0);
    expect(track(eased, 2)).toBe(1);

    const sprung = {
      from: 0,
      keys: [{ at: 0, to: 1, spring: [14, 0.5] as const }],
    };
    const peak = Math.max(
      ...Array.from({ length: 60 }, (_, i) => track(sprung, i / 60)),
    );
    expect(peak).toBeGreaterThan(1);
    expect(track(sprung, 5)).toBeCloseTo(1, 4);
  });

  test("a later key moves on from where the earlier one left it", () => {
    const tr = {
      from: 0,
      keys: [
        { at: 0, to: 1, ease: 0.4 },
        { at: 1, to: 0.25, ease: 0.4 },
      ],
    };
    expect(track(tr, 0.9)).toBe(1);
    expect(track(tr, 3)).toBe(0.25);
  });
});

describe("Ocean", () => {
  test("the sphere's base is a pale blue and its grilles a deep one", () => {
    const pal = palette(1, 0);
    const [r, g, b] = pal.bg;
    expect(b).toBeGreaterThan(r);
    expect(Math.min(r, g, b)).toBeGreaterThan(200);
    expect(pal.violet[2]).toBeGreaterThan(pal.violet[0]);
    expect(Math.max(...pal.violet)).toBeLessThan(230);
  });

  test("a colour outside sRGB loses chroma rather than turning into another hue", () => {
    const [r, g, b] = oklch(0.6, 0.5, 262);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });
});

describe("the grilles", () => {
  test("stay dark at rest", () => {
    expect(litSlots(REST)).toBe(0);
  });

  test("light from the bottom with each keystroke while it listens", () => {
    const listening = { ...REST, listen: 1 };
    const soft = litSlots(listening);
    const typed = litSlots({ ...listening, key: 1 });
    expect(typed).toBeGreaterThan(soft);
    // Five slots a side, all lit on a full keystroke.
    expect(typed).toBe(10);
  });

  test("carry a scanning light while it works, and flash when it lands", () => {
    expect(litSlots({ ...REST, think: 1 })).toBeGreaterThan(0);
    expect(litSlots({ ...REST, done: 1, doneAge: 0.35 })).toBe(10);
  });
});

describe("a finish", () => {
  test("the eyes give way to a check while the rays fly, then the eyes come back", () => {
    expect(finishPhase(-1)).toMatchObject({ check: 0, rays: -1, eyes: 1 });

    const burst = finishPhase(0.4);
    expect(burst.eyes).toBe(0);
    expect(burst.check).toBe(1);
    expect(burst.rays).toBeGreaterThan(0);
    expect(burst.rays).toBeLessThan(1);

    // Held: the check whole, the burst over.
    expect(finishPhase(FINISH_HELD)).toMatchObject({
      check: 1,
      checkAlpha: 1,
      rays: -1,
      eyes: 0,
    });

    expect(finishPhase(FINISH_S)).toEqual(finishPhase(-1));
  });

  test("the check strokes on along its length", () => {
    const early = finishPhase(0.12).check;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(finishPhase(0.24).check);
  });

  test("draws its rays and its check over the orb, and nothing once it is over", () => {
    const rest = strokesOf(REST);
    expect(strokesOf({ ...REST, finishAge: 0.4 })).toBe(rest + RAYS + 1);
    expect(strokesOf({ ...REST, finishAge: FINISH_HELD })).toBe(rest + 1);
    expect(strokesOf({ ...REST, finishAge: FINISH_S })).toBe(rest);
  });
});

describe("<MicOrb>", () => {
  test("holds its footprint, hides from assistive tech, and draws on a canvas twice its size", () => {
    const view = render(<MicOrb size={40} state="listening" />);
    const orb = view.container.firstElementChild as HTMLElement;
    expect(orb.getAttribute("aria-hidden")).toBe("true");
    expect(orb.dataset.state).toBe("listening");
    expect(orb.style.width).toBe("40px");
    const canvas = orb.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.style.width).toBe("80px");
    expect(canvas.style.left).toBe("-20px");
  });

  test("still, it draws once and again only when the theme changes, never on a frame loop", async () => {
    const ctx = fakeContext();
    let frames = 0;
    const requestFrame = window.requestAnimationFrame;
    const getContext = HTMLCanvasElement.prototype.getContext;
    window.requestAnimationFrame = (callback) => {
      frames++;
      return requestFrame(callback);
    };
    HTMLCanvasElement.prototype.getContext = (() =>
      ctx) as unknown as typeof getContext;
    try {
      render(<MicOrb size={40} still />);
      expect(ctx.draws).toBe(1);
      document.documentElement.classList.add("dark");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(ctx.draws).toBe(2);
      expect(frames).toBe(0);

      cleanup();
      render(<MicOrb size={40} />);
      expect(frames).toBe(1);
    } finally {
      document.documentElement.classList.remove("dark");
      window.requestAnimationFrame = requestFrame;
      HTMLCanvasElement.prototype.getContext = getContext;
    }
  });

  test("still, finished is the check without the burst", () => {
    const strokes = (state?: "finished") => {
      const ctx = fakeContext();
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = (() =>
        ctx) as unknown as typeof getContext;
      try {
        render(<MicOrb size={40} state={state} still />);
        cleanup();
        return ctx.strokes;
      } finally {
        HTMLCanvasElement.prototype.getContext = getContext;
      }
    };
    expect(strokes("finished")).toBe(strokes() + 1);
  });

  test("follows a change of state", () => {
    const view = render(<MicOrb size={40} />);
    expect(
      view.container.querySelector("[data-state]")?.getAttribute("data-state"),
    ).toBe("idle");
    view.rerender(<MicOrb size={40} state="thinking" />);
    expect(
      view.container.querySelector("[data-state]")?.getAttribute("data-state"),
    ).toBe("thinking");
    view.rerender(<MicOrb size={40} state="finished" />);
    expect(
      view.container.querySelector("[data-state]")?.getAttribute("data-state"),
    ).toBe("finished");
  });
});
