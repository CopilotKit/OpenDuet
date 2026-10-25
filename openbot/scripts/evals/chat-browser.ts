import { createRequire } from "node:module";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  type ChatSnapshot,
  type ReplySample,
  sampleBatch,
  waitForReply,
} from "./chat-sampling";

const require = createRequire(join(import.meta.dir, "../../package.json"));
const { chromium } =
  require("playwright-core") as typeof import("playwright-core");

/** Runs in the page, so all turn and answer fields come from the same DOM snapshot. */
export function readChatSnapshot(question: string): ChatSnapshot {
  const composer = [...document.querySelectorAll("form[aria-busy]")].find(
    (form) => form.querySelector('[contenteditable="true"], textarea'),
  );
  // ChannelChat gives these aria-busy markers the whole turn's pending state, including gaps
  // between tool runs. Stop the Bot is a second active-run signal, not proof of idle by its absence.
  const busy = Boolean(
    document.querySelector(
      '[aria-busy="true"], button[aria-label="Stop the Bot"]',
    ),
  );
  const reply = [
    ...document.querySelectorAll(
      '[data-slot="message"][data-align="start"] [data-slot="bubble-content"]',
    ),
  ];
  return {
    turn: busy
      ? "busy"
      : composer?.getAttribute("aria-busy") === "false"
        ? "idle"
        : "unknown",
    questionVisible: [
      ...document.querySelectorAll(
        '[data-slot="message"][data-align="end"] [data-slot="bubble-content"]',
      ),
    ].some((bubble) => (bubble as HTMLElement).innerText.trim() === question),
    approval: [...document.querySelectorAll("button")].some(
      (button) =>
        button.innerText.trim() === "Allow once" &&
        button.getClientRects().length > 0,
    ),
    stopped:
      document
        .querySelector('[data-testid="transcript-stopped"]')
        ?.textContent?.trim() || null,
    bubbles: reply.map((bubble) => (bubble as HTMLElement).innerText.trim()),
    chips: [
      ...document.querySelectorAll(
        'fieldset[aria-label="Suggested replies"] button',
      ),
    ].map((button) => button.textContent?.trim() ?? ""),
    // Preserve the existing metric; the separate listed-things rubric is outside this fix.
    listItems: Math.max(
      0,
      ...reply.map((bubble) => bubble.querySelectorAll("li").length),
    ),
  };
}

async function ask(
  page: Page,
  app: string,
  question: string,
): Promise<ReplySample> {
  const started = Date.now();
  let channelId: string | undefined;
  try {
    const created = await page.request.post(`${app}/api/channels`, {
      headers: { origin: app },
      data: { agentIds: ["openduet"] },
      timeout: 30_000,
    });
    if (!created.ok())
      throw new Error(
        `Creating the conversation returned HTTP ${created.status()}.`,
      );
    const body = (await created.json()) as { channel?: { id?: unknown } };
    if (typeof body.channel?.id !== "string" || !body.channel.id) {
      throw new Error("Creating the conversation returned no channel id.");
    }
    channelId = body.channel.id;
    await page.goto(`${app}/channel/${channelId}`, { waitUntil: "load" });
    const composer = page.locator('[contenteditable="true"], textarea').last();
    await composer.click();
    await page.keyboard.type(question);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    return await waitForReply({
      ask: question,
      channelId,
      read: () => page.evaluate(readChatSnapshot, question),
      wait: (ms) => page.waitForTimeout(ms),
    });
  } catch (error) {
    return {
      status: "failed",
      ask: question,
      channelId,
      elapsedMs: Date.now() - started,
      reason: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function sampleQuestions(
  app: string,
  questions: readonly string[],
): Promise<ReplySample[]> {
  const browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  return sampleBatch({
    questions,
    open: async () => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      return context.newPage();
    },
    ask: async (page, question) => {
      const sample = await ask(page, app, question);
      console.log(
        `${sample.status.toUpperCase()} ${question}${sample.status === "failed" ? `: ${sample.reason} — ${sample.detail}` : ""}`,
      );
      return sample;
    },
    close: () => browser.close(),
  });
}
