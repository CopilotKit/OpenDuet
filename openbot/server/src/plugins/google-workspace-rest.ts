import { cutAtCodeUnits } from "../channels/text";
import type { McpCallResult, McpTool } from "./mcp";

/**
 * Gmail and Google Calendar, reached over their ordinary REST APIs.
 *
 * WHY REST AND NOT MCP. The same reason as {@link ./google-drive-rest}: Google's hosted Workspace MCP
 * servers are gated behind the Workspace Developer Preview Program, and the REST APIs underneath are
 * generally available. This module implements the interface {@link ./mcp} already had, `listTools`
 * and `callTool` with the same shapes, so it is chosen per catalogue entry exactly as Drive's is.
 *
 * WHY ONE MODULE FOR TWO PRODUCTS. They are one catalogue entry, for reasons given there: one Google
 * OAuth client, one consent, one grant to revoke. Both APIs live on `www.googleapis.com`, under
 * different version prefixes, so the connection's url is the bare host and the two prefixes below are
 * this code's, never a caller's.
 *
 * WHY JSON. Unlike Drive's lines of prose, every result here is a JSON object with a fixed shape,
 * because OpenDuet's own code reads them as well as models do: triage parses a search, a brief reads
 * the calendar. Those shapes are a contract; renaming a field breaks a reader nothing here can see.
 * For the same reason a result is never cut mid-structure the way a prose result is, since half a
 * JSON object parses as nothing. Size is bounded by its inputs instead: at most fifty messages or
 * events, header values cut at {@link HEADER_MAX_CHARS}, and a message body cut at
 * {@link BODY_MAX_CHARS} with a marker saying so.
 *
 * ONE WRITE. `gmail_send_reply` sends mail as the person, so the catalogue names it a write and the
 * approval gate looks at every call before it reaches this module. It replies within an existing
 * thread only: there is no tool here that writes to somebody who has not written first.
 */

/** Long enough for a slow mailbox, short enough that a Bot's turn is not held open on it. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Both products' prefixes, on the one host the catalogue pins. */
const GMAIL = "/gmail/v1/users/me";
const CALENDAR = "/calendar/v3/calendars/primary";

/** What "my mail" means when nobody said: what arrived in the inbox in the last day. */
const DEFAULT_QUERY = "in:inbox newer_than:1d";
const DEFAULT_MAX_RESULTS = 25;
/** Beyond this a listing is a mailbox dump rather than an answer, and each message is one request. */
const MAX_RESULTS = 50;

/** The longest body a result carries, marker included. */
const BODY_MAX_CHARS = 20_000;
const BODY_CUT_MARKER = "\n\n[truncated: the message is longer than this]";

/**
 * The longest header value kept. RFC 5322 caps a line at 998 characters; a value longer than that is
 * folded abuse, and a sender should not be able to fill a reader's context through a header.
 */
const HEADER_MAX_CHARS = 1_000;

/**
 * Fetched in parallel, but not all at once. Gmail meters each user per second, and fifty lookups
 * fired together spend a whole second's quota on one search.
 */
const LOOKUP_CONCURRENCY = 8;

/**
 * The headers a search asks for. The last five are what triage reads to tell bulk and automatic mail
 * from a person writing: RFC 2369's unsubscribe link, the old `Precedence: bulk`, RFC 3834's
 * `Auto-Submitted`, and RFC 2919's `List-Id`, which names the group a message came through so mail
 * to a team's security@ group is not read as somebody else's.
 */
const METADATA_HEADERS = [
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
] as const;

/** Passed through by name, and only when the message carries them. */
const PASSED_HEADERS = [
  "List-Unsubscribe",
  "Precedence",
  "Auto-Submitted",
  "List-Id",
] as const;

/**
 * What this adapter offers. Static, as Drive's list is: the dispatcher below handles exactly these,
 * and the two are kept adjacent so one cannot change without the other being in view.
 */
const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "gmail_search_messages",
    description:
      "Search your Gmail with Gmail's own search syntax and get each matching message's sender, recipients, subject, date, snippet, labels and the headers that mark bulk, group or automatic mail. Defaults to the last day of the inbox. Returns JSON.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: `Gmail search syntax, for example "from:ana@hearthandco.com is:unread". Defaults to "${DEFAULT_QUERY}".`,
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RESULTS,
          description: `How many messages to return, newest first. Defaults to ${DEFAULT_MAX_RESULTS}, at most ${MAX_RESULTS}.`,
        },
      },
    },
  },
  {
    name: "gmail_read_message",
    description:
      "Read one Gmail message by its id, including its text and its Message-ID. Returns JSON.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The message's Gmail id, as a search returned it.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "gmail_send_reply",
    description:
      "Send a plain-text reply in an existing Gmail thread, as you. It is threaded under the message being answered. Returns JSON.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "The Gmail thread id of the message being answered.",
        },
        inReplyTo: {
          type: "string",
          description:
            "The Gmail id of the message being answered: the `id` that gmail_search_messages or gmail_read_message returned. Its Message-ID header (`messageId`, in angle brackets) is accepted too.",
        },
        to: {
          type: "array",
          items: { type: "string" },
          description: 'Recipients, each "Name <address>" or a bare address.',
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description: "Copied recipients, in the same form.",
        },
        subject: {
          type: "string",
          description:
            'The subject. "Re: " is added unless it is already there.',
        },
        body: { type: "string", description: "The reply, as plain text." },
      },
      required: ["threadId", "inReplyTo", "to", "subject", "body"],
    },
  },
  {
    name: "calendar_list_events",
    description:
      "List the events on your primary Google Calendar between two times, in start order, with recurring events expanded. Defaults to now until midnight in your calendar's time zone. Returns JSON; when the default is used, it names that time zone.",
    inputSchema: {
      type: "object",
      properties: {
        timeMin: {
          type: "string",
          description:
            "The earliest end time to include, as an ISO 8601 date-time. Defaults to now.",
        },
        timeMax: {
          type: "string",
          description:
            "The latest start time to include, as an ISO 8601 date-time. Defaults to midnight at the end of timeMin's day in your calendar's time zone.",
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RESULTS,
          description: `How many events to return. Defaults to ${DEFAULT_MAX_RESULTS}, at most ${MAX_RESULTS}.`,
        },
      },
    },
  },
]);

type Connection = { url: string; token?: string };

/** The answer is this file, so nobody's credential is needed to read it. See Drive's adapter. */
export const listNeedsCredential = false;

/** The same list for everybody, because this adapter's capability is this code. */
export async function listTools(_connection: Connection): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

type Product = "Gmail" | "Google Calendar";

/**
 * Each API by the name Google's console lists it under, and the service an administrator enables.
 * Calendar's service name is not the obvious one, which is why it is written down rather than
 * derived.
 */
const SERVICE: Record<Product, { api: string; service: string }> = {
  Gmail: { api: "the Gmail API", service: "gmail.googleapis.com" },
  "Google Calendar": {
    api: "the Google Calendar API",
    service: "calendar-json.googleapis.com",
  },
};

/** A failure carries Google's status when there was one, so a caller can tell a 404 from the rest. */
type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; status?: number };

/**
 * One request to Google, with the caller's own token, answered as JSON.
 *
 * `token` is typed optional by the shared connection shape and is never absent in practice, because
 * the store refuses a `user-oauth` call with nobody's credential first. A missing one is named here
 * rather than sent as `Bearer undefined`, which Google answers with a 401 about something else.
 */
async function request<T>(
  connection: Connection,
  product: Product,
  path: string,
  init: {
    query?: Record<string, string | readonly string[]>;
    json?: unknown;
  } = {},
): Promise<Outcome<T>> {
  if (!connection.token) {
    return { ok: false, message: "No credential was available for this call." };
  }

  const url = new URL(`${connection.url.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    // Repeated rather than joined: `metadataHeaders` is one header per parameter.
    for (const each of typeof value === "string" ? [value] : value) {
      url.searchParams.append(key, each);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.json === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(init.json === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === "TimeoutError"
          ? `${product} did not answer in time.`
          : `${product} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      message: refusal(product, response.status, body),
      status: response.status,
    };
  }

  /*
   * A 200 is not a promise of JSON: a proxy's interstitial answers 200 with HTML. Read defensively,
   * so that is a sentence rather than a SyntaxError quoting somebody's page.
   */
  const value = (await response.json().catch(() => undefined)) as T | undefined;
  if (value === undefined || value === null || typeof value !== "object") {
    return {
      ok: false,
      message: `${product} answered with something that is not JSON.`,
    };
  }
  return { ok: true, value };
}

/**
 * Google's refusal, in Google's words, followed by what to do about it.
 *
 * Google's own sentence is kept for the reason Drive keeps it: for a disabled API it names the API
 * and the console URL. The hint after it is ours, because the status alone does not say whose move it
 * is: a 401 is the person's (reconnect), a disabled API is the administrator's, a 429 is nobody's
 * (wait). Google marks which 403 it is in `errors[].reason` (the older shape) and in
 * `details[].reason` (the newer `ErrorInfo`), and both are read since either may be the one present.
 */
function refusal(product: Product, status: number, body: string): string {
  let detail = "";
  const reasons: string[] = [];
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: unknown;
        errors?: { reason?: unknown }[];
        details?: { reason?: unknown }[];
      };
    };
    if (typeof parsed.error?.message === "string")
      detail = parsed.error.message;
    for (const item of [
      ...(Array.isArray(parsed.error?.errors) ? parsed.error.errors : []),
      ...(Array.isArray(parsed.error?.details) ? parsed.error.details : []),
    ]) {
      if (typeof item?.reason === "string") reasons.push(item.reason);
    }
  } catch {
    // Not JSON. The status alone is still worth saying.
  }

  const said = detail
    ? `${product} refused this request (${status}): ${detail}`
    : `${product} refused this request (${status}).`;
  const hint = hintFor(product, status, reasons, detail);
  return hint ? `${said} ${hint}` : said;
}

function hintFor(
  product: Product,
  status: number,
  reasons: readonly string[],
  detail: string,
): string | null {
  const { api, service } = SERVICE[product];
  const has = (...names: string[]) =>
    reasons.some((reason) => names.includes(reason));

  if (status === 401) {
    return "Google did not accept this person's access. Reconnecting Gmail and Google Calendar on the Connections page usually fixes it.";
  }
  if (
    status === 429 ||
    has("rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED")
  ) {
    return "Google is limiting how fast this account can be read. Wait a minute and try again.";
  }
  if (status === 403) {
    if (
      has("accessNotConfigured", "SERVICE_DISABLED") ||
      /has not been used|is disabled/i.test(detail)
    ) {
      return `${api} is not enabled on the Google Cloud project this deployment's OAuth client belongs to. An administrator enables ${service} in the Google Cloud console; it takes a few minutes to apply.`;
    }
    if (
      has("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
      /insufficient.*scope/i.test(detail)
    ) {
      return "The access this person granted does not cover this. Reconnecting and allowing every permission on Google's consent screen fixes it.";
    }
    return "Google accepted the credential and refused the request itself.";
  }
  if (status === 404) {
    return product === "Gmail"
      ? "No message with that id is in this mailbox. It may have been deleted, or the id is not one a search returned."
      : "This calendar was not found for this account.";
  }
  return null;
}

type Header = { name?: string; value?: string };

type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};

type GmailMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
};

/**
 * A header's value, by name in any case, unfolded. Undefined when the message has none.
 *
 * Whole, for the headers this code writes back out: a `References` chain cut short would thread a
 * reply under the wrong ancestor.
 */
function headerOf(
  headers: readonly Header[] | undefined,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  const found = headers?.find(
    (header) => header.name?.toLowerCase() === wanted,
  );
  if (typeof found?.value !== "string") return undefined;
  return found.value.replace(/\r?\n[ \t]*/g, " ");
}

/**
 * RFC 2047 encoded-words (`=?UTF-8?B?…?=`) decoded into the text they stand for.
 *
 * Gmail usually hands headers back decoded, and not always: a word in a charset it does not convert
 * comes back as written. Decoding a value that has no encoded-words leaves it as it was, so this is
 * safe to apply to every header a reader is shown. A word in a charset this platform cannot decode
 * is left encoded rather than guessed at.
 */
function decodeEncodedWords(value: string): string {
  const word = /=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi;
  return (
    value
      // The space between two adjacent encoded-words is folding, not text (RFC 2047 section 6.2).
      .replace(/(\?=)\s+(?==\?[^?\s]+\?[bq]\?)/gi, "$1")
      .replace(
        word,
        (whole, charset: string, encoding: string, text: string) => {
          try {
            const bytes =
              encoding.toLowerCase() === "b"
                ? Buffer.from(text, "base64")
                : Buffer.from(
                    text
                      .replace(/_/g, " ")
                      .replace(/=([0-9a-f]{2})/gi, (_, hex: string) =>
                        String.fromCharCode(Number.parseInt(hex, 16)),
                      ),
                    "latin1",
                  );
            // RFC 2231 lets a charset carry a language after an asterisk.
            return new TextDecoder(charset.split("*")[0]).decode(bytes);
          } catch {
            return whole;
          }
        },
      )
  );
}

/** A header as a reader is shown it: decoded, and cut at {@link HEADER_MAX_CHARS}. */
function shownHeader(
  headers: readonly Header[] | undefined,
  name: string,
): string | undefined {
  const value = headerOf(headers, name);
  return value === undefined
    ? undefined
    : cutAtCodeUnits(decodeEncodedWords(value), HEADER_MAX_CHARS);
}

/**
 * An address header split into its addresses, each as written.
 *
 * Commas inside a quoted display name (`"Okafor, Maya" <maya@…>`) or inside the angle brackets are
 * not separators, which is the whole reason this is not `split(",")`.
 */
function addressList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "\\" && quoted) {
      current += char + (value[index + 1] ?? "");
      index++;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (char === "<" && !quoted) angled = true;
    else if (char === ">" && !quoted) angled = false;
    if (char === "," && !quoted && !angled) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * The message's date as ISO 8601: the Date header when it parses, Gmail's receipt time when it does
 * not. A sender writes the header and sometimes writes it wrong; Gmail's `internalDate` is the one
 * nobody outside Google chose.
 */
function isoDate(message: GmailMessage): string {
  const header = headerOf(message.payload?.headers, "Date");
  const parsed = header ? Date.parse(header) : Number.NaN;
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const received = Number(message.internalDate);
  return Number.isFinite(received) && message.internalDate
    ? new Date(received).toISOString()
    : "";
}

/** The three headers triage reads, by their own names, present only when the message carries them. */
function passedHeaders(message: GmailMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASSED_HEADERS) {
    const value = shownHeader(message.payload?.headers, name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** The fields a search and a read share, in the contract's names. */
function summary(message: GmailMessage) {
  const headers = message.payload?.headers;
  return {
    id: message.id ?? "",
    threadId: message.threadId ?? "",
    from: shownHeader(headers, "From") ?? "",
    to: addressList(shownHeader(headers, "To")),
    cc: addressList(shownHeader(headers, "Cc")),
    subject: shownHeader(headers, "Subject") ?? "",
    date: isoDate(message),
  };
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["ndash", "–"],
  ["mdash", "—"],
  ["hellip", "…"],
  ["rsquo", "’"],
  ["lsquo", "‘"],
  ["rdquo", "”"],
  ["ldquo", "“"],
  ["copy", "©"],
  ["reg", "®"],
]);

/**
 * HTML character references decoded in ONE pass, so `&amp;lt;` reads as the `&lt;` its author
 * wrote rather than as a `<`. A Map for the reason Drive's export table is one: the name comes off
 * somebody else's mail, and a plain object answers `constructor`.
 */
function decodeEntities(text: string): string {
  return text.replace(
    /&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi,
    (whole, ref: string) => {
      if (ref.startsWith("#")) {
        const code =
          ref[1] === "x" || ref[1] === "X"
            ? Number.parseInt(ref.slice(2), 16)
            : Number.parseInt(ref.slice(1), 10);
        return code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return NAMED_ENTITIES.get(ref.toLowerCase()) ?? whole;
    },
  );
}

/**
 * An HTML body as the text a person would read in it.
 *
 * Not a renderer, and not trying to be: what a reader needs is the words in order with the
 * paragraph breaks, and none of the style sheets, scripts or tracking markup a marketing mail is
 * mostly made of. Entities are decoded last, after the tags are gone, so an escaped `&lt;b&gt;` in
 * the text stays text instead of being read as a tag.
 */
function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(
      /<\/(p|div|li|tr|h[1-6]|blockquote|table|ul|ol|section|article)\s*>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, "");
  return decodeEntities(text)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A part's bytes as text, in the charset the part declares.
 *
 * Gmail has already undone the transfer encoding (quoted-printable, base64) and hands back the raw
 * bytes, base64url-encoded. What it has not done is decode the charset, so a `windows-1252` or
 * `iso-8859-1` body read as UTF-8 turns every accented letter into a replacement character. A label
 * the platform does not know is read as UTF-8 rather than refused, since an unreadable letter is
 * better than an unreadable message.
 */
function partText(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return "";
  const bytes = Buffer.from(data, "base64url");
  const declared = /charset\s*=\s*"?([^";\s]+)"?/i.exec(
    headerOf(part.headers, "Content-Type") ?? "",
  )?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(declared ?? "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

/** Whether a part is a file somebody attached rather than the message itself. */
function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true;
  return /^\s*attachment/i.test(
    headerOf(part.headers, "Content-Disposition") ?? "",
  );
}

/** The first part of this type, depth first, that is not an attachment. */
function firstPart(part: GmailPart, mimeType: string): GmailPart | null {
  if (isAttachment(part)) return null;
  if (part.mimeType?.toLowerCase() === mimeType) return part;
  for (const child of part.parts ?? []) {
    const found = firstPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

/**
 * The message's text: its plain-text part, or its HTML part read as text when it has none.
 *
 * Plain first because when a sender wrote both, the plain one is what they meant a reader without
 * HTML to see, and it carries none of the layout that HTML-to-text has to guess its way through.
 */
function bodyText(message: GmailMessage): string {
  const payload = message.payload;
  if (!payload) return "";
  const plain = firstPart(payload, "text/plain");
  if (plain) return partText(plain).replace(/\r\n/g, "\n").trim();
  const html = firstPart(payload, "text/html");
  return html ? htmlToText(partText(html)) : "";
}

/** At most {@link BODY_MAX_CHARS}, with the marker inside that budget when anything was cut. */
function capBody(body: string): { body: string; cut: boolean } {
  if (body.length <= BODY_MAX_CHARS) return { body, cut: false };
  return {
    body:
      cutAtCodeUnits(body, BODY_MAX_CHARS - BODY_CUT_MARKER.length) +
      BODY_CUT_MARKER,
    cut: true,
  };
}

/**
 * Up to `limit` of these at once, in order, stopping early once one fails.
 *
 * A failure that is not a missing message (401, 429, a disabled API) will be the same for every
 * remaining lookup, so asking forty more times only spends quota to hear it again.
 */
async function lookUpAll<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<Outcome<R>>,
): Promise<Outcome<R[]>> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed: string | null = null;
  async function worker() {
    while (failed === null && next < items.length) {
      const index = next++;
      const outcome = await work(items[index]);
      if (outcome.ok) results[index] = outcome.value;
      else failed ??= outcome.message;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return failed === null
    ? { ok: true, value: results }
    : { ok: false, message: failed };
}

/** A count argument: absent means the default, a number is clamped to the maximum, junk is refused. */
function countArg(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 1) return "invalid";
  return Math.min(Math.floor(number), MAX_RESULTS);
}

/** Line breaks, and the characters some parsers treat as one, in anything bound for a header. */
/** An RFC 822 Message-ID as a header carries it: `<local@domain>`. */
const RFC822_MESSAGE_ID = /^<[^<>\s]+@[^<>\s]+>$/;
const HEADER_BREAK = /[\r\n\0\u0085\u2028\u2029]/;

/**
 * A header value Gmail can carry whatever its characters: RFC 2047 encoded-words when it is not
 * plain ASCII, folded so no encoded-word passes the 75 characters the RFC allows one.
 */
function encodeWords(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const char of text) {
    // 45 bytes of UTF-8 is 60 of base64, which with `=?UTF-8?B?` and `?=` stays under 75.
    if (Buffer.byteLength(chunk + char, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words
    .map(
      (word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`,
    )
    .join("\r\n ");
}

/** One recipient, with only its display name encoded: an encoded address is no address at all. */
function formatAddress(address: string): string {
  const trimmed = address.trim();
  if (/^[\x20-\x7e]*$/.test(trimmed)) return trimmed;
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(trimmed);
  if (!match) return trimmed;
  const name = match[1].trim().replace(/^"(.*)"$/, "$1");
  return name ? `${encodeWords(name)} <${match[2]}>` : `<${match[2]}>`;
}

/** Text as base64 in lines of 76, which is what RFC 2045 allows a base64 body. */
function base64Lines(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

/**
 * Message ids as one header value, folded between ids so a long thread's chain never makes a line
 * longer than RFC 5322 allows. Never inside an id: a folded id is a different id.
 */
function foldIds(ids: readonly string[]): string {
  const lines: string[] = [];
  let line = "";
  for (const id of ids) {
    if (line && line.length + 1 + id.length > 76) {
      lines.push(line);
      line = id;
    } else {
      line = line ? `${line} ${id}` : id;
    }
  }
  if (line) lines.push(line);
  return lines.join("\r\n ");
}

/**
 * The reply as an RFC 5322 message, ready to be base64url-encoded for Gmail.
 *
 * `In-Reply-To` and `References` are what thread it, for Gmail and for every other client the
 * recipient might use: Gmail's own `threadId` files it on the sender's side only. `References` is
 * the parent's chain with the parent's id added, and falls back to the parent's `In-Reply-To` when
 * the parent carries no chain, as RFC 5322 section 3.6.4 describes.
 *
 * The body travels as base64 rather than 8bit, so no line length or character in it can be read as
 * the end of the body or the start of a header.
 */
function replyMessage(input: {
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  body: string;
  parentMessageId: string;
  parentReferences?: string;
  parentInReplyTo?: string;
}): string {
  const chain = (input.parentReferences ?? input.parentInReplyTo ?? "").trim();
  // Split on whitespace, which takes every line break with it; a NUL is the one break that is not
  // whitespace, so an id carrying one is dropped rather than written into a header.
  const references = foldIds(
    `${chain} ${input.parentMessageId}`
      .trim()
      .split(/\s+/)
      .filter((id) => !HEADER_BREAK.test(id)),
  );
  const subject = /^re:/i.test(input.subject.trim())
    ? input.subject.trim()
    : `Re: ${input.subject.trim()}`;
  const lines = [
    `To: ${input.to.map(formatAddress).join(", ")}`,
    ...(input.cc.length > 0
      ? [`Cc: ${input.cc.map(formatAddress).join(", ")}`]
      : []),
    `Subject: ${encodeWords(subject)}`,
    `In-Reply-To: ${input.parentMessageId}`,
    `References: ${references}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(input.body.replace(/\r?\n/g, "\r\n")),
  ];
  return lines.join("\r\n");
}

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/**
 * A result as the JSON text a reader parses. Compact, because every character is a model's token.
 *
 * An empty search is `{"messages":[],…}`, which says "nothing matched" in so many words, so the
 * empty-string problem Drive's results guard against does not arise.
 */
const asJson = (value: unknown, truncated = false): McpCallResult => ({
  text: JSON.stringify(value),
  isError: false,
  truncated,
});

/**
 * Call one tool.
 *
 * Whether the call was permitted is decided before this module, exactly as it is for MCP: the grant,
 * the policy, and for `gmail_send_reply` the approval gate. This dispatches, validates what it was
 * handed, and formats. An unknown tool is refused rather than guessed at, because a name that gets
 * here and is not in {@link TOOLS} means the stored tool list and this code have diverged.
 */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const stringArg = (key: string): string | null => {
    const value = args[key];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  /** A list of strings, accepting one bare string as a list of one, since models write either. */
  const listArg = (key: string): string[] | "invalid" => {
    const value = args[key];
    if (value === undefined || value === null) return [];
    const items = typeof value === "string" ? [value] : value;
    if (!Array.isArray(items)) return "invalid";
    if (!items.every((item) => typeof item === "string")) return "invalid";
    return items.map((item: string) => item.trim()).filter(Boolean);
  };

  if (toolName === "gmail_search_messages") {
    const query = stringArg("query") ?? DEFAULT_QUERY;
    const maxResults = countArg(args.maxResults);
    if (maxResults === "invalid") {
      return failure(`maxResults must be a number from 1 to ${MAX_RESULTS}.`);
    }

    const listed = await request<{
      messages?: { id?: string }[];
      resultSizeEstimate?: number;
    }>(connection, "Gmail", `${GMAIL}/messages`, {
      query: {
        q: query,
        maxResults: String(maxResults ?? DEFAULT_MAX_RESULTS),
      },
    });
    if (!listed.ok) return failure(listed.message);

    const ids = (listed.value.messages ?? [])
      .map((message) => message.id)
      .filter((id): id is string => typeof id === "string" && id !== "");

    const fetched = await lookUpAll<string, GmailMessage | null>(
      ids,
      LOOKUP_CONCURRENCY,
      async (id) => {
        const message = await request<GmailMessage>(
          connection,
          "Gmail",
          `${GMAIL}/messages/${encodeURIComponent(id)}`,
          { query: { format: "metadata", metadataHeaders: METADATA_HEADERS } },
        );
        /*
         * A message deleted between the listing and its lookup is not a failed search. It is skipped,
         * and the search answers with the rest. Any other refusal is the same for every lookup and is
         * reported as the search's.
         */
        if (!message.ok && message.status === 404) {
          return { ok: true as const, value: null };
        }
        return message;
      },
    );
    if (!fetched.ok) return failure(fetched.message);

    return asJson({
      messages: fetched.value
        .filter((message): message is GmailMessage => message !== null)
        .map((message) => ({
          ...summary(message),
          snippet: decodeEntities(message.snippet ?? ""),
          labels: message.labelIds ?? [],
          headers: passedHeaders(message),
        })),
      resultSizeEstimate:
        typeof listed.value.resultSizeEstimate === "number"
          ? listed.value.resultSizeEstimate
          : ids.length,
    });
  }

  if (toolName === "gmail_read_message") {
    const id = stringArg("id");
    if (!id) return failure("A message id is needed to read a message.");

    const read = await request<GmailMessage>(
      connection,
      "Gmail",
      `${GMAIL}/messages/${encodeURIComponent(id)}`,
      { query: { format: "full" } },
    );
    if (!read.ok) return failure(read.message);

    const message = read.value;
    const { body, cut } = capBody(bodyText(message));
    return asJson(
      {
        ...summary(message),
        labels: message.labelIds ?? [],
        headers: passedHeaders(message),
        messageId: shownHeader(message.payload?.headers, "Message-ID") ?? "",
        body,
      },
      cut,
    );
  }

  if (toolName === "gmail_send_reply") {
    const threadId = stringArg("threadId");
    const inReplyTo = stringArg("inReplyTo");
    const subject = stringArg("subject");
    const body = typeof args.body === "string" ? args.body : "";
    const to = listArg("to");
    const cc = listArg("cc");

    if (!threadId || !inReplyTo) {
      return failure(
        "A reply needs the thread id and the Gmail id of the message being answered.",
      );
    }
    if (to === "invalid" || cc === "invalid") {
      return failure("Recipients must be a list of addresses.");
    }
    if (to.length === 0)
      return failure("A reply needs at least one recipient.");
    if (!subject) return failure("A reply needs a subject.");
    if (body.trim() === "") return failure("A reply needs something to say.");

    /*
     * HEADER INJECTION, refused before anything is fetched. A line break in a recipient or the
     * subject ends that header and starts another, so `ana@x.com\r\nBcc: everyone@y.com` sends a
     * copy nobody approved: the approval card showed one recipient and the message had two. Refused
     * rather than stripped, because a model that wrote one either was told to by the mail it read or
     * has misunderstood the call, and neither should be sent quietly.
     */
    if ([...to, ...cc, subject].some((value) => HEADER_BREAK.test(value))) {
      return failure(
        "A recipient or the subject contains a line break, which would add a header nobody approved. The reply was not sent.",
      );
    }
    if (![...to, ...cc].every((address) => address.includes("@"))) {
      return failure("Every recipient needs an email address.");
    }

    /*
     * The message being answered, for the ids that thread the reply. Asked of Gmail rather than
     * taken as arguments, so a model cannot thread a reply under a message it never read, and so the
     * reply is checked to belong to the thread it is being filed in.
     */
    /*
     * A model given both ids naturally reaches for the Message-ID, because that is what an
     * In-Reply-To header holds. Accepted rather than refused: it is looked up the way Gmail's own
     * search does, so the reply is still threaded only under a message in this mailbox, and still
     * checked against the thread below.
     */
    let parentId = inReplyTo;
    if (RFC822_MESSAGE_ID.test(inReplyTo)) {
      const found = await request<{ messages?: { id?: string }[] }>(
        connection,
        "Gmail",
        `${GMAIL}/messages`,
        {
          query: {
            q: `rfc822msgid:${inReplyTo.replace(/^<|>$/g, "")}`,
            maxResults: "1",
          },
        },
      );
      if (!found.ok) return failure(found.message);
      const id = found.value.messages?.[0]?.id;
      if (!id)
        return failure(
          "No message in this mailbox has that Message-ID, so there is nothing to reply to. The reply was not sent.",
        );
      parentId = id;
    }
    const parent = await request<GmailMessage>(
      connection,
      "Gmail",
      `${GMAIL}/messages/${encodeURIComponent(parentId)}`,
      {
        query: {
          format: "metadata",
          metadataHeaders: ["Message-ID", "References", "In-Reply-To"],
        },
      },
    );
    if (!parent.ok) return failure(parent.message);
    if (parent.value.threadId && parent.value.threadId !== threadId) {
      return failure(
        `The message being answered is in thread ${parent.value.threadId}, not ${threadId}. The reply was not sent.`,
      );
    }
    const parentHeaders = parent.value.payload?.headers;
    const parentMessageId = headerOf(parentHeaders, "Message-ID")?.trim();
    // Written into two headers of the reply, so it is held to the same rule as the recipients.
    if (!parentMessageId || HEADER_BREAK.test(parentMessageId)) {
      return failure(
        "The message being answered has no usable Message-ID, so a reply could not be threaded under it. The reply was not sent.",
      );
    }

    const raw = Buffer.from(
      replyMessage({
        to,
        cc,
        subject,
        body,
        parentMessageId,
        parentReferences: headerOf(parentHeaders, "References"),
        parentInReplyTo: headerOf(parentHeaders, "In-Reply-To"),
      }),
      "utf8",
    ).toString("base64url");

    const sent = await request<{ id?: string; threadId?: string }>(
      connection,
      "Gmail",
      `${GMAIL}/messages/send`,
      { json: { raw, threadId } },
    );
    if (!sent.ok) return failure(sent.message);
    return asJson({
      sent: true,
      id: sent.value.id ?? "",
      threadId: sent.value.threadId ?? threadId,
    });
  }

  if (toolName === "calendar_list_events") {
    const maxResults = countArg(args.maxResults);
    if (maxResults === "invalid") {
      return failure(`maxResults must be a number from 1 to ${MAX_RESULTS}.`);
    }

    /*
     * Both bounds normalised to UTC ISO, because Calendar refuses anything that is not RFC 3339 with
     * an offset, and a model writes "2026-10-22" or a local time as often as not. A value that does
     * not parse at all is refused here, by name, rather than sent for Google to refuse less clearly.
     */
    const bound = (key: "timeMin" | "timeMax"): Date | null | "invalid" => {
      const value = stringArg(key);
      if (value === null) return null;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? new Date(parsed) : "invalid";
    };
    const givenMin = bound("timeMin");
    const givenMax = bound("timeMax");
    if (givenMin === "invalid" || givenMax === "invalid") {
      return failure("timeMin and timeMax must be ISO 8601 date-times.");
    }
    const timeMin = givenMin ?? new Date();
    /*
     * With no timeMax, the end of timeMin's day where the person is: midnight in their calendar's
     * time zone, which with no timeMin is the end of today. Tied to timeMin rather than to the clock,
     * so asking for tomorrow morning does not default to a window that closed before it opened.
     *
     * Their day, not UTC's. At 13:00 in California the UTC day ends at 17:00, and everything on the
     * calendar after that went missing from "today"; in Tokyo the UTC day runs on into tomorrow
     * morning. A zone that cannot be read falls back to UTC's day, and the result says so rather
     * than letting a short day pass for the whole of one.
     */
    let zone: { timeZone: string; note?: string } | null = null;
    let timeMax = givenMax;
    if (timeMax === null) {
      const read = await calendarTimeZone(connection);
      if (read.ok) {
        zone = { timeZone: read.timeZone };
        timeMax = endOfDayIn(timeMin, read.timeZone);
      } else {
        zone = {
          timeZone: "UTC",
          note: `Your calendar's time zone could not be read, so today was taken to end at midnight UTC. ${read.why}`,
        };
        timeMax = endOfDayIn(timeMin, "UTC");
      }
    }
    if (timeMax.getTime() <= timeMin.getTime()) {
      return failure("timeMax must be later than timeMin.");
    }

    const listed = await request<{ items?: CalendarEvent[] }>(
      connection,
      "Google Calendar",
      `${CALENDAR}/events`,
      {
        query: {
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          // Recurring events as their occurrences, which is also what `orderBy=startTime` requires.
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: String(maxResults ?? DEFAULT_MAX_RESULTS),
        },
      },
    );
    if (!listed.ok) return failure(listed.message);

    return asJson({
      ...zone,
      events: (listed.value.items ?? []).map(eventOf),
    });
  }

  return failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );
}

type CalendarEvent = {
  id?: string;
  summary?: string;
  status?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; displayName?: string };
  attendees?: { email?: string }[];
};

/**
 * One event in the contract's shape. An all-day event's start is a date rather than a date-time,
 * kept as Google gives it, because turning it into midnight UTC would put it on the wrong day for
 * everybody west of Greenwich.
 */
function eventOf(event: CalendarEvent) {
  const organizer = event.organizer?.email ?? event.organizer?.displayName;
  return {
    id: event.id ?? "",
    // Google omits the title of an untitled event, and its own calendar calls those "(No title)".
    summary: event.summary ?? "(no title)",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    ...(event.location ? { location: event.location } : {}),
    ...(organizer ? { organizer } : {}),
    attendees: (event.attendees ?? [])
      .map((attendee) => attendee.email)
      .filter((email): email is string => typeof email === "string"),
    status: event.status ?? "confirmed",
  };
}

/**
 * The person's time zone, an IANA name, as their primary calendar holds it.
 *
 * The calendar's rather than the server's or a browser's, because it is the zone Google Calendar
 * shows the person their own days in. A name this runtime's `Intl` does not know is unreadable here,
 * rather than a RangeError later.
 */
async function calendarTimeZone(
  connection: Connection,
): Promise<{ ok: true; timeZone: string } | { ok: false; why: string }> {
  const read = await request<{ timeZone?: unknown }>(
    connection,
    "Google Calendar",
    CALENDAR,
  );
  if (!read.ok) return { ok: false, why: read.message };
  const { timeZone } = read.value;
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    return { ok: false, why: "Google Calendar did not name one." };
  }
  try {
    wallClockIn(timeZone);
  } catch {
    return {
      ok: false,
      why: `"${timeZone.slice(0, 100)}" is not a time zone this server knows.`,
    };
  }
  return { ok: true, timeZone };
}

const DAY_MS = 86_400_000;

/**
 * A reader of `timeZone`'s clocks: the local date and time at an instant, to the second, written as
 * the UTC milliseconds of those same digits. Throws a RangeError for a zone `Intl` does not know.
 */
function wallClockIn(timeZone: string): (at: number) => number {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  return (at) => {
    const part: Record<string, number> = {};
    for (const { type, value } of format.formatToParts(at)) {
      part[type] = Number(value);
    }
    return Date.UTC(
      part.year,
      part.month - 1,
      part.day,
      part.hour,
      part.minute,
      part.second,
    );
  };
}

/**
 * The first instant of the day after `instant`'s, in `timeZone`: that day's midnight, or, on a day
 * whose midnight a change of offset skips, the moment the clocks jump past it.
 *
 * `Intl` gives a zone's offset at an instant but not the instant a local time falls on, so midnight
 * is found from the offset. That is read twice, as date libraries do, because the offset in force at
 * midnight is not known until midnight is: once at a first guess, and again at the instant that guess
 * gives. On an ordinary day, DST days included, both land on midnight. Where the clocks change at
 * midnight itself the two differ, and the earlier one that falls on the next day is its start.
 */
function endOfDayIn(instant: Date, timeZone: string): Date {
  const wall = wallClockIn(timeZone);
  /** The local date at `at`, as the UTC milliseconds of its midnight. */
  const dateOf = (at: number) => Math.floor(wall(at) / DAY_MS) * DAY_MS;
  /** How far the zone's clocks are ahead of UTC at `at`. */
  const offsetAt = (at: number) => wall(at) - Math.floor(at / 1000) * 1000;

  const today = dateOf(instant.getTime());
  // Tomorrow's 00:00 in the zone's digits, read as though they were UTC.
  const midnight = today + DAY_MS;
  const first = midnight - offsetAt(midnight);
  const second = midnight - offsetAt(first);
  const tomorrow = [first, second].filter((at) => dateOf(at) > today);
  return new Date(
    tomorrow.length > 0 ? Math.min(...tomorrow) : Math.max(first, second),
  );
}
