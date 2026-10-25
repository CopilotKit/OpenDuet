import { act } from "@testing-library/react";
import { frameData, frameSteps } from "motion/react";

/**
 * Runs motion's frame loop by hand, `count` frames of 1/60 s.
 *
 * Motion binds its loop to `requestAnimationFrame` once, when its module is first evaluated, and
 * under `bun test` that is before any file has registered a DOM: so on its own nothing that waits
 * for a frame ever happens, not a motion value drawn into a style and not a spring. The clock is
 * the frames' own (manual timing), and between two frames it reads half a frame on, the way real
 * time has moved on when a finger moves between frames: motion skips drawing a change it thinks was
 * made at the instant of the frame it last drew. Each frame starts on a fresh microtask, because
 * motion holds one reading of the clock until the next.
 */
export async function runMotionFrames(count = 1) {
  const half = 1000 / 60 / 2;
  await act(async () => {
    for (let index = 0; index < count; index++) {
      await Promise.resolve();
      frameData.delta = half * 2;
      frameData.timestamp += half;
      frameData.isProcessing = true;
      for (const step of STEPS) frameSteps[step].process(frameData);
      frameData.isProcessing = false;
      frameData.timestamp += half;
      await Promise.resolve();
    }
  });
}
const STEPS = [
  "setup",
  "read",
  "resolveKeyframes",
  "preUpdate",
  "update",
  "preRender",
  "render",
  "postRender",
] as const;
