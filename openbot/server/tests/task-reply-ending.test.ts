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

test("a reply that waits on the person without a question mark still asks for input", () => {
  // Found on Tasks reading Ready for review.
  expect(
    replyEnding(
      "I read the order.\n\nIf you send me the details, I'll fill in the labels.",
    ),
  ).toEqual({
    tail: "If you send me the details, I'll fill in the labels.",
    asks: true,
  });
  for (const text of [
    "Once you confirm, I’ll send it.",
    "Send me the label sizes and I'll fill them in.",
    "Let me know which supplier you prefer.",
    "I need your sign-off on the quote.",
    "Waiting on you for the PO number.",
    "This needs your OK before it goes out.",
  ])
    expect(replyEnding(text).asks).toBe(true);
  // Advice, an optional offer and a plain report are not waiting on anybody.
  for (const text of [
    "If you reply to Rosa, mention the Friday date.",
    "The draft is in your outbox. Let me know if you want changes.",
    "Send it whenever you are ready.",
    "Priya's other email says your Q2 return is already filed.",
  ])
    expect(replyEnding(text).asks).toBe(false);
});

test("a heading over what the Bot prepared is not its next step", () => {
  // Found on Tasks as "Ready for review · Where the website lives now."
  expect(
    replyEnding(
      "I moved the site to Netlify and pointed the domain at it.\n\n**Where the website lives now.**\n\n- Host: Netlify\n- DNS: Cloudflare",
    ).tail,
  ).toBe("I moved the site to Netlify and pointed the domain at it.");
  // In one paragraph with its list, too.
  expect(
    replyEnding(
      "I moved the site.\n\n**Where the website lives now.**\n- Host: Netlify\n- DNS: Cloudflare",
    ).tail,
  ).toBe("I moved the site.");
  // And as "· Make-up and cancellation policy".
  expect(
    replyEnding(
      "I drafted the studio policies for you to review.\n\n### Make-up and cancellation policy",
    ).tail,
  ).toBe("I drafted the studio policies for you to review.");
  // A last sentence put in bold, with nothing under it, is still what the Bot said.
  expect(
    replyEnding("Done.\n\n**I need your sign-off before Friday.**"),
  ).toEqual({ tail: "I need your sign-off before Friday.", asks: true });
});
