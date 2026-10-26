import { contentToText, type Message } from "@ag-ui/core";
import {
  describeChannelHello,
  readChannelHello,
} from "@openbot/shared/channel-hello";
import { describeCheckIn, readCheckIn } from "@openbot/shared/check-in";
import { queryOptions } from "@tanstack/react-query";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { readThreadMessages } from "@/lib/copilot/thread-messages";
import { readFirstDay } from "./first-day";
import { readMorningBrief } from "./morning-brief";
import { readFiring } from "./routine-firing";
import { readTaskBrief } from "./task-brief";

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
        /** Already selected and decoded by firstPersonMessage; quoted frames stay the person's words. */
        firstMessage?: string | null;
        lastMessage?: string | null;
      }
    | undefined,
): string {
  return (
    plainText(conversation?.summary ?? "") ||
    plainText(conversation?.firstMessage ?? "") ||
    titleText(conversation?.lastMessage) ||
    NEW_CONVERSATION
  );
}

/** A last-message fallback may still carry instructions the app added for the model. */
function titleText(text: string | null | undefined): string {
  if (!text) return "";
  const asked = readTaskBrief(text);
  if (asked !== null) return plainText(asked);
  const hello = readChannelHello(text);
  if (hello !== null) return plainText(describeChannelHello(hello));
  const checkIn = readCheckIn(text);
  if (checkIn !== null) return plainText(describeCheckIn(checkIn));
  // Asked for in the person's place on a later day, so it names nothing: the menu says no title.
  if (readMorningBrief(text) !== null) return "";
  return isFirstDayMessage(text)
    ? "Getting to know you"
    : plainText(readFiring(text) ?? text);
}

/** Both title projection and first-person selection recognize the app's opening request. */
function isFirstDayMessage(text: string): boolean {
  // The bare form covers conversations created before the first-day frame was introduced.
  return (
    readFirstDay(text) !== null ||
    /^Get to know me\. (?:Look through my recent mail|My Gmail and Google Calendar aren't connected yet)/.test(
      text,
    )
  );
}

/**
 * What the person first said in a thread: their own words, not a routine firing, Chat's greeting or
 * a morning brief Chat asked for in their place.
 */
export function firstPersonMessage(
  messages: readonly Message[],
): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = contentToText(message.content);
    // Decode the outer task frame once; its contents are already the person's words.
    const asked = readTaskBrief(text);
    if (asked !== null) {
      if (asked.trim()) return asked;
      continue;
    }
    if (readFiring(text) !== null) continue;
    if (isFirstDayMessage(text)) continue;
    if (readChannelHello(text) !== null) continue;
    if (readCheckIn(text) !== null) continue;
    if (readMorningBrief(text) !== null) continue;
    if (text.trim()) return text;
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
    queryFn: async () => {
      const history = await readThreadMessages(threadId, agentId);
      if (history.availability === "unavailable")
        throw new Error("Couldn't read this conversation's first message.");
      return firstPersonMessage(history.messages);
    },
    // What was asked first never changes, but an unresolved read is not a title.
    staleTime: (query) =>
      query.state.data == null ? 0 : Number.POSITIVE_INFINITY,
    // History can lag behind activity. Retry unresolved active reads, then stop.
    refetchInterval: (query) =>
      said && query.state.data == null ? 5_000 : false,
  });
}

/** What a conversation is called before anything has been said in it. */
export const NEW_CONVERSATION = "New conversation";

/** The same CommonMark + GFM parser extensions used by Streamdown's remark pipeline. */
const markdownOptions = {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
};

type MarkdownNode =
  | ReturnType<typeof fromMarkdown>
  | ReturnType<typeof fromMarkdown>["children"][number];

/**
 * Markdown as one line of plain text. The parser owns syntax and reference resolution: links keep
 * their visible labels, code stays literal, and definitions never supply title text.
 */
export function plainText(markdown: string): string {
  if (!markdown) return "";
  return markdownText(fromMarkdown(markdown, markdownOptions))
    .replace(/\s+/g, " ")
    .trim();
}

function markdownText(node: MarkdownNode): string {
  switch (node.type) {
    case "definition":
    case "footnoteDefinition":
    case "footnoteReference":
    case "yaml":
      // Definition bodies, identifiers and footnote markers are metadata, not title words.
      return "";
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "text":
    case "inlineCode":
    case "code":
      return node.value;
    case "html":
      // Retain the legacy raw-HTML title text. Streamdown interprets HTML via rehype, but titles
      // do not render HTML or run that pipeline; React displays this returned source as text.
      return node.value;
    case "break":
    case "thematicBreak":
      return " ";
    case "paragraph":
    case "heading":
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
    case "linkReference":
    case "tableCell":
      return node.children.map(markdownText).join("");
    case "root":
    case "blockquote":
    case "list":
    case "listItem":
    case "table":
    case "tableRow":
      // Separate blocks and table cells, but never add spaces inside phrasing content.
      return node.children.map(markdownText).join(" ");
  }
}
