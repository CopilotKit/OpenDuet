#!/usr/bin/env bun
/**
 * A fake Google: just enough of Google's OAuth, Gmail and Calendar to run the Gmail and Google
 * Calendar connector without a Google account.
 *
 *   bun openbot/scripts/fake-google/server.ts --port 4900
 *
 * then, in `openbot/.env`, `OPENDUET_FAKE_GOOGLE_URL=http://127.0.0.1:4900`, which points the
 * `google-workspace` catalogue entry here instead of at Google (see `fakeGoogleOrigin` in
 * `server/src/plugins/catalogue.ts`; it is refused in production).
 *
 * WHY IT EXISTS. Gmail's scopes are restricted: an unverified Google app can be consented to only by
 * the test users listed on its Cloud project, so every demo and every end-to-end test of this
 * connector would otherwise need a project, a consent screen and somebody's real mailbox. This
 * answers the same requests the adapter makes, in the shapes Google answers them, from an invented
 * one.
 *
 * WHAT IT HOLDS. The mailbox of Maya Okafor, who runs Marlow Ceramics: the 60 invented messages in
 * `evals/triage/emails.jsonl`, dated so the newest arrived minutes ago and all of them within the last
 * day, so the connector's default "in:inbox newer_than:1d" finds them. Her calendar for today has a
 * handful of events. The eval's own labels (`label`, `why`) are never served: they are the answers.
 *
 * WHAT IT IS NOT. A faithful Gmail. Search understands the operators a person or a model commonly
 * writes (`in:`, `label:`, `category:`, `is:`, `from:`, `to:`, `subject:`, `newer_than:`,
 * `older_than:`, `after:`, `before:`, and bare words) and ignores the rest. `after:` and `before:`
 * take Unix seconds or a `YYYY/MM/DD` date in the studio's day, as Gmail does, which is how a
 * check-in asks for only what is new. OAuth consents automatically. It is written independently of
 * the adapter on purpose, from Google's documented shapes, so a misreading in the adapter is not
 * mirrored here and cancelled out.
 *
 * WHAT A TEST OR A DEMO CAN ASK IT. Unauthenticated, test-only, and never anything Google has:
 *
 * - `GET /__fake/sent` lists what was sent, decoded.
 * - `POST /__fake/reset` puts the mailbox and calendar back as they started, dated from now, and
 *   forgets what was sent. Issued tokens survive a reset, so a connected deployment stays connected.
 * - `POST /__fake/deliver` with JSON `{ "from": "Ana Ruiz <ana@example.com>", "subject": "…",
 *   "body": "…" }` puts one new message in the inbox, dated now, so a check-in has something new to
 *   find. `to`, `cc` and `labels` are optional; it is to Maya, unread, in the inbox. It answers the
 *   new message's `id` and `threadId`. A reset takes delivered mail away again. Use invented
 *   people and addresses only.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Who is signed in. Every message in the mailbox is to her. */
export const FAKE_ACCOUNT = "maya@marlowceramics.com";

/** What a consent grants when the request named no scope, which is what the connector asks for. */
const DEFAULT_SCOPE = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

/** An hour, which is what Google issues. */
const TOKEN_LIFETIME_SECONDS = 3599;

/**
 * The studio's offset from UTC. Pacific daylight time, which is what the eval set's own dates carry
 * and what late October is in the Pacific. Fixed rather than computed from a zone, because the fake
 * is meant to give the same answer on every machine.
 */
const STUDIO_OFFSET_MINUTES = -7 * 60;
const STUDIO_TIME_ZONE = "America/Los_Angeles";

const MAILBOX = fileURLToPath(
  new URL("../../../evals/triage/emails.jsonl", import.meta.url),
);

/** One line of the eval set. `label` and `why` are deliberately not read. */
type Seed = {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  headers: Record<string, string>;
  gmail_labels: string[];
  body: string;
};

type Header = { name: string; value: string };

type StoredMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  /** Milliseconds since the epoch, as Gmail's `internalDate` (which it sends as a string). */
  internalDate: number;
  headers: Header[];
  mimeType: "text/plain" | "text/html";
  /** The body's text, before any encoding. */
  content: string;
  /** The plain words, for the snippet and for search. */
  text: string;
};

/** A message somebody sent through the fake, decoded the way a test wants to read it. */
export type SentMessage = {
  id: string;
  threadId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string | null;
};

type FakeEvent = {
  kind: "calendar#event";
  id: string;
  status: "confirmed" | "tentative";
  summary: string;
  location?: string;
  start: { dateTime: string; timeZone: string } | { date: string };
  end: { dateTime: string; timeZone: string } | { date: string };
  organizer: { email: string; self: true };
  attendees?: { email: string; responseStatus: string; self?: true }[];
  /** Not served: the event's span in milliseconds, for filtering and ordering. */
  span: [number, number];
};

const sha256 = (text: string) => createHash("sha256").update(text).digest();
const hex = (text: string) => sha256(text).toString("hex");
const token = (prefix: string) =>
  `${prefix}${randomBytes(24).toString("base64url")}`;
const pad = (value: number) => String(value).padStart(2, "0");

/** An offset like `-07:00` or `Z` as minutes east of UTC. */
function offsetOf(iso: string): number {
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** An instant as an RFC 5322 date, in the sender's own offset, the way a mail client writes one. */
function mailDate(instant: number, offsetMinutes: number): string {
  const local = new Date(instant + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${DAYS[local.getUTCDay()]}, ${pad(local.getUTCDate())} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** An instant as ISO 8601 in the studio's offset, as Calendar writes `dateTime`. */
function studioDateTime(instant: number): string {
  const local = new Date(instant + STUDIO_OFFSET_MINUTES * 60_000);
  const abs = Math.abs(STUDIO_OFFSET_MINUTES);
  const sign = STUDIO_OFFSET_MINUTES < 0 ? "-" : "+";
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Gmail's snippet: the opening words, whitespace collapsed, HTML-escaped as Gmail escapes them. */
const snippetOf = (text: string) =>
  escapeHtml(text.replace(/\s+/g, " ").trim().slice(0, 140));

function domainOf(address: string): string {
  return /@([^>\s]+)>?\s*$/.exec(address)?.[1] ?? "marlowceramics.com";
}

/**
 * The eval set as a mailbox, re-dated so its newest message arrived five minutes before `now`.
 *
 * The set's messages all carry one timestamp, the morning it was written for. Served like that,
 * sixty messages arrive in the same second, so each is moved back by a stable amount under twelve
 * hours, derived from its id: the same message lands at the same point in the morning every time,
 * and the needs-you and can-wait mail are mixed rather than in two blocks.
 *
 * Ids are stable too, derived from the set's ids, so a demo script or a test can name a message
 * across restarts. Gmail's ids are sixteen hex digits, and so are these.
 */
function seedMailbox(path: string, now: number): StoredMessage[] {
  const seeds: Seed[] = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Seed);
  const newest = Math.max(...seeds.map((seed) => Date.parse(seed.date)));
  const shift = now - 5 * 60_000 - newest;

  return seeds
    .map((seed): StoredMessage => {
      const digest = hex(`fake-google:${seed.id}`);
      const id = digest.slice(0, 16);
      const stagger =
        (Number.parseInt(digest.slice(16, 20), 16) % 720) * 60_000;
      const instant = Date.parse(seed.date) + shift - stagger;
      // Bulk mail is HTML, as it usually is, which is also what exercises the adapter's fallback.
      const html = "List-Unsubscribe" in seed.headers;
      const headers: Header[] = [
        { name: "From", value: seed.from },
        { name: "To", value: seed.to.join(", ") },
        ...(seed.cc.length > 0
          ? [{ name: "Cc", value: seed.cc.join(", ") }]
          : []),
        { name: "Subject", value: seed.subject },
        { name: "Date", value: mailDate(instant, offsetOf(seed.date)) },
        {
          name: "Message-ID",
          value: `<${seed.id}.${digest.slice(20, 28)}@${domainOf(seed.from)}>`,
        },
        { name: "MIME-Version", value: "1.0" },
        {
          name: "Content-Type",
          value: `${html ? "text/html" : "text/plain"}; charset="UTF-8"`,
        },
        ...Object.entries(seed.headers).map(([name, value]) => ({
          name,
          value,
        })),
      ];
      return {
        id,
        threadId: id,
        labelIds: [...seed.gmail_labels],
        internalDate: instant,
        headers,
        mimeType: html ? "text/html" : "text/plain",
        content: html
          ? `<html><head><style>p{font-family:sans-serif}</style></head><body><p>${escapeHtml(seed.body)}</p></body></html>`
          : seed.body,
        text: seed.body,
      };
    })
    .sort((a, b) => b.internalDate - a.internalDate);
}

/**
 * Today's calendar, in the studio's day. Two of the events are the ones the launch film names, and
 * the rest tie back to mail in the inbox, so a brief has something to connect.
 */
function seedCalendar(now: number): FakeEvent[] {
  const local = new Date(now + STUDIO_OFFSET_MINUTES * 60_000);
  const [year, month, day] = [
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  ];
  /** An hour and minute of the studio's today, as an instant. */
  const at = (hour: number, minute = 0) =>
    Date.UTC(year, month, day, hour, minute) - STUDIO_OFFSET_MINUTES * 60_000;
  const date = (offsetDays: number) => {
    const value = new Date(Date.UTC(year, month, day + offsetDays));
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  };
  const timed = (
    id: string,
    summary: string,
    from: [number, number],
    to: [number, number],
    extra: Partial<FakeEvent> & { guests?: string[] } = {},
  ): FakeEvent => {
    const { guests = [], ...rest } = extra;
    const start = at(...from);
    const end = at(...to);
    return {
      kind: "calendar#event",
      id,
      status: "confirmed",
      summary,
      start: { dateTime: studioDateTime(start), timeZone: STUDIO_TIME_ZONE },
      end: { dateTime: studioDateTime(end), timeZone: STUDIO_TIME_ZONE },
      organizer: { email: FAKE_ACCOUNT, self: true },
      ...(guests.length > 0
        ? {
            attendees: [
              { email: FAKE_ACCOUNT, responseStatus: "accepted", self: true },
              ...guests.map((email) => ({
                email,
                responseStatus: "needsAction",
              })),
            ],
          }
        : {}),
      span: [start, end],
      ...rest,
    };
  };

  const events: FakeEvent[] = [
    {
      kind: "calendar#event",
      id: "kiln2outofservice",
      status: "confirmed",
      summary: "Kiln 2 out of service",
      start: { date: date(0) },
      end: { date: date(1) },
      organizer: { email: FAKE_ACCOUNT, self: true },
      span: [at(0), at(24)],
    },
    timed("glazetestreview", "Glaze test review", [10, 0], [10, 45], {
      location: "Studio, glaze room",
      guests: ["leo@marlowceramics.com", "sam@marlowceramics.com"],
    }),
    timed(
      "lunchwithpriya",
      "Lunch with Priya Shah: quarterly taxes",
      [12, 30],
      [13, 15],
      {
        location: "Tartine Manufactory",
        guests: ["priya@shahaccounting.com"],
      },
    ),
    timed(
      "studiovisithearthandco",
      "Studio visit with Hearth & Co",
      [15, 0],
      [16, 0],
      {
        location: "Marlow Ceramics, 41 Alder St",
        guests: ["ana@hearthandco.com"],
      },
    ),
    timed(
      "packthemugs",
      "Pack the 120 mugs for Hearth & Co",
      [17, 0],
      [17, 30],
      {
        guests: ["sam@marlowceramics.com"],
      },
    ),
    timed("makersmarketcall", "Makers Market vendor call", [18, 30], [19, 0], {
      status: "tentative",
      location: "Google Meet",
      guests: ["hello@makersmarket.org"],
    }),
    /*
     * Late in the studio's evening, after the UTC day has ended for anyone west of Greenwich: at
     * 19:30 Pacific it is already 02:30 UTC tomorrow. A "today" that ends at midnight UTC rather than
     * the person's own midnight loses this one, which is why it is here.
     */
    timed("eveningwheelclass", "Evening wheel class", [19, 30], [21, 0], {
      location: "Marlow Ceramics, 41 Alder St",
    }),
  ];
  return events.sort((a, b) => a.span[0] - b.span[0]);
}

/** A header's value by name, in any case. */
const headerValue = (headers: readonly Header[], name: string) =>
  headers.find((header) => header.name.toLowerCase() === name.toLowerCase())
    ?.value;

/** An address header's addresses, splitting on commas outside quotes and angle brackets. */
function addresses(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (!quoted && char === "<") depth++;
    if (!quoted && char === ">") depth = Math.max(0, depth - 1);
    if (char === "," && !quoted && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current.trim());
  return out.filter(Boolean);
}

/** RFC 2047 encoded-words decoded. */
function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
      (whole, charset: string, encoding: string, text: string) => {
        try {
          const bytes =
            encoding.toUpperCase() === "B"
              ? Buffer.from(text, "base64")
              : Buffer.from(
                  text
                    .replace(/_/g, " ")
                    .replace(/=([0-9A-Fa-f]{2})/g, (_, code: string) =>
                      String.fromCharCode(Number.parseInt(code, 16)),
                    ),
                  "latin1",
                );
          return new TextDecoder(charset).decode(bytes);
        } catch {
          return whole;
        }
      },
    );
}

/** One MIME entity, from its bytes held as a latin1 string. */
function parseEntity(binary: string): { headers: Header[]; body: string } {
  const split = /\r?\n\r?\n/.exec(binary);
  const head = split ? binary.slice(0, split.index) : binary;
  const rest = split ? binary.slice(split.index + split[0].length) : "";
  const headers = head
    .replace(/\r?\n[ \t]+/g, " ")
    .split(/\r?\n/)
    .filter((line) => line.includes(":"))
    .map((line) => {
      const colon = line.indexOf(":");
      return {
        name: line.slice(0, colon).trim(),
        value: line.slice(colon + 1).trim(),
      };
    });

  const type = headerValue(headers, "Content-Type") ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    // The first text/plain part, which is the reply a person wrote.
    for (const part of rest.split(`--${boundary}`).slice(1)) {
      const inner = parseEntity(part.replace(/^\r?\n/, ""));
      if (
        /^text\/plain/i.test(
          headerValue(inner.headers, "Content-Type") ?? "text/plain",
        )
      ) {
        return { headers, body: inner.body };
      }
    }
    return { headers, body: "" };
  }

  const encoding = (
    headerValue(headers, "Content-Transfer-Encoding") ?? "7bit"
  ).toLowerCase();
  const bytes =
    encoding === "base64"
      ? Buffer.from(rest.replace(/\s+/g, ""), "base64")
      : encoding === "quoted-printable"
        ? Buffer.from(
            rest
              .replace(/=\r?\n/g, "")
              .replace(/=([0-9A-Fa-f]{2})/g, (_, code: string) =>
                String.fromCharCode(Number.parseInt(code, 16)),
              ),
            "latin1",
          )
        : Buffer.from(rest, "latin1");
  const charset = /charset="?([^";\s]+)"?/i.exec(type)?.[1] ?? "utf-8";
  let text: string;
  try {
    text = new TextDecoder(charset).decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  return { headers, body: text.replace(/\r\n/g, "\n") };
}

/** Whether a message matches a Gmail query, for the operators listed at the top of this file. */
function matchesQuery(
  message: StoredMessage,
  query: string,
  now: number,
): boolean {
  const terms = query.match(/-?(?:[a-z_]+:)?(?:"[^"]*"|\S+)/gi) ?? [];
  const field = (name: string) =>
    (headerValue(message.headers, name) ?? "").toLowerCase();
  const has = (label: string) => message.labelIds.includes(label);
  const unit = { d: 86_400_000, h: 3_600_000, m: 30 * 86_400_000 } as const;

  return terms.every((raw) => {
    if (/^(and|or)$/i.test(raw)) return true;
    const negated = raw.startsWith("-");
    const term = negated ? raw.slice(1) : raw;
    const colon = term.indexOf(":");
    const operator = colon > 0 ? term.slice(0, colon).toLowerCase() : "";
    const value = (colon > 0 ? term.slice(colon + 1) : term)
      .replace(/^"|"$/g, "")
      .toLowerCase();

    let result: boolean;
    switch (operator) {
      case "in":
        result = value === "anywhere" || has(value.toUpperCase());
        break;
      case "label":
        result = message.labelIds.some(
          (label) => label.toLowerCase() === value,
        );
        break;
      case "category":
        result =
          value === "primary"
            ? !message.labelIds.some((label) => label.startsWith("CATEGORY_"))
            : has(`CATEGORY_${value.toUpperCase()}`);
        break;
      case "is":
        result = has(value.toUpperCase());
        break;
      case "from":
      case "to":
      case "cc":
      case "subject":
        result = field(operator).includes(value);
        break;
      // The Message-ID header, with or without its angle brackets, as Gmail matches it.
      case "rfc822msgid":
        result =
          field("message-id").replace(/^<|>$/g, "") ===
          value.replace(/^<|>$/g, "");
        break;
      // Gmail's own: Unix seconds, or a date taken as the start of that day where the mailbox is.
      case "after":
      case "before": {
        const instant = instantOf(value);
        if (instant === null) {
          result = true;
          break;
        }
        result =
          operator === "after"
            ? message.internalDate > instant
            : message.internalDate < instant;
        break;
      }
      case "newer_than":
      case "older_than": {
        const match = /^(\d+)([dhmy])$/.exec(value);
        if (!match) {
          result = true;
          break;
        }
        const span =
          Number(match[1]) *
          (match[2] === "y"
            ? 365 * unit.d
            : unit[match[2] as keyof typeof unit]);
        result =
          operator === "newer_than"
            ? message.internalDate >= now - span
            : message.internalDate < now - span;
        break;
      }
      case "":
        result = [
          field("from"),
          field("to"),
          field("subject"),
          message.text.toLowerCase(),
        ].some((text) => text.includes(value));
        break;
      default:
        // An operator this fake does not know narrows nothing, rather than matching nothing.
        result = true;
    }
    return negated ? !result : result;
  });
}

/** `after:` and `before:`'s value as an instant: Unix seconds, or `YYYY/MM/DD` in the studio's day. */
function instantOf(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (!date) return null;
  return (
    Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])) -
    STUDIO_OFFSET_MINUTES * 60_000
  );
}

/** What `POST /__fake/deliver` takes: one new message for Maya's inbox. */
type Delivery = {
  from: string;
  subject: string;
  body: string;
  to?: string[];
  cc?: string[];
  labels?: string[];
};

/** The delivery, or the sentence saying what is missing. */
function readDelivery(value: unknown): Delivery | string {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const text = (key: string) =>
    typeof record[key] === "string" && (record[key] as string).trim()
      ? (record[key] as string)
      : null;
  const list = (key: string) =>
    Array.isArray(record[key]) &&
    (record[key] as unknown[]).every((item) => typeof item === "string")
      ? (record[key] as string[])
      : undefined;
  const from = text("from");
  const subject = text("subject");
  const body = text("body");
  if (!from || !subject || !body)
    return "Send JSON with from, subject and body, each a non-empty string.";
  return {
    from,
    subject,
    body,
    ...(list("to") ? { to: list("to") } : {}),
    ...(list("cc") ? { cc: list("cc") } : {}),
    ...(list("labels") ? { labels: list("labels") } : {}),
  };
}

/** An access token's grant: what it may do, until when, and the refresh token it was minted from. */
type Grant = { scope: string; expiresAt: number; refresh: string };

/** Google's error body, which the adapter reads `message` and `errors[].reason` out of. */
function googleError(
  status: number,
  message: string,
  reason: string,
  headers?: Record<string, string>,
): Response {
  const statusName: Record<number, string> = {
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
  };
  return Response.json(
    {
      error: {
        code: status,
        message,
        errors: [{ message, domain: "global", reason }],
        status: statusName[status] ?? "UNKNOWN",
      },
    },
    { status, headers },
  );
}

const page = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Fake Google</title><body style="font-family:sans-serif;padding:2rem">${body}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

/** Form or JSON, whichever the client sent. */
async function fieldsOf(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (type.includes("application/json")) {
    try {
      return JSON.parse(text) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export type FakeGoogle = {
  /** Where it listens, with no trailing slash: what `OPENDUET_FAKE_GOOGLE_URL` is set to. */
  url: string;
  port: number;
  /** What has been sent, decoded. The same list `GET /__fake/sent` answers. */
  sent(): SentMessage[];
  /** The mailbox and calendar as they started, dated from now, and nothing sent. */
  reset(): void;
  stop(): Promise<void>;
};

export function startFakeGoogle(
  options: {
    /** 0, the default, picks a free port. */
    port?: number;
    hostname?: string;
    /** The clock. Real by default; a test may fix it. */
    now?: () => number;
    /** The JSONL mailbox to serve. The triage eval set by default. */
    mailbox?: string;
    /** Print one line per request. Paths only: queries carry codes and states. */
    log?: boolean;
  } = {},
): FakeGoogle {
  const now = options.now ?? Date.now;
  const mailbox = options.mailbox ?? MAILBOX;

  let messages: StoredMessage[] = [];
  let events: FakeEvent[] = [];
  let sent: SentMessage[] = [];
  let delivered = 0;
  const reset = () => {
    messages = seedMailbox(mailbox, now());
    events = seedCalendar(now());
    sent = [];
  };
  reset();

  const codes = new Map<
    string,
    {
      scope: string;
      redirectUri: string;
      challenge: string | null;
      method: string;
    }
  >();
  const accessTokens = new Map<string, Grant>();
  const refreshTokens = new Map<string, string>();
  const revoked = new Set<string>();

  const issue = (scope: string, refresh: string) => {
    const access = token("fake-access-");
    accessTokens.set(access, {
      scope,
      expiresAt: now() + TOKEN_LIFETIME_SECONDS * 1000,
      refresh,
    });
    return access;
  };

  /** The bearer token's grant, or null. Expired and revoked tokens are not grants. */
  const grantOf = (request: Request): Grant | null => {
    const match = /^Bearer\s+(\S+)$/i.exec(
      request.headers.get("authorization") ?? "",
    );
    const grant = match ? accessTokens.get(match[1]) : undefined;
    return grant && grant.expiresAt > now() ? grant : null;
  };

  const unauthenticated = () =>
    googleError(
      401,
      "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
      "authError",
      {
        "www-authenticate":
          'Bearer realm="https://accounts.google.com/", error="invalid_token"',
      },
    );

  /** A message as Gmail's `users.messages.get` answers it, in the format asked for. */
  const resource = (message: StoredMessage, url: URL) => {
    const format = url.searchParams.get("format") ?? "full";
    const base = {
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds,
      snippet: snippetOf(message.text),
      historyId: "1",
      internalDate: String(message.internalDate),
      sizeEstimate: message.content.length + 400,
    };
    if (format === "minimal") return base;
    if (format === "metadata") {
      const wanted = url.searchParams
        .getAll("metadataHeaders")
        .map((name) => name.toLowerCase());
      return {
        ...base,
        payload: {
          partId: "",
          mimeType: message.mimeType,
          filename: "",
          headers:
            wanted.length === 0
              ? message.headers
              : message.headers.filter((header) =>
                  wanted.includes(header.name.toLowerCase()),
                ),
        },
      };
    }
    const bytes = Buffer.from(message.content, "utf8");
    return {
      ...base,
      payload: {
        partId: "",
        mimeType: message.mimeType,
        filename: "",
        headers: message.headers,
        // Already decoded from any transfer encoding, then base64url: what Gmail hands back.
        body: { size: bytes.length, data: bytes.toString("base64url") },
      },
    };
  };

  const send = async (request: Request) => {
    const body = (await request.json().catch(() => null)) as {
      raw?: unknown;
      threadId?: unknown;
    } | null;
    if (typeof body?.raw !== "string" || body.raw === "") {
      return googleError(
        400,
        "'raw' RFC822 payload message string or uploading message via /upload/* URL required",
        "invalidArgument",
      );
    }
    const { headers, body: text } = parseEntity(
      Buffer.from(body.raw, "base64").toString("latin1"),
    );
    const to = addresses(decodeWords(headerValue(headers, "To") ?? ""));
    const cc = addresses(decodeWords(headerValue(headers, "Cc") ?? ""));
    const bcc = addresses(decodeWords(headerValue(headers, "Bcc") ?? ""));
    if (to.length + cc.length + bcc.length === 0) {
      return googleError(400, "Recipient address required", "invalidArgument");
    }

    const requested =
      typeof body.threadId === "string" && body.threadId ? body.threadId : null;
    if (
      requested &&
      !messages.some((message) => message.threadId === requested)
    ) {
      return googleError(404, "Requested entity was not found.", "notFound");
    }
    /*
     * Gmail files a reply in the thread it names only when the reply's In-Reply-To or References
     * point at a message in that thread; otherwise it starts a new one. Reproduced, so a reply
     * whose threading headers are wrong shows up here as a new thread rather than passing.
     */
    const inReplyTo = headerValue(headers, "In-Reply-To") ?? null;
    const references = headerValue(headers, "References") ?? null;
    const cited = `${inReplyTo ?? ""} ${references ?? ""}`;
    const threaded =
      requested !== null &&
      messages.some(
        (message) =>
          message.threadId === requested &&
          cited.includes(headerValue(message.headers, "Message-ID") ?? "\0"),
      );

    const instant = now();
    const id = hex(
      `fake-google:sent:${instant}:${sent.length}:${body.raw}`,
    ).slice(0, 16);
    const threadId = threaded && requested ? requested : id;
    const subject = decodeWords(headerValue(headers, "Subject") ?? "");
    messages.unshift({
      id,
      threadId,
      labelIds: ["SENT"],
      internalDate: instant,
      headers: [
        { name: "From", value: `Maya Okafor <${FAKE_ACCOUNT}>` },
        ...headers.filter(
          (header) =>
            !/^(from|bcc|date|message-id|content-transfer-encoding)$/i.test(
              header.name,
            ),
        ),
        { name: "Date", value: mailDate(instant, STUDIO_OFFSET_MINUTES) },
        { name: "Message-ID", value: `<${id}@mail.gmail.com>` },
      ].map((header) =>
        /^(subject|to|cc)$/i.test(header.name)
          ? { name: header.name, value: decodeWords(header.value) }
          : header.name.toLowerCase() === "content-type"
            ? { name: header.name, value: 'text/plain; charset="UTF-8"' }
            : header,
      ),
      mimeType: "text/plain",
      content: text,
      text,
    });
    sent.push({
      id,
      threadId,
      to,
      cc,
      bcc,
      subject,
      body: text,
      inReplyTo,
      references,
    });
    return Response.json({ id, threadId, labelIds: ["SENT"] });
  };

  /** One new message in the inbox, dated now, as though it had just arrived. */
  const deliver = (delivery: Delivery) => {
    const instant = now();
    delivered += 1;
    const digest = hex(
      `fake-google:delivered:${instant}:${delivered}:${delivery.subject}`,
    );
    const id = digest.slice(0, 16);
    const cc = delivery.cc ?? [];
    messages.unshift({
      id,
      threadId: id,
      labelIds: delivery.labels ?? ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
      internalDate: instant,
      headers: [
        { name: "From", value: delivery.from },
        { name: "To", value: (delivery.to ?? [FAKE_ACCOUNT]).join(", ") },
        ...(cc.length > 0 ? [{ name: "Cc", value: cc.join(", ") }] : []),
        { name: "Subject", value: delivery.subject },
        { name: "Date", value: mailDate(instant, STUDIO_OFFSET_MINUTES) },
        {
          name: "Message-ID",
          value: `<${id}.${digest.slice(16, 24)}@${domainOf(delivery.from)}>`,
        },
        { name: "MIME-Version", value: "1.0" },
        { name: "Content-Type", value: 'text/plain; charset="UTF-8"' },
      ],
      mimeType: "text/plain",
      content: delivery.body,
      text: delivery.body,
    });
    return { id, threadId: id };
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    // OAuth: consent, tokens and revocation. None of these take a bearer token.
    if (method === "GET" && path === "/o/oauth2/v2/auth") {
      const redirectUri = url.searchParams.get("redirect_uri");
      if (!redirectUri) {
        return page(
          `<p>Fake Google: signed in as <strong>${FAKE_ACCOUNT}</strong>.</p><p>Nothing here is real mail.</p>`,
        );
      }
      if (!URL.canParse(redirectUri)) {
        return page("<p>Fake Google: redirect_uri is not a URL.</p>", 400);
      }
      const code = token("fake-code-");
      const scope = url.searchParams.get("scope") || DEFAULT_SCOPE;
      codes.set(code, {
        scope,
        redirectUri,
        challenge: url.searchParams.get("code_challenge"),
        method: url.searchParams.get("code_challenge_method") ?? "plain",
      });
      // Consented on the person's behalf: there is no person here to ask.
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("scope", scope);
      const state = url.searchParams.get("state");
      if (state !== null) back.searchParams.set("state", state);
      return Response.redirect(back.toString(), 302);
    }

    if (method === "POST" && path === "/token") {
      const fields = await fieldsOf(request);
      if (!fields.client_id) {
        return Response.json(
          {
            error: "invalid_client",
            error_description: "The OAuth client was not found.",
          },
          { status: 401 },
        );
      }

      if (fields.grant_type === "authorization_code") {
        const grant = fields.code ? codes.get(fields.code) : undefined;
        if (!grant) {
          return Response.json(
            {
              error: "invalid_grant",
              error_description: "Malformed auth code.",
            },
            { status: 400 },
          );
        }
        codes.delete(fields.code);
        if (fields.redirect_uri !== grant.redirectUri) {
          return Response.json(
            {
              error: "redirect_uri_mismatch",
              error_description: "Bad Request",
            },
            { status: 400 },
          );
        }
        // PKCE, checked the way Google checks it, so a client that gets it wrong finds out here.
        if (grant.challenge !== null) {
          const verifier = fields.code_verifier ?? "";
          const expected =
            grant.method === "S256"
              ? sha256(verifier).toString("base64url")
              : verifier;
          if (expected !== grant.challenge) {
            return Response.json(
              {
                error: "invalid_grant",
                error_description: "Invalid code verifier.",
              },
              { status: 400 },
            );
          }
        }
        const refresh = token("fake-refresh-");
        refreshTokens.set(refresh, grant.scope);
        return Response.json({
          access_token: issue(grant.scope, refresh),
          refresh_token: refresh,
          expires_in: TOKEN_LIFETIME_SECONDS,
          scope: grant.scope,
          token_type: "Bearer",
        });
      }

      if (fields.grant_type === "refresh_token") {
        const refresh = fields.refresh_token ?? "";
        /*
         * A refresh token this fake issued before it last restarted is honoured too, so restarting
         * the fake in the middle of a demo does not make everybody reconnect. One it revoked is not.
         */
        if (
          revoked.has(refresh) ||
          (!refreshTokens.has(refresh) && !refresh.startsWith("fake-refresh-"))
        ) {
          return Response.json(
            {
              error: "invalid_grant",
              error_description: "Token has been expired or revoked.",
            },
            { status: 400 },
          );
        }
        const scope = refreshTokens.get(refresh) ?? DEFAULT_SCOPE;
        refreshTokens.set(refresh, scope);
        return Response.json({
          access_token: issue(scope, refresh),
          refresh_token: refresh,
          expires_in: TOKEN_LIFETIME_SECONDS,
          scope,
          token_type: "Bearer",
        });
      }

      return Response.json(
        {
          error: "unsupported_grant_type",
          error_description: "Invalid grant_type.",
        },
        { status: 400 },
      );
    }

    if (method === "POST" && path === "/revoke") {
      const fields = await fieldsOf(request);
      const revokedToken = fields.token ?? url.searchParams.get("token") ?? "";
      /*
       * Google ends the whole grant whichever token is revoked: the refresh token, and every access
       * token minted from it. So does this, which is what lets a disconnect be tested here.
       */
      const refresh =
        accessTokens.get(revokedToken)?.refresh ??
        (revokedToken.startsWith("fake-refresh-") ? revokedToken : null);
      accessTokens.delete(revokedToken);
      if (refresh !== null) {
        revoked.add(refresh);
        refreshTokens.delete(refresh);
        for (const [access, grant] of accessTokens) {
          if (grant.refresh === refresh) accessTokens.delete(access);
        }
      }
      return Response.json({});
    }

    // Inspection, for tests and demos. Unauthenticated: there is nothing real here to protect.
    if (method === "GET" && path === "/__fake/sent") return Response.json(sent);
    if (method === "POST" && path === "/__fake/reset") {
      reset();
      return Response.json({ ok: true });
    }
    if (method === "POST" && path === "/__fake/deliver") {
      const delivery = readDelivery(await request.json().catch(() => null));
      if (typeof delivery === "string") {
        return googleError(400, delivery, "invalidArgument");
      }
      return Response.json(deliver(delivery), { status: 201 });
    }
    if (method === "GET" && path === "/") {
      return page(
        `<p>Fake Google: signed in as <strong>${FAKE_ACCOUNT}</strong>.</p><p>${messages.length} messages, ${events.length} events today, ${sent.length} sent.</p>`,
      );
    }

    // Everything below is Google's API and needs a token, as Google's does.
    const isApi =
      path.startsWith("/gmail/v1/") || path.startsWith("/calendar/v3/");
    if (!isApi) {
      return googleError(
        404,
        `${method} ${path} is not something this fake serves.`,
        "notFound",
      );
    }
    if (!grantOf(request)) return unauthenticated();

    if (method === "GET" && path === "/gmail/v1/users/me/profile") {
      return Response.json({
        emailAddress: FAKE_ACCOUNT,
        messagesTotal: messages.length,
        threadsTotal: new Set(messages.map((message) => message.threadId)).size,
        historyId: "1",
      });
    }

    if (method === "GET" && path === "/gmail/v1/users/me/messages") {
      const query = url.searchParams.get("q") ?? "";
      const max = Math.min(
        Math.max(Number(url.searchParams.get("maxResults") ?? 100) || 100, 1),
        500,
      );
      const offset = Number(url.searchParams.get("pageToken") ?? 0) || 0;
      const matching = messages.filter((message) =>
        matchesQuery(message, query, now()),
      );
      const listed = matching.slice(offset, offset + max);
      return Response.json({
        ...(listed.length > 0
          ? {
              messages: listed.map((message) => ({
                id: message.id,
                threadId: message.threadId,
              })),
            }
          : {}),
        ...(offset + max < matching.length
          ? { nextPageToken: String(offset + max) }
          : {}),
        resultSizeEstimate: matching.length,
      });
    }

    if (method === "POST" && path === "/gmail/v1/users/me/messages/send") {
      return send(request);
    }

    const single = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path);
    if (method === "GET" && single) {
      const message = messages.find(
        (candidate) => candidate.id === decodeURIComponent(single[1]),
      );
      if (!message) {
        return googleError(404, "Requested entity was not found.", "notFound");
      }
      if (url.searchParams.get("format") === "raw") {
        return googleError(
          400,
          "This fake does not serve format=raw.",
          "invalidArgument",
        );
      }
      return Response.json(resource(message, url));
    }

    // The calendar itself, which is where Google keeps the zone its owner's days are in.
    if (method === "GET" && path === "/calendar/v3/calendars/primary") {
      return Response.json({
        kind: "calendar#calendar",
        id: FAKE_ACCOUNT,
        summary: FAKE_ACCOUNT,
        timeZone: STUDIO_TIME_ZONE,
      });
    }

    if (method === "GET" && path === "/calendar/v3/calendars/primary/events") {
      const bound = (name: string) => {
        const value = url.searchParams.get(name);
        return value === null ? null : Date.parse(value);
      };
      const timeMin = bound("timeMin");
      const timeMax = bound("timeMax");
      if (Number.isNaN(timeMin) || Number.isNaN(timeMax)) {
        return googleError(400, "Bad Request", "badRequest");
      }
      // Google refuses this combination, so a client that sends it should hear about it here.
      if (
        url.searchParams.get("orderBy") === "startTime" &&
        url.searchParams.get("singleEvents") !== "true"
      ) {
        return googleError(
          400,
          "The requested ordering is not available for the particular query.",
          "invalid",
        );
      }
      const max = Math.max(
        Number(url.searchParams.get("maxResults") ?? 250) || 250,
        1,
      );
      // Google's bounds: timeMin against an event's end, timeMax against its start, both exclusive.
      const items = events
        .filter(
          ({ span: [start, end] }) =>
            (timeMin === null || end > timeMin) &&
            (timeMax === null || start < timeMax),
        )
        .slice(0, max)
        .map(({ span: _span, ...event }) => event);
      return Response.json({
        kind: "calendar#events",
        summary: FAKE_ACCOUNT,
        timeZone: STUDIO_TIME_ZONE,
        items,
      });
    }

    return googleError(404, "Requested entity was not found.", "notFound");
  };

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: async (request) => {
      const response = await handle(request);
      if (options.log) {
        console.log(
          `${request.method} ${new URL(request.url).pathname} ${response.status}`,
        );
      }
      return response;
    },
  });

  const url = `http://${server.hostname}:${server.port}`;
  return {
    url,
    port: server.port ?? 0,
    sent: () => sent.map((message) => ({ ...message })),
    reset,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/** `--port 4900` or `--port=4900`, and the same for `--host`. */
function flag(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === `--${name}`) return args[index + 1];
    if (args[index].startsWith(`--${name}=`)) {
      return args[index].slice(name.length + 3);
    }
  }
  return undefined;
}

if (import.meta.main) {
  const port = Number(flag("port") ?? 4900);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`--port must be a port number, not ${flag("port")}.`);
    process.exit(1);
  }
  const fake = startFakeGoogle({
    port,
    hostname: flag("host") ?? "127.0.0.1",
    log: true,
  });
  console.log(
    [
      `Fake Google on ${fake.url}, signed in as ${FAKE_ACCOUNT}.`,
      `Point OpenBot at it with OPENDUET_FAKE_GOOGLE_URL=${fake.url} in openbot/.env.`,
      `See what was sent: curl ${fake.url}/__fake/sent`,
      `Deliver new mail: curl -X POST ${fake.url}/__fake/deliver -H 'content-type: application/json' -d '{"from":"…","subject":"…","body":"…"}'`,
      `Start over: curl -X POST ${fake.url}/__fake/reset`,
    ].join("\n"),
  );
}
