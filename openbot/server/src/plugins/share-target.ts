import type { ShareAudience, SharedMessage } from "../proactive/private-share";

/**
 * Whether a connector write sends content to other people, and to whom.
 *
 * The private-share check (proactive/private-share.ts) asks the owner before a Bot shares something
 * from their private conversation or memory with anybody else. A connector call is the widest door
 * for that: a Slack message, a Teams post, an email. This names the calls that go through it.
 *
 * By name, because neither MCP nor Composio publishes "this tool messages people": a write whose name
 * says it sends, posts, replies, forwards, shares or comments is a send. A write that only changes
 * the owner's own data (create a draft, update a row) is not, and passes on to the ordinary gates.
 * Read calls never reach this. Over-inclusive on purpose: asking once about a send that turned out
 * to be private costs a click; not asking about one that was public costs the person their privacy.
 */
const SENDS =
  /(^|[_\-.\s])(send|post|reply|respond|forward|share|comment|publish|broadcast|invite|notify|message|chat[_-]?post|create[_-]?message|create[_-]?post|create[_-]?comment)([_\-.\s]|s?$)/i;
/** A write that only stages something for the owner, which sends nothing yet. */
const STAGES = /(^|[_\-.\s])(draft|drafts)([_\-.\s]|$)/i;

/** What a person reads: the body of the message, in the order a tool is likeliest to carry it. */
const BODY_KEYS = [
  "text",
  "message",
  "body",
  "content",
  "markdown",
  "html",
  "comment",
  "blocks",
];
/** A subject line, shown apart from the body, because that is how the recipient sees it. */
const SUBJECT_KEY = "subject";
/**
 * Where it goes, as the approval's scope names it.
 *
 * THIS LIST AND ITS ORDER ARE THE SCOPE OF EVERY SAVED "ALWAYS ALLOW" FOR A SEND, so a key is only
 * ever appended: inserting one, or reordering, changes the scope an existing rule was saved under,
 * and that rule silently stops matching. The email spellings at the end were added after the first
 * ones shipped; before them a Composio `GMAIL_SEND_EMAIL` to `recipient_email` was scoped to the
 * tool's own name, so "always allow" on one recipient allowed every recipient.
 */
const RECIPIENT_KEYS = [
  "channel",
  "channel_id",
  "channelId",
  "conversation_id",
  "chat_id",
  "chatId",
  "thread_ts",
  "to",
  "cc",
  "bcc",
  "recipient",
  "recipients",
  "email",
  "user",
  "users",
  "team_id",
  "recipient_email",
  "recipient_emails",
  "extra_recipients",
  "to_email",
  "to_emails",
  "to_address",
  "to_addresses",
  "email_to",
  "send_to",
];
/** The recipient keys that are copies rather than the addressees. */
const COPY_KEYS = { cc: "cc", bcc: "bcc" } as const;
/** Recipient keys that place a message rather than name who reads it: a thread, a workspace. */
const PLACEMENT_KEYS = new Set(["thread_ts", "team_id"]);

function flatten(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(flatten).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Each addressee a value names: one per array entry, or the comma-separated parts of a string. A
 * comma inside quotes is part of a display name (`"Rivera, Sam" <sam@example.com>`), not a break.
 */
function addressees(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(addressees);
  if (typeof value === "string")
    return value
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((part) => part.trim())
      .filter(Boolean);
  return [flatten(value)].filter(Boolean);
}

export type ShareTarget = {
  audience: ShareAudience;
  /** The body, whole. What the person reads as the message. */
  content: string;
  /** The rest of what goes out, whole: who it goes to, the subject, and every other argument. */
  message: SharedMessage;
};

export function shareTargetOf(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): ShareTarget | null {
  const name = toolName.replace(/([a-z])([A-Z])/g, "$1_$2");
  if (!SENDS.test(name) || STAGES.test(name)) return null;
  const recipients = RECIPIENT_KEYS.map((key) => flatten(args[key]))
    .filter(Boolean)
    .join(" ");
  const id = (recipients || `${serverId}/${toolName}`).slice(0, 200);

  /*
   * THE MESSAGE IN THE PARTS ITS RECIPIENT SEES, WHOLE.
   *
   * It used to be one string, the body keys and then the subject joined by line breaks, which the
   * check then cut at 280 characters for its preview. So the approval card showed an email's first
   * 280 characters with the subject glued on as its last line, and the person allowed an email that
   * went out three times as long. Each part is kept apart and nothing is cut: the card shows To,
   * Subject and the body as the recipient will, and whatever else the call carries (a thread, an
   * attachment, a format flag) travels with them, so the approval is of the call that goes out and
   * not of a summary of it.
   */
  const shown = new Set<string>([SUBJECT_KEY]);
  const body = BODY_KEYS.flatMap((key) => {
    const value = flatten(args[key]);
    if (!value) return [];
    shown.add(key);
    return [value];
  }).join("\n");
  const to: string[] = [];
  const cc: string[] = [];
  const bcc: string[] = [];
  for (const key of RECIPIENT_KEYS) {
    if (PLACEMENT_KEYS.has(key) || args[key] === undefined) continue;
    shown.add(key);
    const list = key === COPY_KEYS.cc ? cc : key === COPY_KEYS.bcc ? bcc : to;
    list.push(...addressees(args[key]));
  }
  const subject =
    typeof args[SUBJECT_KEY] === "string" && args[SUBJECT_KEY]
      ? args[SUBJECT_KEY]
      : undefined;
  const alsoSent = Object.fromEntries(
    Object.entries(args).filter(([key]) => !shown.has(key)),
  );
  return {
    audience: {
      /*
       * Always `external`, including a Slack channel. Who can read a vendor's channel is the vendor's
       * to say, and this deployment does not know its members as user ids; `slack_channel` with no
       * recipients would read as "only the owner can see it" and pass unasked.
       */
      kind: "external",
      id,
      recipientUserIds: [],
      label: `${serverId}: ${id}`.slice(0, 200),
    },
    // A call with no body still sends something: its arguments, whole, are what the person reads.
    content: body || (subject ? "" : JSON.stringify(args)),
    message: {
      ...(to.length ? { to } : {}),
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      ...(subject ? { subject } : {}),
      ...(Object.keys(alsoSent).length ? { alsoSent } : {}),
    },
  };
}
