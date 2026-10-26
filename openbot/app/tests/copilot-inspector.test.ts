import { expect, test } from "bun:test";
import { inspectorEnabled } from "@/lib/copilot/provider";

/**
 * CopilotKit's developer inspector is off unless a developer asks for it.
 *
 * The SDK turns it on for every development build on localhost, which is exactly how the README's
 * `start.sh` serves the app, so without this everybody saw a floating inspector button and the SDK's
 * promotional popover over the header, the New channel sheet and a page's actions.
 */

test("the inspector is off when nothing asks for it", () => {
  expect(inspectorEnabled({})).toBe(false);
  expect(inspectorEnabled({ DEV: true, MODE: "development" })).toBe(false);
});

test("only an explicit VITE_COPILOTKIT_INSPECTOR=true turns it on", () => {
  expect(inspectorEnabled({ VITE_COPILOTKIT_INSPECTOR: "true" })).toBe(true);
  for (const value of ["1", "yes", "TRUE", "", "false"]) {
    expect(inspectorEnabled({ VITE_COPILOTKIT_INSPECTOR: value })).toBe(false);
  }
});
