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
  type OrbPose,
  oklch,
  palette,
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
  breath: 0,
};

/**
 * Just enough of a 2D context to run the drawing: it keeps the shadow blur through save and
 * restore, and counts the strokes drawn with a glow, which is how a lit grille slot is drawn.
 */
function fakeContext() {
  const stack: number[] = [];
  const gradient = { addColorStop: () => {} };
  const ctx = {
    shadowBlur: 0,
    litStrokes: 0,
    save() {
      stack.push(this.shadowBlur);
    },
    restore() {
      this.shadowBlur = stack.pop() ?? 0;
    },
    stroke() {
      if (this.shadowBlur > 0) this.litStrokes++;
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

  test("follows a change of state", () => {
    const view = render(<MicOrb size={40} />);
    expect(
      view.container.querySelector("[data-state]")?.getAttribute("data-state"),
    ).toBe("idle");
    view.rerender(<MicOrb size={40} state="thinking" />);
    expect(
      view.container.querySelector("[data-state]")?.getAttribute("data-state"),
    ).toBe("thinking");
  });
});
