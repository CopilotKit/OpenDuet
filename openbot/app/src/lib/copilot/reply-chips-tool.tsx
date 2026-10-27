import { useRenderTool } from "@copilotkit/react-core/v2";
import { useState } from "react";
import { z } from "zod";
import { repliesShown } from "@/components/channels/chat-messages";
import { useConversationSend } from "@/components/channels/conversation-send";
import {
  BuildIn,
  BuildInProvider,
  useArrivedLive,
} from "@/components/duet/build-in";
import { DuetIcon } from "@/components/duet/icons";
import { cn } from "@/lib/utils";

/*
 * Draws the server's `suggest_replies` tool (server/src/openduet/replies.ts) as the film's reply
 * chips: a row of pills under the Bot's question. Tapping one sends its words as the person's own
 * message, through the conversation's send (components/channels/conversation-send.tsx), so the Bot
 * reads a tap exactly as it reads typing. The transcript draws them at the end of their turn, under
 * the Bot's last words, wherever in the turn the call was made (`repliesLast` in chat-messages.ts).
 *
 * Live only on the Bot's latest turn, and only until one is tapped or the person says something
 * else. After that the row stays as a record of what was offered, with the tapped one marked, and
 * nothing on it can be pressed: a chip from an earlier turn would answer a question nobody is asking.
 */

export const REPLIES_TOOL = "suggest_replies";

const parameters = z.object({ replies: z.array(z.string()).optional() });

/**
 * The replies to draw, or null while the call is still running, when the server refused them, or
 * when the runtime rejected them before the tool ran (`repliesShown`). The server is what decides a
 * set of replies is good; this only takes what it accepted.
 */
export function readReplies(
  args: { replies?: unknown } | undefined,
  result: unknown,
): string[] | null {
  if (typeof result !== "string" || !repliesShown(result)) return null;
  const replies = Array.isArray(args?.replies)
    ? args.replies
        .filter((reply): reply is string => typeof reply === "string")
        .map((reply) => reply.trim())
        .filter(Boolean)
    : [];
  const distinct = [...new Set(replies)].slice(0, 3);
  return distinct.length > 0 ? distinct : null;
}

export function ReplyChips({
  toolCallId,
  replies,
}: {
  /**
   * The call that offered them, which keeps them live only on the Bot's latest turn. Absent for
   * chips the app draws itself, such as the first day's (`FirstDayReplies` in chat-transcript.tsx),
   * whose caller draws them only while they answer the latest turn.
   */
  toolCallId?: string;
  replies: readonly string[];
}) {
  const conversation = useConversationSend();
  const [tapped, setTapped] = useState<string | null>(null);
  // Chips offered while the turn is still being written arrive one after another (build-in.tsx).
  const arrived = useArrivedLive(false);
  // Nowhere to send to, such as CopilotKit's own chat: the Bot's question still reads on its own.
  if (!conversation) return null;
  const live =
    tapped === null &&
    (toolCallId === undefined || conversation.isLatestTurn(toolCallId));
  return (
    // A fieldset is a group to a screen reader, named by its label, so the chips are heard as one set.
    <BuildInProvider value={arrived}>
      <fieldset
        aria-label="Suggested replies"
        className="duet-face flex min-w-0 flex-wrap gap-2"
      >
        {replies.map((reply, index) => {
          const chosen = reply === tapped;
          return (
            <BuildIn className="max-w-full" key={reply} order={index}>
              <button
                className={cn(
                  // parity-spec 2.14: a reply glyph, the sub size at regular weight, a hairline, 44px tall.
                  // Fill, ink and ring cross over together when one is chosen and the rest go quiet.
                  "type-sub inline-flex h-11 max-w-full items-center gap-1.5 rounded-full pr-[18px] pl-3.5 font-normal outline-none transition-[transform,background-color,color,box-shadow] duration-[var(--duet-dur-tap)] focus-visible:ring-2 focus-visible:ring-duet-accent focus-visible:ring-offset-2 focus-visible:ring-offset-duet-surface",
                  chosen
                    ? "bg-duet-violet-soft text-duet-violet shadow-[0_0_0_1px_color-mix(in_oklab,var(--duet-violet)_28%,transparent)]"
                    : "bg-duet-card shadow-[0_0_0_1px_var(--duet-hair)]",
                  !chosen && (live ? "text-duet-ink" : "text-duet-ink-3"),
                  live &&
                    "cursor-pointer active:bg-duet-tile motion-safe:active:scale-[0.96]",
                )}
                data-chosen={chosen || undefined}
                disabled={!live}
                onClick={() => {
                  // Marked only once it went: a reply the conversation could not take stays pressable.
                  if (conversation.send(reply)) setTapped(reply);
                }}
                type="button"
              >
                <DuetIcon
                  className="shrink-0 text-duet-ink-3"
                  name="reply"
                  size={16}
                />
                <span className="truncate">{reply}</span>
              </button>
            </BuildIn>
          );
        })}
      </fieldset>
    </BuildInProvider>
  );
}

export function ReplyChipsTool() {
  useRenderTool({
    name: REPLIES_TOOL,
    parameters,
    render: ({ toolCallId, parameters, result }) => {
      const replies = readReplies(parameters, result);
      /*
       * Nothing while the call runs, and nothing for a refusal. The Bot is told why it was refused
       * and tries again; a line saying so would show the person the Bot's mistake, not a choice.
       */
      return replies ? (
        <ReplyChips replies={replies} toolCallId={toolCallId} />
      ) : null;
    },
  });
  return null;
}
