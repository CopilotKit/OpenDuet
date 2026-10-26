import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  patientStep,
  STILL_WORKING,
  STILL_WORKING_MS,
  TAKING_LONGER,
  TAKING_LONGER_MS,
  THINKING,
  usePatientStep,
} from "@/components/shell/chat-presence";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot that thinks with nothing to show for a while gets a gentle word in the pill, rather than
 * "Thinking it through" for two minutes and then a failure. Nothing is ended: only what the pill
 * says changes, and any sign of progress puts it back.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("a quiet think becomes still working, then taking longer than usual", () => {
  expect(patientStep(THINKING, 0)).toBe(THINKING);
  expect(patientStep(THINKING, STILL_WORKING_MS - 1)).toBe(THINKING);
  expect(patientStep(THINKING, STILL_WORKING_MS)).toBe(STILL_WORKING);
  expect(patientStep(THINKING, TAKING_LONGER_MS)).toBe(TAKING_LONGER);
});

test("a named step and no step pass through untouched", () => {
  expect(patientStep("Searching your email", TAKING_LONGER_MS * 2)).toBe(
    "Searching your email",
  );
  expect(patientStep(null, TAKING_LONGER_MS * 2)).toBeNull();
});

test("the pill moves on with time, and progress starts the quiet clock again", () => {
  jest.useFakeTimers();
  const view = renderHook(
    ({ step, progress }: { step: string | null; progress: string }) =>
      usePatientStep(step, progress),
    { initialProps: { step: THINKING, progress: "1:0" } },
  );
  expect(view.result.current).toBe(THINKING);

  act(() => {
    jest.advanceTimersByTime(STILL_WORKING_MS);
  });
  expect(view.result.current).toBe(STILL_WORKING);

  act(() => {
    jest.advanceTimersByTime(TAKING_LONGER_MS - STILL_WORKING_MS);
  });
  expect(view.result.current).toBe(TAKING_LONGER);

  // The answer starts arriving: the turn is not quiet any more.
  view.rerender({ step: THINKING, progress: "2:14" });
  expect(view.result.current).toBe(THINKING);
});
