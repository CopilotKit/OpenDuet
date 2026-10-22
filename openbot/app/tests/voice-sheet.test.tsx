import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { deploymentKeys } from "@/lib/deployment/queries";
import * as recording from "@/lib/dictation/recording";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

const WORDS =
  "Call Leo about the Hearth clause, and send the booth balance before Friday";

const restores: (() => void)[] = [];

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  for (const restore of restores.splice(0)) restore();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/**
 * Recording and transcription stubbed the way `composer-dictation.test.tsx` stubs them, so the real
 * `DictationSession` runs between them. The transcript is held until the test lets it land.
 */
function stubDictation({ transcription = true } = {}) {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    transcription,
  });
  const audio = new Blob(["recording"], { type: "audio/webm" });
  let cancelled = 0;
  const supported = spyOn(recording, "recordingSupported").mockReturnValue(
    true,
  );
  const start = spyOn(recording, "startRecording").mockResolvedValue({
    finish: async () => audio,
    cancel() {
      cancelled++;
    },
  });
  const transcript = Promise.withResolvers<string>();
  const transcribe = spyOn(recording, "transcribeRecording").mockImplementation(
    () => transcript.promise,
  );
  restores.push(() => {
    supported.mockRestore();
    start.mockRestore();
    transcribe.mockRestore();
  });
  return {
    start,
    transcribe,
    cancelled: () => cancelled,
    land: async () => {
      await act(async () => {
        transcript.resolve(WORDS);
        await transcript.promise;
      });
    },
  };
}

function renderChatComposer(
  props: Partial<Parameters<typeof Composer>[0]> = {},
) {
  const sent: string[] = [];
  const view = render(
    <Composer
      compact
      glass
      onSubmit={(draft) => {
        sent.push(draft.text);
      }}
      {...props}
    />,
  );
  return { view, sent };
}

async function openSheet(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole("button", { name: "Speak a message" }));
  const sheet = await view.findByRole("dialog", {
    name: "Say everything you need to do",
  });
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toBe(
      "I'm listening, just start talking",
    ),
  );
  return sheet;
}

const message = (view: ReturnType<typeof render>) =>
  view.getByRole("textbox", { name: "Message" });

/**
 * Booleans rather than elements, because a failing `toBeNull()` on a happy-dom element makes bun
 * print the element's whole window, which takes minutes and reads as a hang.
 */
const hasButton = (view: ReturnType<typeof render>, name: string) =>
  view.queryByRole("button", { name }) !== null;
const sheetOpen = (view: ReturnType<typeof render>) =>
  view.queryByRole("dialog") !== null;

test("the voice button shows only on the glass composer, with transcription available", () => {
  stubDictation();
  const glass = renderChatComposer();
  expect(hasButton(glass.view, "Speak a message")).toBe(true);
  // It takes the send arrow's place, and the inline mic beside it would only say the same thing.
  expect(hasButton(glass.view, "Send message")).toBe(false);
  expect(hasButton(glass.view, "Dictate a message")).toBe(false);
  cleanup();

  // Anywhere else dictation stays inline, exactly as it was.
  const plain = render(<Composer compact onSubmit={() => {}} />);
  expect(hasButton(plain, "Speak a message")).toBe(false);
  expect(hasButton(plain, "Dictate a message")).toBe(true);
  cleanup();

  // With words in the box it is the send arrow's place again.
  const drafted = renderChatComposer({ initialValue: "Half a thought" });
  expect(hasButton(drafted.view, "Speak a message")).toBe(false);
  expect(hasButton(drafted.view, "Send message")).toBe(true);
});

test("without transcription the glass composer is unchanged", () => {
  stubDictation({ transcription: false });
  const { view } = renderChatComposer();
  expect(hasButton(view, "Speak a message")).toBe(false);
  expect(hasButton(view, "Dictate a message")).toBe(false);
  expect(hasButton(view, "Send message")).toBe(true);
});

test("opening the sheet starts recording", async () => {
  const dictation = stubDictation();
  const { view } = renderChatComposer();
  const sheet = await openSheet(view);
  expect(dictation.start).toHaveBeenCalledTimes(1);
  expect(sheet.getAttribute("aria-modal")).toBe("true");
  expect(view.queryByText("Tap ↑ when you're done") !== null).toBe(true);
  // The sheet carries the recording; the composer under it does not swap in a second set of controls.
  expect(hasButton(view, "Cancel dictation")).toBe(false);
});

test("× throws the words away, even once they were being written down", async () => {
  const dictation = stubDictation();
  const { view, sent } = renderChatComposer();
  await openSheet(view);
  fireEvent.click(view.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(sheetOpen(view)).toBe(false));
  expect(dictation.transcribe).not.toHaveBeenCalled();
  expect(dictation.cancelled()).toBe(1);
  expect(sent).toEqual([]);
  expect(message(view).textContent).toBe("");

  await openSheet(view);
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toBe("Writing it down…"),
  );
  fireEvent.click(view.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(sheetOpen(view)).toBe(false));
  await dictation.land();
  await settleReactWork();
  expect(sent).toEqual([]);
  expect(message(view).textContent).toBe("");
});

test("↑ sends the words as the person's message, once", async () => {
  const dictation = stubDictation();
  const { view, sent } = renderChatComposer();
  await openSheet(view);
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toBe("Writing it down…"),
  );
  expect(sent).toEqual([]);
  await dictation.land();
  await waitFor(() => expect(sent).toEqual([WORDS]));
  await waitFor(() => expect(sheetOpen(view)).toBe(false));
  await settleReactWork();
  expect(sent).toEqual([WORDS]);
  expect(dictation.transcribe).toHaveBeenCalledTimes(1);
  expect(message(view).textContent).toBe("");
});

test("↑ parks the words behind a turn in flight, through the composer's own queue", async () => {
  const dictation = stubDictation();
  const queued: string[] = [];
  const { view, sent } = renderChatComposer({
    pending: true,
    onQueue: (draft) => {
      queued.push(draft.text);
    },
  });
  await openSheet(view);
  fireEvent.click(view.getByRole("button", { name: "Send" }));
  await dictation.land();
  await waitFor(() => expect(queued).toEqual([WORDS]));
  expect(sent).toEqual([]);
});

test("Type instead puts the words in the draft to edit, and sends nothing", async () => {
  const dictation = stubDictation();
  const { view, sent } = renderChatComposer();
  await openSheet(view);
  fireEvent.click(view.getByRole("button", { name: "Type instead" }));
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toBe("Writing it down…"),
  );
  await dictation.land();
  await waitFor(() => expect(sheetOpen(view)).toBe(false));
  await waitFor(() => expect(message(view).textContent).toBe(WORDS));
  await waitFor(() =>
    expect(message(view).contains(document.activeElement)).toBe(true),
  );
  await settleReactWork();
  expect(sent).toEqual([]);
  expect(hasButton(view, "Send message")).toBe(true);
});

test("Type instead hands over the caret even while the Bot is answering", async () => {
  const dictation = stubDictation();
  const { view, sent } = renderChatComposer({
    pending: true,
    onQueue: () => {},
  });
  await openSheet(view);
  fireEvent.click(view.getByRole("button", { name: "Type instead" }));
  await dictation.land();
  await waitFor(() => expect(sheetOpen(view)).toBe(false));
  await waitFor(() =>
    expect(message(view).contains(document.activeElement)).toBe(true),
  );
  expect(message(view).textContent).toBe(WORDS);
  expect(sent).toEqual([]);
});

test("Esc discards, and gives the focus back to the voice button", async () => {
  const dictation = stubDictation();
  const { view, sent } = renderChatComposer();
  const opener = view.getByRole("button", { name: "Speak a message" });
  opener.focus();
  const sheet = await openSheet(view);
  fireEvent.keyDown(sheet, { key: "Escape" });
  await waitFor(() => expect(sheetOpen(view)).toBe(false));
  await waitFor(() => expect(document.activeElement === opener).toBe(true));
  expect(dictation.transcribe).not.toHaveBeenCalled();
  expect(dictation.cancelled()).toBe(1);
  expect(sent).toEqual([]);
  expect(message(view).textContent).toBe("");
});

test("while Stop holds the send arrow's place, the mic opens the sheet instead", async () => {
  const dictation = stubDictation();
  const { view } = renderChatComposer({ pending: true, onStop: () => {} });
  expect(hasButton(view, "Stop the Bot")).toBe(true);
  expect(hasButton(view, "Speak a message")).toBe(false);
  fireEvent.click(view.getByRole("button", { name: "Dictate a message" }));
  await view.findByRole("dialog", { name: "Say everything you need to do" });
  expect(dictation.start).toHaveBeenCalledTimes(1);
});
