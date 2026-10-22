import { PillButton } from "@/components/approvals/approval-card";

/**
 * What "Get to know me" sends. It is the person's own message, in the thread for them to read, so
 * the Bot works from a request anybody can see rather than an instruction hidden in front of the
 * run. The `first-day` skill in the tenant package names the mail and calendar tools it needs.
 */
export const FIRST_DAY_REQUEST =
  "Get to know me. Look through my recent mail and this week's calendar. In a few sentences, tell me what you think I do. Then give me three ways you can help, one line each. I'll correct anything that's off.";

/**
 * Chat before its first message: an offer to start by learning about the person, the way a new
 * colleague would on their first day. The composer below still takes anything else.
 */
export function FirstDay({
  name,
  busy,
  onStart,
}: {
  name: string;
  busy: boolean;
  onStart: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-1 px-1 pt-2">
      <h1 className="type-title font-semibold">Let's get to know each other</h1>
      <p className="type-sub text-duet-ink-2">
        {name} reads your connected mail and calendar. Then it tells you how it
        can help.
      </p>
      <PillButton
        className="mt-4 flex-none px-6"
        disabled={busy}
        onClick={onStart}
        primary
      >
        Get to know me
      </PillButton>
      <p className="type-label mt-2 text-duet-ink-3">Or ask anything below.</p>
    </div>
  );
}
