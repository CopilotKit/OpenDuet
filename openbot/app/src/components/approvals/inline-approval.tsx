import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { personWasAsked } from "@/lib/approval-view";
import {
  approvalInboxOptions,
  decideApprovalMutationOptions,
} from "@/lib/approvals";
import { ApprovalCard } from "./approval-card";

/**
 * A pending approval, drawn in the conversation where the action it holds would have been.
 *
 * The same request as the Inbox, read from the same owner-scoped inbox, so a decision made in
 * either place is the one decision. Once decided the server runs the action exactly once and
 * continues the conversation, and this gives the line back to the tool's own renderer, under a
 * folded card saying who decided. A request the gate never put to the person (a saved rule allowed
 * it) leaves no card behind.
 */
export function InlineApproval({
  toolCallId,
  fallback,
}: {
  toolCallId?: string;
  fallback: ReactNode;
}) {
  const cache = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
  const decision = useMutation(decideApprovalMutationOptions(cache));
  const request = toolCallId
    ? inbox.data?.requests.find(
        (candidate) => candidate.action.toolCallId === toolCallId,
      )
    : undefined;
  if (!request) return <>{fallback}</>;
  if (request.status !== "pending") {
    if (!personWasAsked(request) || !request.decision) return <>{fallback}</>;
    return (
      <div className="space-y-2">
        <ApprovalCard compact request={request} />
        {fallback}
      </div>
    );
  }
  return (
    <ApprovalCard
      busy={decision.isPending}
      error={decision.error?.message ?? null}
      onDecide={(choice) => decision.mutate({ id: request.id, choice })}
      request={request}
    />
  );
}

/**
 * The pending approvals for a group of tool calls, for a transcript that draws those calls itself
 * rather than through each tool's renderer: the browser-activity group folds every click and field
 * into one collapsed line, so a card inside a step would never be seen. Drawn beside the group,
 * outside the fold, one card per waiting call; nothing at all when none is waiting.
 */
export function PendingApprovals({
  toolCallIds,
}: {
  toolCallIds: readonly string[];
}) {
  const inbox = useQuery(approvalInboxOptions());
  const waiting = new Set(
    (inbox.data?.requests ?? [])
      .filter((request) => request.status === "pending")
      .flatMap((request) =>
        request.action.toolCallId ? [request.action.toolCallId] : [],
      ),
  );
  const ids = toolCallIds.filter((id) => waiting.has(id));
  if (ids.length === 0) return null;
  return (
    <div className="mt-3 space-y-3">
      {ids.map((id) => (
        <InlineApproval key={id} toolCallId={id} fallback={null} />
      ))}
    </div>
  );
}
