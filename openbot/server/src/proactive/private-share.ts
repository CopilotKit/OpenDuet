/**
 * Before a Bot shares something from its owner's private conversation or memory with other
 * people, the owner has to have allowed it.
 *
 * WHAT COUNTS. Any send whose audience includes someone other than the owner: a Slack or channel
 * post others can read, a group conversation, a handoff to another person's Bot. Content that came
 * only from a conversation those same people are already in is not private to the owner and passes.
 * Everything else is treated as private, because a sender cannot prove otherwise.
 *
 * WHERE PERMISSION LIVES. In the existing approvals ledger, always on, regardless of the owner's
 * general approvals switch: this is a check dots makes unconditionally. An "allow always" answer is
 * a standing rule for this Bot and this audience; "allow once" covers ONE send of the same content
 * to the same audience in the same conversation, within thirty minutes of the person's last answer
 * in that step, so the Bot's retry after an approval passes instead of asking again.
 *
 * ONCE MEANS ONE SEND. The approval is the whole action here: the Bot is told to send again, and it
 * is that send which goes out. So the send spends the approval, atomically, before it goes, and a
 * second send of the same thing in the same conversation is refused rather than let through. Before
 * that, every send inside the window passed, and a continuation retried five times sent the same
 * email five times.
 *
 * OUTCOMES. `allowed`; `denied` (the person said no); or `pending`, where the caller must not send
 * and either throws the returned suspension (headless turns wait and resume on the decision) or
 * answers the model with the message.
 */
import { createHash } from "node:crypto";
import {
  type ApprovalContinuation,
  type ApprovalStore,
  approvalAction,
  currentApprovalContext,
} from "../approvals/types";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";

export const PRIVATE_SHARE_TOOL_REF = "openbot/share_private_information";
export const PRIVATE_SHARE_EFFECT = "share_private";
const ONCE_WINDOW_MS = 30 * 60_000;

export type ShareAudience = {
  /** Where it is going. Named in the approval the person sees. */
  kind: "slack_channel" | "channel" | "group" | "handoff" | "external";
  /** A stable id for where it is going: a Slack channel id, a group id, a person id. */
  id: string;
  /** Everyone who will be able to read it, as user ids where known. */
  recipientUserIds: readonly string[];
  /** Human label, e.g. "#design" or "Priya's Bot". */
  label?: string;
};

/**
 * The parts of a message other than its body, as its recipient will see them. A connector send
 * carries these (see plugins/share-target.ts); a group reply or a handoff is a body alone.
 */
export type SharedMessage = {
  to?: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject?: string;
  /** Every other argument of the call, exactly as it goes out: a thread, an attachment, a flag. */
  alsoSent?: Record<string, unknown>;
};

export type PrivateShareInput = {
  ownerUserId: string;
  botId: string;
  audience: ShareAudience;
  /**
   * The text about to be sent, which the approval carries whole: what the person allows is what
   * they were shown, so nothing about it is cut. Secret-looking values in it are still masked
   * where the approval is drawn (approvals/types.ts `approvalPreview`).
   */
  content: string;
  /** Who else it goes to, its subject, and the rest of the call. See {@link SharedMessage}. */
  message?: SharedMessage;
  /**
   * Where the content came from. `shared_conversation` with `sharedWithUserIds` naming the same
   * audience is the only origin that skips the check.
   */
  origin:
    | { kind: "private_conversation" | "memory" | "unknown" }
    | { kind: "shared_conversation"; sharedWithUserIds: readonly string[] };
  /** The run and tool call this send belongs to; defaults to the current approval context. */
  continuation?: ApprovalContinuation;
};

export type PrivateShareVerdict =
  | {
      status: "allowed";
      reason: string;
      /**
       * The person answered for this send themselves: an Always allow for this audience, or Allow
       * once for this exact content in this conversation. The gate uses it to skip a second review of
       * the same send; it does not lift any rule.
       */
      byPerson?: true;
    }
  | { status: "denied"; message: string }
  | {
      status: "pending";
      approvalId: string;
      message: string;
      suspension: HeadlessToolSuspension;
    };

/**
 * What a permission is for. A group or channel's people can change (any member can add someone), so
 * its scope names who was in it when the owner answered: a person added later is not covered by an
 * "always allow" given before they joined, and the owner is asked again.
 */
function audienceScope(audience: ShareAudience) {
  const where = `${audience.kind}:${audience.id}`;
  if (audience.kind !== "group" && audience.kind !== "channel") return where;
  const people = [...new Set(audience.recipientUserIds)].sort();
  const members = createHash("sha256")
    .update(people.join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `${where}:members:${members}`;
}

export function sharesWithOthers(input: PrivateShareInput) {
  return (
    input.audience.recipientUserIds.some((id) => id !== input.ownerUserId) ||
    input.audience.kind === "external"
  );
}

/** What the Bot hears when it sends again something the person allowed once and that already went. */
export const alreadySent = (audience: string) =>
  `Not sent again: you allowed this once, and that permission was already used to send it to ${audience}. Do not send it again unless the person asks you to.`;

const userTurns = (continuation: ApprovalContinuation | undefined) =>
  (continuation?.messages ?? []).filter((message) => message.role === "user")
    .length;

export function createPrivateShareCheck(deps: {
  approvals: Pick<ApprovalStore, "open" | "list" | "rules" | "consume">;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return async function checkPrivateShare(
    input: PrivateShareInput,
  ): Promise<PrivateShareVerdict> {
    if (!sharesWithOthers(input))
      return { status: "allowed", reason: "Only the owner can read it." };
    if (input.origin.kind === "shared_conversation") {
      const shared = new Set(input.origin.sharedWithUserIds);
      if (
        input.audience.kind !== "external" &&
        input.audience.recipientUserIds.every(
          (id) => id === input.ownerUserId || shared.has(id),
        )
      )
        return {
          status: "allowed",
          reason: "Everyone it goes to was already in the conversation.",
        };
    }
    const scope = audienceScope(input.audience);
    const alwaysAllowed = async () =>
      (await deps.approvals.rules(input.ownerUserId)).some(
        (rule) =>
          !rule.revokedAt &&
          rule.botId === input.botId &&
          rule.toolRef === PRIVATE_SHARE_TOOL_REF &&
          rule.effect === PRIVATE_SHARE_EFFECT &&
          rule.scope === scope,
      );
    const label = input.audience.label ?? scope;

    const continuation = input.continuation ?? currentApprovalContext();
    if (!continuation)
      return (await alwaysAllowed())
        ? {
            status: "allowed",
            reason: "You always allow this.",
            byPerson: true,
          }
        : {
            status: "denied",
            message:
              "Sharing private information with other people needs your permission, and this send is not part of a run that can ask. It was not sent.",
          };
    const contentDigest = createHash("sha256")
      .update(input.content)
      .digest("hex");
    /*
     * WHAT THE PERSON IS ASKED, WHOLE: who it goes to, the subject, the body and anything else the
     * call carries, each as the recipient will see it.
     *
     * It was `preview: content.slice(0, 280)`, with the subject appended to the body as its last
     * line and `recipients` counting user ids, which an email has none of. So the card stopped
     * mid-word with no sign there was more, Details said "recipients": 0 for an email to one person,
     * and Allow once sent 414 characters of which the person had seen 280.
     *
     * These are the approval's `args`, so they are also what its digest is taken over
     * (`approvalAction`): the send after the answer passes only if it is this same message to these
     * same people, and a send that differs in any part is a new question.
     */
    const { to, cc, bcc, subject, alsoSent } = input.message ?? {};
    const addressed = [...(to ?? []), ...(cc ?? []), ...(bcc ?? [])];
    const candidate = {
      actorId: input.ownerUserId,
      botId: input.botId,
      toolRef: PRIVATE_SHARE_TOOL_REF,
      effect: PRIVATE_SHARE_EFFECT,
      scope,
      args: {
        audience: label,
        recipients:
          input.audience.kind === "external"
            ? new Set(addressed).size || 1
            : input.audience.recipientUserIds.length,
        ...(to?.length ? { to: [...to] } : {}),
        ...(cc?.length ? { cc: [...cc] } : {}),
        ...(bcc?.length ? { bcc: [...bcc] } : {}),
        ...(subject ? { subject } : {}),
        body: input.content,
        ...(alsoSent && Object.keys(alsoSent).length ? { alsoSent } : {}),
        contentDigest,
      },
      target: { kind: input.audience.kind, id: input.audience.id },
      continuation,
    };
    const action = approvalAction(candidate);

    /*
     * The send after an approval: same content, same audience, same conversation, recently. Recent
     * from the person's last answer in the step it was asked in, because a step that asked twice is
     * carried on only once both are answered, however far apart.
     */
    const records = await deps.approvals.list(input.ownerUserId);
    const answeredAt = (runId: string) =>
      Math.max(
        ...records
          .filter((record) => record.action.runId === runId)
          .map((record) => record.decidedAt?.getTime() ?? 0),
      );
    const allowed = records.filter(
      (record) =>
        record.action.actionDigest === action.actionDigest &&
        record.action.threadId === action.threadId &&
        (record.decision === "allow_once" ||
          record.decision === "allow_always") &&
        now().getTime() - answeredAt(record.action.runId) < ONCE_WINDOW_MS,
    );
    // One send per answer: the first to spend it sends, and nobody else can spend it after.
    for (const permit of allowed)
      if (
        permit.status === "approved" &&
        (await deps.approvals.consume(
          input.ownerUserId,
          permit.id,
          permit.action.actionDigest,
        ))
      )
        return {
          status: "allowed",
          reason: "You allowed this share.",
          byPerson: true,
        };
    /*
     * Spent already, and the person has said nothing since: the same send again (a continuation run
     * a second time, or the Bot repeating itself), not a new one to put to them. Once they have
     * spoken, it is a new send and goes through the rule or the question below.
     */
    if (
      allowed.some(
        (permit) =>
          permit.consumedAt &&
          userTurns(permit.action.continuation) >= userTurns(continuation),
      )
    )
      return { status: "denied", message: alreadySent(label) };

    if (await alwaysAllowed())
      return {
        status: "allowed",
        reason: "You always allow this.",
        byPerson: true,
      };

    const request = await deps.approvals.open(action);
    if (request.status === "denied")
      return {
        status: "denied",
        message: "You declined sharing this with them. It was not sent.",
      };
    // This very send was answered before (a held group reply let out on its decision): it goes out
    // only if it spends that answer now.
    if (request.status !== "pending")
      return request.status === "approved" &&
        (await deps.approvals.consume(
          input.ownerUserId,
          request.id,
          action.actionDigest,
        ))
        ? { status: "allowed", reason: "You allowed this share." }
        : { status: "denied", message: alreadySent(label) };
    const message = `Waiting for permission to share private information with ${label}. Nothing was sent.`;
    return {
      status: "pending",
      approvalId: request.id,
      message,
      suspension: new HeadlessToolSuspension(message, {
        kind: "approval",
        approvalId: request.id,
        requestId: request.id,
        continuation: action.continuation,
      }),
    };
  };
}
export type CheckPrivateShare = ReturnType<typeof createPrivateShareCheck>;
