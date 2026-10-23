/**
 * What a conversation is called wherever a person sees it: the menu's row and the title pill of the
 * conversation's own page. One rule, so the two never disagree.
 *
 * Its summary first, then what was last said in it, as plain text either way: the Bot writes
 * markdown, and `**What I think you do:**` is not a title. Never the channel's `name`, which is the
 * Bot's name and so is the same for every conversation with it.
 */
export function conversationTitle(
  conversation:
    | { summary?: string | null; lastMessage?: string | null }
    | undefined,
): string {
  return (
    plainText(conversation?.summary ?? "") ||
    plainText(conversation?.lastMessage ?? "") ||
    NEW_CONVERSATION
  );
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
