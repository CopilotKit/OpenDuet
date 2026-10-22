import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { personWasAsked } from "@/lib/approval-view";
import {
  type ApprovalInboxData,
  type ApprovalRequest,
  approvalInboxOptions,
  INBOX_POLL_MS,
} from "@/lib/approvals";
import { useReportFinish } from "./chat-presence";

/** How often the inbox is read while something the person allowed is running, so its finish is on time. */
const RUNNING_POLL_MS = 2_000;
/** How long after the decision an allowed action still counts as running, for that faster read. */
const RUNNING_FOR_MS = 2 * 60_000;

const ALLOWED = new Set<ApprovalRequest["decision"]>([
  "allow_once",
  "allow_always",
]);

/**
 * Whether this request is something the person allowed the Bot to do and that is now done: they
 * were asked rather than a saved rule deciding, they said Allow once or Always allow, and it ran
 * without an error. A refusal also ends completed, as the Bot is told about it; that is not this.
 */
export function finishedForYou(request: ApprovalRequest): boolean {
  return (
    request.status === "completed" &&
    ALLOWED.has(request.decision) &&
    personWasAsked(request) &&
    !request.result?.error
  );
}

/**
 * How often to read the inbox: every couple of seconds while an action the person allowed in the
 * last couple of minutes is still being carried out, otherwise as the inbox reads itself.
 */
export function inboxPollFor(
  data: ApprovalInboxData | undefined,
  now: number,
): number {
  const running = (data?.requests ?? []).some(
    (request) =>
      (request.status === "approved" || request.status === "consumed") &&
      ALLOWED.has(request.decision) &&
      now - Date.parse(request.decidedAt ?? "") < RUNNING_FOR_MS,
  );
  return running ? RUNNING_POLL_MS : INBOX_POLL_MS;
}

/**
 * Calls `onFinished` once for each action the person allowed that finishes while this is mounted
 * (`finishedForYou`), read from the approvals inbox.
 *
 * Only finishes it sees happen count: whatever had already completed in the first inbox it reads
 * is old news, and each request counts once, however many times the inbox is read after. While an
 * action the person allowed is running, the inbox is read every couple of seconds rather than
 * every ten, so the finish arrives with the action rather than up to ten seconds after it.
 */
export function useFinishedForYou(
  onFinished: (request: ApprovalRequest) => void,
) {
  const { data } = useQuery({
    ...approvalInboxOptions(),
    refetchInterval: (query) => inboxPollFor(query.state.data, Date.now()),
  });
  const notify = useRef(onFinished);
  useEffect(() => {
    notify.current = onFinished;
  });
  // The ids already completed when last read; null until the inbox is first read.
  const completed = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!data) return;
    const done = data.requests.filter(
      (request) => request.status === "completed",
    );
    if (!completed.current) {
      completed.current = new Set(done.map((request) => request.id));
      return;
    }
    for (const request of done) {
      if (completed.current.has(request.id)) continue;
      completed.current.add(request.id);
      if (finishedForYou(request)) notify.current(request);
    }
  }, [data]);
}

/** Reports every finish `useFinishedForYou` sees to the header, whose orb plays a check for it. */
export function FinishedForYou() {
  useFinishedForYou(useReportFinish());
  return null;
}
