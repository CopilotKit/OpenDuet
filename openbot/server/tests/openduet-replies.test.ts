import { describe, expect, test } from "bun:test";
import type { Database } from "../src/db/client";
import {
  MAX_REPLY_LENGTH,
  REPLIES_TOOL,
  replyTools,
} from "../src/openduet/replies";
import { createOpenDuetTools } from "../src/openduet/wiring";

const INITIATOR = { kind: "person" } as const;

function tool() {
  const [only] = replyTools({ initiator: INITIATOR });
  if (!only) throw new Error("no tool");
  return only;
}

describe("the suggest_replies tool", () => {
  test("is held under the openduet ref, beside the brief, by every Bot", () => {
    expect(tool().name).toBe(REPLIES_TOOL);
    expect(tool().ref).toBe("openduet/suggest_replies");
    expect(tool().initiator).toEqual(INITIATOR);

    // Nothing is called while the tools are assembled, so nothing here needs to answer.
    const held = createOpenDuetTools({
      database: {} as Database,
      callTool: async () => ({ text: "", isError: true }),
      complete: async () => "",
      model: "test",
      directChannel: async () => ({ id: "", threadId: "" }),
    })("dev-local-user", "openduet", INITIATOR);
    expect(held.map((granted) => granted.ref)).toEqual([
      "openduet/morning_brief",
      "openduet/suggest_replies",
      "openduet/add_tasks",
      "openduet/offer_task",
      "openduet/read_page",
      "openduet/make_page",
    ]);
  });

  test("acknowledges two or three short replies, and tells the Bot what is left to say", async () => {
    for (const replies of [
      ["Yes", "No"],
      ["Yes", "No", "Not now"],
      ["Ana's ship date", "The studio visit", "Glaze order"],
    ]) {
      const answer = await tool().execute({ replies });
      expect(answer).not.toStartWith("Refused.");
      expect(answer).toContain("The buttons are on screen");
    }
  });

  test("refuses too few, too many, blank, long or repeated replies, and says what it takes", async () => {
    const long = "x".repeat(MAX_REPLY_LENGTH + 1);
    for (const args of [
      { replies: ["Yes"] },
      { replies: ["One", "Two", "Three", "Four"] },
      { replies: ["Yes", "   "] },
      { replies: ["Yes", long] },
      { replies: ["Yes", "yes"] },
      { replies: "Yes, No" },
      { replies: ["Yes", "No"], extra: true },
      {},
      undefined,
    ]) {
      expect(await tool().execute(args)).toBe(
        "Refused. suggest_replies takes two or three different replies, each at most 24 characters.",
      );
    }
  });

  test("counts a reply's length without the spaces around it", async () => {
    const padded = `  ${"x".repeat(MAX_REPLY_LENGTH)}  `;
    expect(await tool().execute({ replies: ["Yes", padded] })).not.toStartWith(
      "Refused.",
    );
  });
});
