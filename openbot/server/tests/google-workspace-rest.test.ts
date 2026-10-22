import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { accessFor } from "../src/plugins/access";
import { catalogueEntry } from "../src/plugins/catalogue";
import { callTool, listTools } from "../src/plugins/google-workspace-rest";
import type { McpTool } from "../src/plugins/mcp";
import { transportFor } from "../src/plugins/transport";

/**
 * The Gmail and Calendar REST adapter, asserted without Google.
 *
 * `fetch` is replaced rather than a server started, as in the Drive adapter's tests: what is under
 * test here is the translation, which request each tool becomes and what shape each answer takes.
 * The fake server's own test drives this adapter over a real socket.
 *
 * The result shapes are asserted whole, with `toEqual`, because they are a contract other code reads:
 * a renamed or extra field is a break this file should name.
 */

const connection = { url: "https://www.googleapis.com", token: "test-token" };

const realFetch = globalThis.fetch;

/** Anything this file did not stub is an escape, recorded and asserted empty. See Drive's tests. */
let escapedToNetwork: string[] = [];

beforeEach(() => {
  escapedToNetwork = [];
  globalThis.fetch = (async (input: string | URL): Promise<Response> => {
    escapedToNetwork.push(String(input));
    throw new Error(`unstubbed fetch escaped to the network: ${String(input)}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  expect(escapedToNetwork).toEqual([]);
});

type Seen = {
  method: string;
  url: URL;
  authorization: string | null;
  body: unknown;
};

/**
 * Records every request and answers it with whatever `answer` returns for it: a `Response` as it is,
 * anything else as JSON.
 */
function stubGoogle(answer: (call: Seen) => unknown): Seen[] {
  const calls: Seen[] = [];
  globalThis.fetch = (async (input: string | URL, options?: RequestInit) => {
    const call: Seen = {
      method: options?.method ?? "GET",
      url: new URL(String(input)),
      authorization: new Headers(options?.headers).get("authorization"),
      body: typeof options?.body === "string" ? JSON.parse(options.body) : null,
    };
    calls.push(call);
    const reply = answer(call);
    return reply instanceof Response ? reply : Response.json(reply);
  }) as typeof fetch;
  return calls;
}

const b64url = (bytes: string | Uint8Array) =>
  Buffer.from(bytes).toString("base64url");

/** A Gmail message resource with the given headers, as Gmail's `format=metadata` answers. */
function metadata(
  id: string,
  headers: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ["INBOX", "UNREAD"],
    snippet: "",
    internalDate: "1792656600000",
    payload: {
      mimeType: "text/plain",
      headers: Object.entries(headers).map(([name, value]) => ({
        name,
        value,
      })),
    },
    ...extra,
  };
}

/** A raw RFC 5322 message split into its unfolded headers and its body. */
function parseRaw(raw: string): { headers: Map<string, string>; body: string } {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  const headers = new Map<string, string>();
  for (const line of text
    .slice(0, split)
    .replace(/\r\n[ \t]+/g, " ")
    .split("\r\n")) {
    const colon = line.indexOf(":");
    headers.set(
      line.slice(0, colon).toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }
  return { headers, body: text.slice(split + 4) };
}

/** Arguments a tool will accept, read off its own schema. Arrays get one address. */
function argsFor(tool: McpTool): Record<string, unknown> {
  const required: unknown[] = Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required
    : [];
  const properties = (tool.inputSchema.properties ?? {}) as Record<
    string,
    { type?: string }
  >;
  return Object.fromEntries(
    required.map((name) => [
      String(name),
      properties[String(name)]?.type === "array"
        ? ["given@example.com"]
        : "given",
    ]),
  );
}

/** One body that answers every request every tool makes, for the dispatch checks. */
const anyToolBody = {
  messages: [],
  resultSizeEstimate: 0,
  id: "given",
  threadId: "given",
  payload: {
    headers: [{ name: "Message-ID", value: "<given@example.com>" }],
  },
  items: [],
};

describe("what the adapter offers", () => {
  test("the Gmail and Calendar entry resolves to this adapter", () => {
    const entry = catalogueEntry("google-workspace");
    expect(entry?.transport).toBe("google-workspace-rest");
    // Identity, not shape: the registry wired this module rather than something MCP-shaped.
    expect(
      transportFor(
        accessFor(
          {
            provenance: "first-party",
            url: "https://www.googleapis.com",
            authScheme: null,
          },
          entry,
        ).transport,
      ).callTool,
    ).toBe(callTool);
  });

  test("the tools it advertises are exactly the ones the catalogue classifies", async () => {
    // A tool added here and forgotten there classifies as a write, which is safe and also wrong.
    const entry = catalogueEntry("google-workspace");
    expect(
      (await listTools(connection)).map((tool) => tool.name).sort(),
    ).toEqual(
      [...(entry?.readTools ?? []), ...(entry?.writeTools ?? [])].sort(),
    );
  });

  test("exactly the four tools of the contract, in their contract names", async () => {
    const tools = await listTools(connection);
    expect(tools.map((tool) => tool.name)).toEqual([
      "gmail_search_messages",
      "gmail_read_message",
      "gmail_send_reply",
      "calendar_list_events",
    ]);
  });

  test("every advertised tool is one the dispatcher handles", async () => {
    for (const tool of await listTools(connection)) {
      const calls = stubGoogle(() => anyToolBody);
      const result = await callTool(connection, tool.name, argsFor(tool));
      expect(calls.length).toBeGreaterThan(0);
      expect(result.isError).toBe(false);
      // JSON, every one: other code parses these.
      expect(() => JSON.parse(result.text)).not.toThrow();
    }
  });

  test("a tool the dispatcher does not implement is refused without a request", async () => {
    const calls = stubGoogle(() => anyToolBody);
    const result = await callTool(connection, "gmail_delete_everything", {});
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("a call with no credential never leaves the process", async () => {
    const withoutToken = { url: connection.url };
    for (const tool of await listTools(withoutToken)) {
      const calls = stubGoogle(() => anyToolBody);
      const result = await callTool(withoutToken, tool.name, argsFor(tool));
      expect(calls).toHaveLength(0);
      expect(result.isError).toBe(true);
    }
  });

  test("listing asks nobody, so it needs nothing", async () => {
    expect(await listTools({ url: connection.url })).toEqual(
      await listTools(connection),
    );
    expect(escapedToNetwork).toEqual([]);
  });
});

describe("gmail_search_messages", () => {
  test("with no arguments it asks for the last day of the inbox, twenty-five at a time", async () => {
    const calls = stubGoogle(() => ({ resultSizeEstimate: 0 }));
    const result = await callTool(connection, "gmail_search_messages", {});

    expect(calls).toHaveLength(1);
    const url = calls[0].url;
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/gmail/v1/users/me/messages",
    );
    expect(url.searchParams.get("q")).toBe("in:inbox newer_than:1d");
    expect(url.searchParams.get("maxResults")).toBe("25");
    expect(calls[0].authorization).toBe("Bearer test-token");
    expect(JSON.parse(result.text)).toEqual({
      messages: [],
      resultSizeEstimate: 0,
    });
  });

  test("a query and a count are passed through, and the count is held to fifty", async () => {
    const calls = stubGoogle(() => ({}));
    await callTool(connection, "gmail_search_messages", {
      query: "from:ana@hearthandco.com is:unread",
      maxResults: 10,
    });
    await callTool(connection, "gmail_search_messages", { maxResults: 400 });

    expect(calls[0].url.searchParams.get("q")).toBe(
      "from:ana@hearthandco.com is:unread",
    );
    expect(calls[0].url.searchParams.get("maxResults")).toBe("10");
    expect(calls[1].url.searchParams.get("maxResults")).toBe("50");
  });

  test("a count that is not a number is refused before the network", async () => {
    const calls = stubGoogle(() => ({}));
    for (const maxResults of [0, -3, "lots"]) {
      const result = await callTool(connection, "gmail_search_messages", {
        maxResults,
      });
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  test("each match is looked up for exactly the headers the contract names", async () => {
    const calls = stubGoogle((call) =>
      call.url.pathname.endsWith("/messages")
        ? { messages: [{ id: "m1", threadId: "thread-m1" }] }
        : metadata("m1", { From: "Ana <ana@hearthandco.com>" }),
    );
    await callTool(connection, "gmail_search_messages", {});

    expect(calls).toHaveLength(2);
    expect(calls[1].url.pathname).toBe("/gmail/v1/users/me/messages/m1");
    expect(calls[1].url.searchParams.get("format")).toBe("metadata");
    expect(calls[1].url.searchParams.getAll("metadataHeaders")).toEqual([
      "From",
      "To",
      "Cc",
      "Subject",
      "Date",
      "List-Unsubscribe",
      "Precedence",
      "Auto-Submitted",
      "List-Id",
      "Message-ID",
    ]);
  });

  test("a match comes back in the contract's shape", async () => {
    stubGoogle((call) =>
      call.url.pathname.endsWith("/messages")
        ? {
            messages: [
              { id: "m1", threadId: "thread-m1" },
              { id: "m2", threadId: "thread-m2" },
            ],
            resultSizeEstimate: 2,
          }
        : call.url.pathname.endsWith("/m1")
          ? metadata(
              "m1",
              {
                From: "Ana Pereira <ana@hearthandco.com>",
                To: '"Okafor, Maya" <maya@marlowceramics.com>, sam@marlowceramics.com',
                Cc: "leo@marlowceramics.com",
                Subject: "Friday ship date for the 120 mugs?",
                Date: "Thu, 22 Oct 2026 07:10:00 -0700",
                "Message-ID": "<n01@hearthandco.com>",
              },
              {
                snippet:
                  "Hi Maya, can you confirm it&#39;s Friday &amp; not later?",
              },
            )
          : metadata(
              "m2",
              {
                From: "KilnMart <deals@kilnmart.example>",
                To: "maya@marlowceramics.com",
                Subject: "48 hours only",
                Date: "Thu, 22 Oct 2026 06:00:00 -0700",
                "list-unsubscribe": "<https://kilnmart.example/u>",
                Precedence: "bulk",
              },
              { labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] },
            ),
    );

    const result = await callTool(connection, "gmail_search_messages", {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({
      messages: [
        {
          id: "m1",
          threadId: "thread-m1",
          from: "Ana Pereira <ana@hearthandco.com>",
          // The comma inside the quoted name does not split it.
          to: [
            '"Okafor, Maya" <maya@marlowceramics.com>',
            "sam@marlowceramics.com",
          ],
          cc: ["leo@marlowceramics.com"],
          subject: "Friday ship date for the 120 mugs?",
          date: "2026-10-22T14:10:00.000Z",
          // Gmail escapes its snippets as HTML; a reader is handed the text.
          snippet: "Hi Maya, can you confirm it's Friday & not later?",
          labels: ["INBOX", "UNREAD"],
          headers: {},
        },
        {
          id: "m2",
          threadId: "thread-m2",
          from: "KilnMart <deals@kilnmart.example>",
          to: ["maya@marlowceramics.com"],
          cc: [],
          subject: "48 hours only",
          date: "2026-10-22T13:00:00.000Z",
          snippet: "",
          labels: ["INBOX", "CATEGORY_PROMOTIONS"],
          // Found whatever case the sender wrote it in, reported in the contract's.
          headers: {
            "List-Unsubscribe": "<https://kilnmart.example/u>",
            Precedence: "bulk",
          },
        },
      ],
      resultSizeEstimate: 2,
    });
  });

  test("the group a message came through reaches triage, so mail to a team's security@ is not read as someone else's", async () => {
    stubGoogle((call) =>
      call.url.pathname.endsWith("/messages")
        ? { messages: [{ id: "g1" }] }
        : metadata("g1", {
            To: "security@marlowceramics.com",
            "list-id": "<security.marlowceramics.com>",
          }),
    );
    const result = await callTool(connection, "gmail_search_messages", {});
    expect(JSON.parse(result.text).messages[0].headers).toEqual({
      "List-Id": "<security.marlowceramics.com>",
    });
  });

  test("a date header that does not parse falls back to when Gmail received the message", async () => {
    stubGoogle((call) =>
      call.url.pathname.endsWith("/messages")
        ? { messages: [{ id: "m1" }] }
        : metadata("m1", { Date: "sometime on Thursday" }),
    );
    const result = await callTool(connection, "gmail_search_messages", {});
    expect(JSON.parse(result.text).messages[0].date).toBe(
      new Date(1792656600000).toISOString(),
    );
  });

  test("a message deleted between the listing and its lookup is skipped, not a failed search", async () => {
    stubGoogle((call) =>
      call.url.pathname.endsWith("/messages")
        ? { messages: [{ id: "gone" }, { id: "here" }], resultSizeEstimate: 2 }
        : call.url.pathname.endsWith("/gone")
          ? Response.json(
              {
                error: {
                  code: 404,
                  message: "Requested entity was not found.",
                },
              },
              { status: 404 },
            )
          : metadata("here", { Subject: "still here" }),
    );
    const result = await callTool(connection, "gmail_search_messages", {});
    expect(result.isError).toBe(false);
    expect(
      JSON.parse(result.text).messages.map((m: { id: string }) => m.id),
    ).toEqual(["here"]);
  });

  test("any other refusal during the lookups fails the search, and says why", async () => {
    stubGoogle((call) =>
      call.url.pathname.endsWith("/messages")
        ? { messages: [{ id: "m1" }] }
        : Response.json(
            { error: { code: 429, message: "Quota exceeded" } },
            { status: 429 },
          ),
    );
    const result = await callTool(connection, "gmail_search_messages", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("429");
    expect(result.text).toContain("Wait a minute");
  });
});

describe("gmail_read_message", () => {
  /** A full-format message, with `payload` as given. */
  const full = (payload: Record<string, unknown>) => ({
    id: "m1",
    threadId: "thread-m1",
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "From", value: "Ana Pereira <ana@hearthandco.com>" },
        { name: "To", value: "maya@marlowceramics.com" },
        { name: "Subject", value: "=?UTF-8?B?Q2Fmw6kgb3JkZXI=?=" },
        { name: "Date", value: "Thu, 22 Oct 2026 07:10:00 -0700" },
        { name: "Message-Id", value: "<n01.abc@hearthandco.com>" },
        { name: "Auto-Submitted", value: "auto-generated" },
      ],
      ...payload,
    },
  });

  test("asks for the full message and answers in the contract's shape", async () => {
    const calls = stubGoogle(() =>
      full({
        mimeType: "text/plain",
        body: { data: b64url("Hi Maya,\r\nFriday still works?\r\n") },
      }),
    );
    const result = await callTool(connection, "gmail_read_message", {
      id: "m1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/gmail/v1/users/me/messages/m1");
    expect(calls[0].url.searchParams.get("format")).toBe("full");
    expect(JSON.parse(result.text)).toEqual({
      id: "m1",
      threadId: "thread-m1",
      from: "Ana Pereira <ana@hearthandco.com>",
      to: ["maya@marlowceramics.com"],
      cc: [],
      // An RFC 2047 subject is shown as the words it encodes.
      subject: "Café order",
      date: "2026-10-22T14:10:00.000Z",
      labels: ["INBOX"],
      headers: { "Auto-Submitted": "auto-generated" },
      // The header is found whatever case the sender spelled it in.
      messageId: "<n01.abc@hearthandco.com>",
      body: "Hi Maya,\nFriday still works?",
    });
    expect(result.truncated).toBe(false);
  });

  test("a body in another charset is decoded in that charset", async () => {
    // "Café, señor" in ISO-8859-1: é is 0xE9 and ñ is 0xF1, neither of them valid UTF-8 alone.
    const latin1 = Uint8Array.from([
      0x43, 0x61, 0x66, 0xe9, 0x2c, 0x20, 0x73, 0x65, 0xf1, 0x6f, 0x72,
    ]);
    stubGoogle(() =>
      full({
        mimeType: "text/plain",
        headers: [
          { name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' },
        ],
        body: { data: b64url(latin1) },
      }),
    );
    const result = await callTool(connection, "gmail_read_message", {
      id: "m1",
    });
    expect(JSON.parse(result.text).body).toBe("Café, señor");
  });

  test("the plain-text part is preferred, and an attached text file is not the body", async () => {
    stubGoogle(() =>
      full({
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "text/plain",
            filename: "notes.txt",
            body: { data: b64url("an attachment, not the message") },
          },
          {
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/plain",
                body: { data: b64url("the plain words") },
              },
              {
                mimeType: "text/html",
                body: { data: b64url("<p>the html words</p>") },
              },
            ],
          },
        ],
      }),
    );
    const result = await callTool(connection, "gmail_read_message", {
      id: "m1",
    });
    expect(JSON.parse(result.text).body).toBe("the plain words");
  });

  test("an HTML-only message is read as its text", async () => {
    stubGoogle(() =>
      full({
        mimeType: "text/html",
        body: {
          data: b64url(
            "<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;Maya,</p><p>Fish &amp; chips &lt;b&gt; on <b>Friday</b>?<br>Thanks</p><script>track()</script></body></html>",
          ),
        },
      }),
    );
    const result = await callTool(connection, "gmail_read_message", {
      id: "m1",
    });
    // The escaped `&lt;b&gt;` stays text; the real <b> tag is gone.
    expect(JSON.parse(result.text).body).toBe(
      "Hi Maya,\nFish & chips <b> on Friday?\nThanks",
    );
  });

  test("a long body is cut at twenty thousand characters, says so, and stays valid JSON", async () => {
    stubGoogle(() =>
      full({
        mimeType: "text/plain",
        body: { data: b64url("x".repeat(50_000)) },
      }),
    );
    const result = await callTool(connection, "gmail_read_message", {
      id: "m1",
    });
    const body: string = JSON.parse(result.text).body;
    expect(body.length).toBe(20_000);
    expect(body.endsWith("[truncated: the message is longer than this]")).toBe(
      true,
    );
    expect(result.truncated).toBe(true);
  });

  test("an id is required, and nothing is requested without one", async () => {
    const calls = stubGoogle(() => ({}));
    const result = await callTool(connection, "gmail_read_message", {});
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("gmail_send_reply", () => {
  const parent = (headers: Record<string, string>) => ({
    id: "orig1",
    threadId: "t1",
    payload: {
      headers: Object.entries(headers).map(([name, value]) => ({
        name,
        value,
      })),
    },
  });

  /** The parent's ids for a lookup, Gmail's acknowledgement for the send. */
  function stubReply(parentHeaders: Record<string, string>) {
    return stubGoogle((call) =>
      call.method === "POST"
        ? { id: "sent1", threadId: "t1", labelIds: ["SENT"] }
        : parent(parentHeaders),
    );
  }

  const reply = {
    threadId: "t1",
    inReplyTo: "orig1",
    to: ["Ana Pereira <ana@hearthandco.com>"],
    cc: ["sam@marlowceramics.com"],
    subject: "Friday ship date for the 120 mugs?",
    body: "Hi Ana,\nYes, Friday.\nMaya",
  };

  test("reads the parent's ids, then sends a threaded reply as base64url", async () => {
    const calls = stubReply({
      "Message-ID": "<n01@hearthandco.com>",
      References: "<earlier@hearthandco.com>",
    });
    const result = await callTool(connection, "gmail_send_reply", reply);

    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname).toBe("/gmail/v1/users/me/messages/orig1");
    expect(calls[0].url.searchParams.get("format")).toBe("metadata");
    expect(calls[0].url.searchParams.getAll("metadataHeaders")).toEqual([
      "Message-ID",
      "References",
      "In-Reply-To",
    ]);

    expect(calls[1].method).toBe("POST");
    expect(calls[1].url.pathname).toBe("/gmail/v1/users/me/messages/send");
    const sent = calls[1].body as { raw: string; threadId: string };
    expect(sent.threadId).toBe("t1");
    // base64url: no characters outside its alphabet, so it survives a JSON body and a URL alike.
    expect(sent.raw).toMatch(/^[A-Za-z0-9_-]+$/);

    const { headers, body } = parseRaw(sent.raw);
    expect(headers.get("to")).toBe("Ana Pereira <ana@hearthandco.com>");
    expect(headers.get("cc")).toBe("sam@marlowceramics.com");
    expect(headers.get("subject")).toBe(
      "Re: Friday ship date for the 120 mugs?",
    );
    expect(headers.get("in-reply-to")).toBe("<n01@hearthandco.com>");
    expect(headers.get("references")).toBe(
      "<earlier@hearthandco.com> <n01@hearthandco.com>",
    );
    expect(headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(headers.get("content-transfer-encoding")).toBe("base64");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe(
      "Hi Ana,\r\nYes, Friday.\r\nMaya",
    );

    expect(JSON.parse(result.text)).toEqual({
      sent: true,
      id: "sent1",
      threadId: "t1",
    });
  });

  test("a subject that already says Re: is not prefixed again, and no Cc means no Cc header", async () => {
    const calls = stubReply({ "Message-ID": "<n01@hearthandco.com>" });
    await callTool(connection, "gmail_send_reply", {
      ...reply,
      cc: undefined,
      subject: "RE: Friday ship date",
    });
    const { headers } = parseRaw((calls[1].body as { raw: string }).raw);
    expect(headers.get("subject")).toBe("RE: Friday ship date");
    expect(headers.has("cc")).toBe(false);
    // No chain on the parent, so the chain is the parent alone.
    expect(headers.get("references")).toBe("<n01@hearthandco.com>");
  });

  test("a parent with no References chains from its In-Reply-To", async () => {
    const calls = stubReply({
      "Message-ID": "<n02@hearthandco.com>",
      "In-Reply-To": "<n01@marlowceramics.com>",
    });
    await callTool(connection, "gmail_send_reply", reply);
    const { headers } = parseRaw((calls[1].body as { raw: string }).raw);
    expect(headers.get("references")).toBe(
      "<n01@marlowceramics.com> <n02@hearthandco.com>",
    );
  });

  test("a subject or name outside ASCII is encoded, and decodes back to what was written", async () => {
    const calls = stubReply({ "Message-ID": "<n01@hearthandco.com>" });
    await callTool(connection, "gmail_send_reply", {
      ...reply,
      to: ["Zoë Ångström <zoe@example.com>"],
      subject: "Glaze café ☕",
    });
    const { headers } = parseRaw((calls[1].body as { raw: string }).raw);
    const decode = (value: string) =>
      value
        .replace(/\?=\s+=\?/g, "?==?")
        .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, data: string) =>
          Buffer.from(data, "base64").toString("utf8"),
        );
    expect(headers.get("subject")).toMatch(/^=\?UTF-8\?B\?/);
    expect(decode(headers.get("subject") ?? "")).toBe("Re: Glaze café ☕");
    expect(decode(headers.get("to") ?? "")).toBe(
      "Zoë Ångström <zoe@example.com>",
    );
  });

  /*
   * HEADER INJECTION. A line break in a recipient or the subject ends that header and starts another
   * one, so a reply approved to one person carries a Bcc nobody saw. Refused before anything at all
   * is requested, so not even the parent is fetched for a call that will never be sent.
   */
  test("a line break in a recipient or the subject is refused before any request", async () => {
    for (const poisoned of [
      { subject: "Hello\r\nBcc: everyone@example.com" },
      { subject: "Hello\nBcc: everyone@example.com" },
      { to: ["ana@hearthandco.com\r\nBcc: everyone@example.com"] },
      { cc: ["sam@marlowceramics.com\nBcc: everyone@example.com"] },
      { to: ["ana@hearthandco.com\u2028Bcc: everyone@example.com"] },
    ]) {
      const calls = stubReply({ "Message-ID": "<n01@hearthandco.com>" });
      const result = await callTool(connection, "gmail_send_reply", {
        ...reply,
        ...poisoned,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("line break");
      expect(calls).toHaveLength(0);
    }
  });

  test("a reply missing a part it needs is refused before any request", async () => {
    for (const missing of [
      { threadId: undefined },
      { inReplyTo: undefined },
      { to: [] },
      { to: "not a list" as unknown as string[] },
      { to: [42] as unknown as string[] },
      { to: ["no address here"] },
      { subject: "" },
      { body: "   " },
    ]) {
      const calls = stubReply({ "Message-ID": "<n01@hearthandco.com>" });
      const result = await callTool(connection, "gmail_send_reply", {
        ...reply,
        ...missing,
      });
      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
    }
  });

  test("a parent in a different thread is refused, and nothing is sent", async () => {
    const calls = stubGoogle((call) =>
      call.method === "POST"
        ? { id: "sent1", threadId: "t1" }
        : { ...parent({ "Message-ID": "<n01@x.com>" }), threadId: "t9" },
    );
    const result = await callTool(connection, "gmail_send_reply", reply);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("t9");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  test("a parent with no Message-ID is refused, and nothing is sent", async () => {
    const calls = stubReply({ Subject: "no id here" });
    const result = await callTool(connection, "gmail_send_reply", reply);
    expect(result.isError).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });
});

describe("calendar_list_events", () => {
  const CALENDAR_RESOURCE = "/calendar/v3/calendars/primary";
  const EVENTS_PATH = `${CALENDAR_RESOURCE}/events`;

  /**
   * Calendar as Google answers it: the primary calendar's resource naming `timeZone` (or `calendar`,
   * when given as a Response, verbatim), and its events filtered by Google's own bounds, timeMin
   * against an event's end and timeMax against its start, so a window that is too short loses the
   * event here as it would there.
   */
  function stubCalendar(
    calendar: string | Response,
    events: {
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
      [field: string]: unknown;
    }[] = [],
  ): Seen[] {
    return stubGoogle((call) => {
      if (call.url.pathname === CALENDAR_RESOURCE) {
        return typeof calendar === "string"
          ? {
              kind: "calendar#calendar",
              id: "maya@marlowceramics.com",
              summary: "maya@marlowceramics.com",
              timeZone: calendar,
            }
          : calendar;
      }
      expect(call.url.pathname).toBe(EVENTS_PATH);
      const min = Date.parse(call.url.searchParams.get("timeMin") ?? "");
      const max = Date.parse(call.url.searchParams.get("timeMax") ?? "");
      const at = (time: { dateTime?: string; date?: string }) =>
        Date.parse(time.dateTime ?? `${time.date}T00:00:00Z`);
      return {
        items: events.filter(
          (event) => at(event.end) > min && at(event.start) < max,
        ),
      };
    });
  }

  /** The window the events request asked for, as UTC ISO. */
  const windowOf = (calls: Seen[]) => {
    const listing = calls.find((call) => call.url.pathname === EVENTS_PATH);
    return {
      timeMin: listing?.url.searchParams.get("timeMin"),
      timeMax: listing?.url.searchParams.get("timeMax"),
    };
  };

  /** Runs `body` with the clock reading `at`, and puts the clock back however it ends. */
  async function at<T>(instant: string, body: () => Promise<T>): Promise<T> {
    setSystemTime(new Date(instant));
    try {
      return await body();
    } finally {
      setSystemTime();
    }
  }

  test("with no arguments it reads the calendar's zone, then asks for now until midnight there, in start order", async () => {
    // 13:00 in California, when the UTC day has four hours left and the person's has eleven.
    const calls = stubCalendar("America/Los_Angeles", [
      {
        id: "mugs",
        start: { dateTime: "2026-10-22T17:30:00-07:00" },
        end: { dateTime: "2026-10-22T18:00:00-07:00" },
      },
      {
        id: "tomorrow",
        start: { dateTime: "2026-10-23T09:00:00-07:00" },
        end: { dateTime: "2026-10-23T09:30:00-07:00" },
      },
    ]);
    const result = await at("2026-10-22T20:00:00Z", () =>
      callTool(connection, "calendar_list_events", {}),
    );

    expect(calls.map((call) => call.url.origin + call.url.pathname)).toEqual([
      "https://www.googleapis.com/calendar/v3/calendars/primary",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    ]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls[0].authorization).toBe("Bearer test-token");
    expect(windowOf(calls)).toEqual({
      timeMin: "2026-10-22T20:00:00.000Z",
      // Midnight in Los Angeles, not the 17:00 the UTC day ends at.
      timeMax: "2026-10-23T07:00:00.000Z",
    });
    const params = calls[1].url.searchParams;
    expect(params.get("singleEvents")).toBe("true");
    expect(params.get("orderBy")).toBe("startTime");
    expect(params.get("maxResults")).toBe("25");

    const parsed = JSON.parse(result.text);
    expect(parsed.timeZone).toBe("America/Los_Angeles");
    expect(Object.keys(parsed)).not.toContain("note");
    expect(parsed.events.map((event: { id: string }) => event.id)).toEqual([
      "mugs",
    ]);
  });

  test("east of UTC, today ends at local midnight and does not run on into tomorrow morning", async () => {
    // 20:00 in Tokyo, when the UTC day runs on until 09:00 tomorrow there.
    const calls = stubCalendar("Asia/Tokyo", [
      {
        id: "dinner",
        start: { dateTime: "2026-10-22T21:30:00+09:00" },
        end: { dateTime: "2026-10-22T22:30:00+09:00" },
      },
      {
        id: "tomorrow-standup",
        start: { dateTime: "2026-10-23T08:00:00+09:00" },
        end: { dateTime: "2026-10-23T08:15:00+09:00" },
      },
    ]);
    const result = await at("2026-10-22T11:00:00Z", () =>
      callTool(connection, "calendar_list_events", {}),
    );

    expect(windowOf(calls)).toEqual({
      timeMin: "2026-10-22T11:00:00.000Z",
      timeMax: "2026-10-22T15:00:00.000Z",
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.timeZone).toBe("Asia/Tokyo");
    expect(parsed.events.map((event: { id: string }) => event.id)).toEqual([
      "dinner",
    ]);
  });

  test("on a day the clocks change, today is 23 or 25 hours long and still ends at midnight", async () => {
    const cases = [
      // Clocks go forward at 02:00 on 8 March: from 00:30 PST to midnight PDT.
      [
        "America/Los_Angeles",
        "2026-03-08T00:30:00-08:00",
        "2026-03-09T07:00:00.000Z",
      ],
      // Clocks go back at 02:00 on 1 November: from 00:30 PDT to midnight PST.
      [
        "America/Los_Angeles",
        "2026-11-01T00:30:00-07:00",
        "2026-11-02T08:00:00.000Z",
      ],
      // Europe's clocks go back on 25 October, east of UTC.
      [
        "Europe/Berlin",
        "2026-10-25T00:30:00+02:00",
        "2026-10-25T23:00:00.000Z",
      ],
      // Chile's go forward at midnight itself, so 5 September ends when they jump to 01:00 on the 6th.
      [
        "America/Santiago",
        "2026-09-05T20:00:00-04:00",
        "2026-09-06T04:00:00.000Z",
      ],
    ];
    for (const [timeZone, timeMin, timeMax] of cases) {
      const calls = stubCalendar(timeZone);
      const result = await callTool(connection, "calendar_list_events", {
        timeMin,
      });
      expect(windowOf(calls).timeMax).toBe(timeMax);
      expect(JSON.parse(result.text).timeZone).toBe(timeZone);
    }
  });

  test("a time zone that cannot be read falls back to the UTC day, and the result says so", async () => {
    const lateEvening = {
      id: "late",
      start: { dateTime: "2026-10-22T17:30:00-07:00" },
      end: { dateTime: "2026-10-22T18:00:00-07:00" },
    };
    for (const calendar of [
      Response.json(
        {
          error: {
            code: 403,
            message: "Request had insufficient authentication scopes.",
          },
        },
        { status: 403 },
      ),
      Response.json({ kind: "calendar#calendar", id: "primary" }),
      Response.json({ kind: "calendar#calendar", timeZone: "Mars/Olympus" }),
    ]) {
      const calls = stubCalendar(calendar, [lateEvening]);
      const result = await at("2026-10-22T20:00:00Z", () =>
        callTool(connection, "calendar_list_events", {}),
      );

      expect(result.isError).toBe(false);
      expect(windowOf(calls)).toEqual({
        timeMin: "2026-10-22T20:00:00.000Z",
        timeMax: "2026-10-23T00:00:00.000Z",
      });
      const parsed = JSON.parse(result.text);
      expect(parsed.timeZone).toBe("UTC");
      expect(parsed.note).toStartWith(
        "Your calendar's time zone could not be read, so today was taken to end at midnight UTC.",
      );
      // The short day is the one the note warns of: the evening is outside it.
      expect(parsed.events).toEqual([]);
    }
  });

  test("the reason the zone could not be read is in the note", async () => {
    stubCalendar(
      Response.json({ kind: "calendar#calendar", timeZone: "Mars/Olympus" }),
    );
    const result = await callTool(connection, "calendar_list_events", {});
    expect(JSON.parse(result.text).note).toContain(
      '"Mars/Olympus" is not a time zone this server knows.',
    );
  });

  test("a given timeMax is sent as given, without reading the zone", async () => {
    const calls = stubCalendar("America/Los_Angeles", [
      {
        id: "e1",
        start: { dateTime: "2026-10-22T17:30:00-07:00" },
        end: { dateTime: "2026-10-22T18:00:00-07:00" },
      },
    ]);
    const result = await callTool(connection, "calendar_list_events", {
      timeMin: "2026-10-22T13:00:00-07:00",
      timeMax: "2026-10-22T17:00:00-07:00",
      maxResults: 99,
    });

    expect(calls.map((call) => call.url.pathname)).toEqual([EVENTS_PATH]);
    const params = calls[0].url.searchParams;
    expect(params.get("timeMin")).toBe("2026-10-22T20:00:00.000Z");
    expect(params.get("timeMax")).toBe("2026-10-23T00:00:00.000Z");
    expect(params.get("maxResults")).toBe("50");
    // No default was applied, so there is no zone to name.
    expect(JSON.parse(result.text)).toEqual({ events: [] });
  });

  test("bounds that do not parse, or that close before they open, are refused before the network", async () => {
    const calls = stubGoogle(() => ({ items: [] }));
    for (const args of [
      { timeMin: "after lunch" },
      { timeMax: "whenever" },
      {
        timeMin: "2026-10-23T09:00:00Z",
        timeMax: "2026-10-23T08:00:00Z",
      },
    ]) {
      const result = await callTool(connection, "calendar_list_events", args);
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  test("events come back in the contract's shape, under the zone the default used", async () => {
    stubCalendar("America/Los_Angeles", [
      {
        id: "e1",
        summary: "Glaze test review",
        status: "confirmed",
        location: "Glaze room",
        start: { dateTime: "2026-10-22T10:00:00-07:00" },
        end: { dateTime: "2026-10-22T10:45:00-07:00" },
        organizer: { email: "maya@marlowceramics.com" },
        attendees: [
          { email: "maya@marlowceramics.com", self: true },
          { email: "leo@marlowceramics.com" },
        ],
      },
      {
        id: "e2",
        status: "tentative",
        start: { date: "2026-10-22" },
        end: { date: "2026-10-23" },
      },
    ]);
    const result = await at("2026-10-22T08:00:00-07:00", () =>
      callTool(connection, "calendar_list_events", {}),
    );
    expect(JSON.parse(result.text)).toEqual({
      timeZone: "America/Los_Angeles",
      events: [
        {
          id: "e1",
          summary: "Glaze test review",
          start: "2026-10-22T10:00:00-07:00",
          end: "2026-10-22T10:45:00-07:00",
          location: "Glaze room",
          organizer: "maya@marlowceramics.com",
          attendees: ["maya@marlowceramics.com", "leo@marlowceramics.com"],
          status: "confirmed",
        },
        {
          id: "e2",
          // Untitled, as Google's own calendar calls it, and an all-day date kept a date.
          summary: "(no title)",
          start: "2026-10-22",
          end: "2026-10-23",
          attendees: [],
          status: "tentative",
        },
      ],
    });
    // Absent rather than present-and-empty, so `"location" in event` means there is one.
    expect(Object.keys(JSON.parse(result.text).events[1])).not.toContain(
      "location",
    );
  });
});

/*
 * Errors are read by the person who has to act on them, so each one says whose move it is. Google's
 * own sentence is kept in every case, because for a disabled API it is the one naming the console URL.
 */
describe("a refusal says what to do about it", () => {
  const refuse = (status: number, error: Record<string, unknown>) =>
    stubGoogle(() => Response.json({ error }, { status }));

  test("401: reconnect", async () => {
    refuse(401, { code: 401, message: "Request had invalid credentials." });
    const result = await callTool(connection, "gmail_search_messages", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Gmail refused this request (401)");
    expect(result.text).toContain("Request had invalid credentials.");
    expect(result.text).toContain("Reconnecting");
  });

  test("403 for a disabled API names the service to enable, per product", async () => {
    refuse(403, {
      code: 403,
      message:
        "Gmail API has not been used in project 123 before or it is disabled.",
      errors: [{ reason: "accessNotConfigured" }],
    });
    const gmail = await callTool(connection, "gmail_read_message", {
      id: "m1",
    });
    expect(gmail.text).toContain("has not been used in project 123");
    expect(gmail.text).toContain("gmail.googleapis.com");

    refuse(403, {
      code: 403,
      message: "Calendar usage is off for this project.",
      details: [{ reason: "SERVICE_DISABLED" }],
    });
    const calendar = await callTool(connection, "calendar_list_events", {});
    expect(calendar.text).toContain("Google Calendar refused this request");
    // Calendar's service name is not the obvious one, which is why it is spelled out.
    expect(calendar.text).toContain("calendar-json.googleapis.com");
  });

  test("403 for a missing scope: reconnect and allow everything", async () => {
    refuse(403, {
      code: 403,
      message: "Request had insufficient authentication scopes.",
      details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
    });
    const result = await callTool(connection, "gmail_send_reply", {
      threadId: "t1",
      inReplyTo: "m1",
      to: ["ana@hearthandco.com"],
      subject: "Hi",
      body: "Hello",
    });
    expect(result.text).toContain("allowing every permission");
  });

  test("404: the id is not in this mailbox", async () => {
    refuse(404, { code: 404, message: "Requested entity was not found." });
    const result = await callTool(connection, "gmail_read_message", {
      id: "nope",
    });
    expect(result.text).toContain("(404)");
    expect(result.text).toContain("No message with that id");
  });

  test("429, and a 403 that is really a rate limit: wait", async () => {
    refuse(429, { code: 429, message: "Too many requests." });
    expect(
      (await callTool(connection, "calendar_list_events", {})).text,
    ).toContain("Wait a minute");

    refuse(403, {
      code: 403,
      message: "User rate limit exceeded.",
      errors: [{ reason: "userRateLimitExceeded" }],
    });
    expect(
      (await callTool(connection, "gmail_search_messages", {})).text,
    ).toContain("Wait a minute");
  });

  test("a refusal that is not JSON still names its status", async () => {
    stubGoogle(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const result = await callTool(connection, "gmail_search_messages", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Gmail refused this request (502).");
  });

  test("a 200 that is not JSON is a sentence, not a crash", async () => {
    stubGoogle(() => new Response("<html>captive portal</html>"));
    const result = await callTool(connection, "calendar_list_events", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not JSON");
  });

  test("an unreachable Google says so", async () => {
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND www.googleapis.com");
    }) as unknown as typeof fetch;
    const result = await callTool(connection, "gmail_search_messages", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Gmail could not be reached");
  });
});
