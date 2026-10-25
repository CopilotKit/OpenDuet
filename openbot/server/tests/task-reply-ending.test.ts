import { expect, test } from "bun:test";
import { replyEnding } from "../src/proactive/engine";

test("only a spoken final paragraph asks for input, past draft quotes and list items", () => {
  for (const text of [
    "Which one should I use? 🙂",
    "Ready. Shall I send it? Let me know.",
    "Which date works?\n\n- Friday\n- Monday",
    "Which version?\n\n> Would you like a quote?",
  ])
    expect(replyEnding(text).asks).toBe(true);
  for (const text of [
    "- Is Friday okay?",
    "> Is Friday okay?",
    "“Can we book Friday?”",
    "Done.\n\n- Why not Friday?",
    "I found the date.\n\n**Draft:** Can we book Friday?",
  ])
    expect(replyEnding(text).asks).toBe(false);
});
