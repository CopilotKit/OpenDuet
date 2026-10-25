import { describe, expect, test } from "bun:test";
import type { ContentPart, Message, ToolMessage } from "@ag-ui/core";
import { MessageSchema } from "@ag-ui/core/schemas";
import { browserStepDetails } from "../src/components/channels/browser-activity";
import {
  repliesLast,
  toVisibleChatItems,
} from "../src/components/channels/chat-messages";
import {
  groupToolSteps,
  stepDetails,
} from "../src/components/channels/tool-activity";
import { readThreadMessages } from "../src/lib/copilot/thread-messages";

function conversation(
  content: ToolMessage["content"],
  name = "suggest_replies",
): Message[] {
  const messages: Message[] = [
    {
      id: "assistant",
      role: "assistant",
      toolCalls: [
        {
          id: "call",
          type: "function",
          function: {
            name,
            arguments: JSON.stringify({ replies: ["Yes", "No"] }),
          },
        },
      ],
    },
    { id: "result", role: "tool", toolCallId: "call", content },
  ];
  // These are protocol-valid results, including media, rather than malformed arrays.
  for (const message of messages)
    expect(MessageSchema.safeParse(message).success).toBe(true);
  return messages;
}

function projectedTool(messages: readonly Message[]) {
  const item = toVisibleChatItems(messages)[0];
  if (item?.kind !== "tool") throw new Error("Expected a projected tool call");
  return item;
}

const media: ContentPart[] = [
  {
    type: "image",
    source: { type: "url", value: "https://example.com/a.png" },
  },
  {
    type: "audio",
    source: { type: "data", value: "YXVkaW8=", mimeType: "audio/wav" },
  },
  { type: "video", source: { type: "file", value: "file-video" } },
  {
    type: "document",
    source: { type: "url", value: "https://example.com/a.pdf" },
  },
];

describe("multipart tool results", () => {
  test("shows replies when a valid multipart result arrives in the live message array", () => {
    const messages = conversation([
      { type: "text", text: "Replies " },
      { type: "text", text: "shown" },
    ]);
    const live = messages.slice(0, 1);
    expect(projectedTool(live).result).toBeUndefined();
    expect(repliesLast(toVisibleChatItems(live))).toEqual([]);

    live.push(...messages.slice(1));
    // This used to throw in asText's .trim() during ChatTranscript's render.
    expect(
      repliesLast(toVisibleChatItems(live)).map((item) => item.id),
    ).toEqual(["call"]);
    expect(projectedTool(live).result).toBe("Replies shown");
    expect(messages[1]?.content).toEqual([
      { type: "text", text: "Replies " },
      { type: "text", text: "shown" },
    ]);
  });

  test("restores multipart replies through the JSON history endpoint", async () => {
    const messages = conversation([{ type: "text", text: "Replies shown" }]);
    const original = globalThis.fetch;
    const handler = async () => Response.json({ messages });
    globalThis.fetch = Object.assign(handler, {
      preconnect: original.preconnect,
    });
    try {
      const stored = await readThreadMessages("thread", "agent");
      expect(stored.availability).toBe("ready");
      expect(stored.unreadable).toBe(0);
      expect(stored.messages).toEqual(messages);
      expect(repliesLast(toVisibleChatItems(stored.messages))).toEqual([
        { ...projectedTool(messages), result: "Replies shown" },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test.each(["Replies shown", "", '"Refused. No second set."', "  raw text  "])(
    "preserves the ordinary string result %j",
    (content) => {
      expect(projectedTool(conversation(content)).result).toBe(content);
    },
  );

  test.each(["Refused. No second set.", "Error: invalid replies"])(
    "recognizes multipart reply rejection %s",
    (content) => {
      const messages = conversation([
        { type: "text", text: JSON.stringify(content) },
      ]);
      expect(repliesLast(toVisibleChatItems(messages))).toEqual([]);
    },
  );

  test("holds multipart replies until the assistant's words follow", () => {
    const messages = conversation([
      { type: "text", text: "The buttons are held" },
    ]);
    expect(repliesLast(toVisibleChatItems(messages))).toEqual([]);
    messages.push({ id: "answer", role: "assistant", content: "Which first?" });
    expect(
      repliesLast(toVisibleChatItems(messages)).map((item) => item.id),
    ).toEqual(["answer", "call"]);
  });

  test.each(media)("keeps text beside a supported $type part", (part) => {
    const messages = conversation([
      part,
      { type: "text", text: "Replies shown" },
      { type: "text", text: "" },
    ]);
    expect(projectedTool(messages).result).toBe("Replies shown");
    expect(repliesLast(toVisibleChatItems(messages))).toHaveLength(1);
  });

  test.each<{ content: ContentPart[] }>([{ content: [] }, { content: media }])(
    "completes a result with no displayable text",
    ({ content }) => {
      const item = projectedTool(conversation(content, "run_command"));
      expect(item.result).toBe("");
      expect(stepDetails(item)).toMatchObject({
        pending: false,
        failed: false,
      });
    },
  );

  test("preserves JSON split across text parts for browser and page results", () => {
    const content: ContentPart[] = [
      { type: "text", text: '{"ok":true,"title":"Example' },
      {
        type: "text",
        text: ' page","url":"https://example.com/","id":"page-1"}',
      },
    ];
    const browser = projectedTool(conversation(content, "computer_navigate"));
    expect(browserStepDetails(browser)).toMatchObject({
      pending: false,
      visited: true,
      title: "Example page",
      href: "https://example.com/",
    });
    expect(
      repliesLast(toVisibleChatItems(conversation(content, "make_page"))),
    ).toHaveLength(1);
  });

  test("feeds normalized text to grouped tool result consumers", () => {
    const messages = conversation(
      [{ type: "text", text: '"The vendor reported an error: offline"' }],
      "mcp__example__fetch",
    );
    const items = repliesLast(toVisibleChatItems(messages));
    expect(groupToolSteps(items, () => false)).toEqual(items);
    expect(stepDetails(projectedTool(messages))).toMatchObject({
      pending: false,
      failed: true,
      output: "The vendor reported an error: offline",
    });
  });

  test.each(
    [undefined, null, 42, {}, [null, 42, {}, { type: "text", text: 42 }]].map(
      (content) => ({ content }),
    ),
  )("tolerates malformed live result content %j", ({ content }) => {
    const messages = conversation("");
    // The live SDK message array bypasses the stored-history validator.
    messages[1] = {
      id: "result",
      role: "tool",
      toolCallId: "call",
      content,
    } as Message;
    expect(projectedTool(messages).result).toBe("");
    expect(() => repliesLast(toVisibleChatItems(messages))).not.toThrow();
  });

  test("retains valid text beside malformed live parts", () => {
    const messages = conversation("");
    messages[1] = {
      id: "result",
      role: "tool",
      toolCallId: "call",
      content: [
        null,
        { type: "text", text: "Replies shown" },
        { type: "text" },
      ],
    } as unknown as Message;
    expect(projectedTool(messages).result).toBe("Replies shown");
    expect(repliesLast(toVisibleChatItems(messages))).toHaveLength(1);
  });
});
