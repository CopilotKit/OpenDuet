import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  forgetRunError,
  recalledRunError,
  rememberRunError,
} from "@/lib/channels/run-error-memory";

/**
 * Why a conversation's last turn failed survives a reload in this tab, and only while nothing has
 * happened in the conversation since.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(() => window.sessionStorage.clear());
afterAll(() => GlobalRegistrator.unregister());

const SAID =
  "Couldn't reach the AI model. Check your internet connection, then try again.";

test("a failed turn's sentence comes back while its message is still the last one", () => {
  rememberRunError("channel-1", SAID, "message-7");
  expect(recalledRunError("channel-1", "message-7")).toBe(SAID);
  // Another conversation has nothing to recall.
  expect(recalledRunError("channel-2", "message-7")).toBeNull();
});

test("anything newer in the conversation makes it old news", () => {
  rememberRunError("channel-1", SAID, "message-7");
  expect(recalledRunError("channel-1", "message-8")).toBeNull();
});

test("a new turn forgets it", () => {
  rememberRunError("channel-1", SAID, "message-7");
  forgetRunError("channel-1");
  expect(recalledRunError("channel-1", "message-7")).toBeNull();
});

test("something unreadable in storage is no sentence at all", () => {
  window.sessionStorage.setItem("openduet.run-error.channel-1", "{not json");
  expect(recalledRunError("channel-1", "message-7")).toBeNull();
  window.sessionStorage.setItem(
    "openduet.run-error.channel-1",
    JSON.stringify({ said: 42, after: "message-7" }),
  );
  expect(recalledRunError("channel-1", "message-7")).toBeNull();
});
