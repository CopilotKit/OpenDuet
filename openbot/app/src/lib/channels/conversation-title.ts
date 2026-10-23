import type { Message } from "@ag-ui/core";
import { queryOptions } from "@tanstack/react-query";
import { readThreadMessages } from "@/lib/copilot/thread-messages";
import { readFirstDay } from "./first-day";
import { readFiring } from "./routine-firing";

/**
 * What a conversation is called wherever a person sees it: the menu's row and the title pill of the
 * conversation's own page.
 *
 * Its summary first, as plain text: the Bot writes markdown, and `**What I think you do:**` is not a
 * title. Without one, what the person first asked in it, which is what the conversation is about
 * and does not change as it goes on; the menu, which has no first message to hand, falls back to
 * what was last said. Never the channel's `name`, which is the Bot's name and so is the same for
 * every conversation with it.
 */
export function conversationTitle(
  conversation:
    | {
        summary?: string | null;
        firstMessage?: string | null;
        lastMessage?: string | null;
      }
    | undefined,
): string {
  return (
    plainText(conversation?.summary ?? "") ||
    plainText(conversation?.firstMessage ?? "") ||
    plainText(conversation?.lastMessage ?? "") ||
    NEW_CONVERSATION
  );
}

/** What the person first said in a thread: their own words, not a routine firing or Chat's greeting. */
export function firstPersonMessage(
  messages: readonly Message[],
): string | null {
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string")
      continue;
    if (readFiring(message.content) !== null) continue;
    if (readFirstDay(message.content) !== null) continue;
    if (message.content.trim()) return message.content;
  }
  return null;
}

/**
 * The person's first message in a conversation's thread, for its title. `said` is whether anything
 * has been said there yet, so a conversation that was empty is read again once it is not.
 */
export function firstMessageQueryOptions(
  threadId: string,
  agentId: string,
  said: boolean,
) {
  return queryOptions({
    queryKey: ["channels", "first-message", threadId, agentId, said] as const,
    queryFn: async () =>
      firstPersonMessage(
        (await readThreadMessages(threadId, agentId)).messages,
      ),
    // What was asked first never changes.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** What a conversation is called before anything has been said in it. */
export const NEW_CONVERSATION = "New conversation";

/**
 * Markdown as one line of plain text: links keep their words, and emphasis, code ticks, headings,
 * quotes and list bullets lose their marks. Underscores inside a word (`gmail_search`) are kept.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|\*|~~|`)/g, "")
    .replace(/(^|\s)_(\S[^_]*\S|\S)_(?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
