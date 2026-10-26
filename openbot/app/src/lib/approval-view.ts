import type { ApprovalRequest } from "./approvals";

/**
 * How an approval request reads on a card: a title in plain words, the app it is for, the fields a
 * person checks before saying yes (To, Subject), and the body. Built only from what the request
 * carries; anything it cannot place stays in the card's details.
 */
export type ApprovalView = {
  title: string;
  app: string | null;
  kind: "mail" | "browser" | "command" | "other";
  fields: { label: string; value: string }[];
  body: string | null;
};

const RECIPIENT =
  /^(to|recipients?|recipient_?emails?|to_?emails?|to_?address(es)?|email_?to|send_?to)$/i;
const SUBJECT = /^(subject|title)$/i;
const BODY = /^(body|text|message|content|message_?body|html|plain_?text)$/i;
/** Plumbing the person cannot act on: the Bot's own page references and ids. */
const HIDDEN =
  /^(ref|snapshot_?id|element_?ref|id|thread_?id|tool_?call_?id)$/i;
const MAX_FIELDS = 4;

const words = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

const sentence = (parts: string[]) => {
  const text = parts.join(" ");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
};

const display = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string")
  )
    return value.join(", ");
  return null;
};

/** The ref the server's private-share check asks under (server/src/proactive/private-share.ts). */
const PRIVATE_SHARE = "openbot/share_private_information";

/** Apps a send can name as `<server id>: <recipients>`, in the words a person knows them by. */
const SENDING_APPS: Record<
  string,
  { app: string; kind: ApprovalView["kind"] }
> = {
  "google-workspace": { app: "Gmail", kind: "mail" },
  gmail: { app: "Gmail", kind: "mail" },
};

/**
 * A send to other people, as the private-share check asks about it.
 *
 * The check asks before the send itself, so its request carries the audience as `<server id>:
 * <recipients>` and the message in the parts its recipient sees: `to`, `cc`, `bcc`, `subject` and
 * the whole `body` (server/src/proactive/private-share.ts). Read as the message it is: the app, who
 * it goes to, the subject on its own line and the body under it. The content digest is how the
 * server matches a later send to this answer; it means nothing to the person and is left out.
 *
 * A request asked before the parts existed has only the audience and a `preview`, which was the
 * body's first 280 characters with the subject glued on; it is read the old way rather than not at
 * all, since it is already decided.
 */
function describeShare(args: Record<string, unknown>): ApprovalView {
  const audience = display(args.audience) ?? "";
  const split = audience.indexOf(": ");
  const server = split > 0 ? audience.slice(0, split) : "";
  const known = SENDING_APPS[server];
  const to =
    display(args.to) ?? (split > 0 ? audience.slice(split + 2) : audience);
  const fields: ApprovalView["fields"] = [];
  if (to) fields.push({ label: "To", value: to });
  for (const [key, label] of [
    ["cc", "Cc"],
    ["bcc", "Bcc"],
    ["subject", "Subject"],
  ] as const) {
    const value = display(args[key]);
    if (value) fields.push({ label, value });
  }
  return {
    title: known?.kind === "mail" ? "Send email" : "Send a message",
    app: known?.app ?? (server ? sentence(words(server)) : null),
    kind: known?.kind ?? "other",
    fields,
    // Untrimmed: what is shown is what goes, to the last line break.
    body:
      typeof args.body === "string" && args.body.trim()
        ? args.body
        : display(args.preview),
  };
}

/**
 * Where an action happens, as a person reads it. The scope is the server's matching key, and for a
 * send to other people it carries the share check's `external:` marker, which is plumbing.
 */
export function approvalPlace(
  request: Pick<ApprovalRequest, "action">,
): string {
  return request.action.scope.replace(/^external:/, "");
}

/** Whether the person was asked about this request, rather than a saved rule deciding it. */
export function personWasAsked(
  request: Pick<ApprovalRequest, "action">,
): boolean {
  return (
    Boolean(request.action.policy) || request.action.toolRef === PRIVATE_SHARE
  );
}

export function describeApproval(
  request: Pick<ApprovalRequest, "action">,
): ApprovalView {
  const { toolRef, args } = request.action;
  if (
    toolRef === PRIVATE_SHARE &&
    args &&
    typeof args === "object" &&
    !Array.isArray(args)
  )
    return describeShare(args as Record<string, unknown>);
  const segments = toolRef.split("/").filter(Boolean);
  const name = segments.at(-1) ?? toolRef;
  const prefix = segments.length > 1 ? segments[0] : null;
  const app =
    prefix && !["host", "bot", "computer"].includes(prefix.toLowerCase())
      ? sentence(words(prefix))
      : null;
  let parts = words(name.replace(/^computer_/, ""));
  // "gmail/GMAIL_SEND_EMAIL" reads "Send email", with Gmail as the app.
  if (prefix && parts[0] === prefix.toLowerCase() && parts.length > 1)
    parts = parts.slice(1);

  const kind: ApprovalView["kind"] = /^computer_/.test(name)
    ? "browser"
    : prefix === "host"
      ? "command"
      : /mail|message|send|reply/i.test(toolRef)
        ? "mail"
        : "other";

  const fields: ApprovalView["fields"] = [];
  let body: string | null = null;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>);
    const pick = (pattern: RegExp, label: string) => {
      for (const [key, value] of entries) {
        if (!pattern.test(key)) continue;
        const shown = display(value);
        if (shown) fields.push({ label, value: shown });
        return;
      }
    };
    pick(RECIPIENT, "To");
    pick(/^cc$/i, "Cc");
    pick(/^bcc$/i, "Bcc");
    pick(SUBJECT, "Subject");
    for (const [key, value] of entries) {
      if (!BODY.test(key)) continue;
      body = display(value);
      if (body) break;
    }
    for (const [key, value] of entries) {
      if (fields.length >= MAX_FIELDS) break;
      if ([RECIPIENT, SUBJECT, BODY, HIDDEN].some((test) => test.test(key)))
        continue;
      if (/^b?cc$/i.test(key)) continue;
      const shown = display(value);
      if (shown) fields.push({ label: sentence(words(key)), value: shown });
    }
  }

  return { title: sentence(parts) || toolRef, app, kind, fields, body };
}

/** Who decided, in the person's words, for the line under a decided card. */
export function decisionReceipt(
  request: Pick<ApprovalRequest, "decision">,
): string | null {
  switch (request.decision) {
    case "allow_once":
      return "Allowed once by you";
    case "allow_always":
      return "Always allowed";
    case "deny":
      return "Refused by you";
    case "handled":
      return "You did it yourself";
    default:
      return null;
  }
}

/** How the action ended, as the pill on a decided card shows it. Nothing while it waits. */
export function approvalOutcome(
  request: Pick<ApprovalRequest, "status" | "result" | "action">,
): { label: string; tone: "green" | "red" | "amber" | "blue" } | null {
  switch (request.status) {
    case "completed":
      if (request.result?.error) return { label: "Didn't work", tone: "amber" };
      return {
        label:
          describeApproval(request).kind === "mail" &&
          /send|reply/i.test(request.action.toolRef)
            ? "Sent"
            : "Done",
        tone: "green",
      };
    case "denied":
      return { label: "Refused", tone: "red" };
    case "approved":
    case "consumed":
      return { label: "Allowed", tone: "blue" };
    default:
      return null;
  }
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/** "2:59 PM" today, "Oct 20" before that: the stamp on a card or a row. */
export function clockTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return at.toDateString() === now.toDateString()
    ? timeFormat.format(at)
    : dayFormat.format(at);
}
