import { useRenderTool } from "@copilotkit/react-core/v2";
import { Link, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { useConversationSend } from "@/components/channels/conversation-send";
import { ToolLine } from "@/components/channels/tool-line";
import { PageCard } from "@/components/duet/page-card";
import { type PageSummary, pageSummarySchema } from "@/lib/pages/queries";
import { readToolName } from "@/lib/plugins/tool-name";
import { asText, REFUSAL_MARKER } from "@/lib/plugins/tool-result";

/*
 * Draws the server's `make_page` tool (server/src/openduet/pages.ts) as the card under the Bot's
 * line about it: a preview of what it made, the title, when it changed, and a chevron. The page
 * itself is saved on the server; the card is drawn from the summary the tool returned, and opens the
 * saved page over the conversation. The transcript moves it to the end of its turn, under the Bot's
 * words (`repliesLast` in chat-messages.ts).
 */

export const PAGE_TOOL = "make_page";

const parameters = z.object({
  kind: z.string().optional(),
  title: z.string().optional(),
});

/** The tool's result, or null for a refusal or anything that is not a saved page. */
export function readPage(result: unknown): PageSummary | null {
  if (typeof result !== "string" || asText(result).startsWith(REFUSAL_MARKER))
    return null;
  try {
    let value: unknown = JSON.parse(result);
    // A server tool's text can arrive JSON-encoded once more on the way through the runtime.
    if (typeof value === "string") value = JSON.parse(value);
    const parsed = pageSummarySchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The card, opening the page over the conversation it is drawn in. The address bar says
 * `/make/<id>` while the conversation stays underneath, and closing goes back to it. Outside a
 * conversation it opens the page over the Make grid instead.
 */
export function ConversationPageCard({ page }: { page: PageSummary }) {
  const conversation = useConversationSend();
  const router = useRouter({ warn: false });
  return (
    <PageCard
      link={({ className, children }) =>
        !router ? (
          <a
            className={className}
            href={`/make/${encodeURIComponent(page.id)}`}
          >
            {children}
          </a>
        ) : conversation ? (
          <Link
            className={className}
            mask={{ to: "/make/$pageId", params: { pageId: page.id } }}
            search={(previous: Record<string, unknown>) => ({
              ...previous,
              page: page.id,
            })}
            to="."
          >
            {children}
          </Link>
        ) : (
          <Link
            className={className}
            params={{ pageId: page.id }}
            to="/make/$pageId"
          >
            {children}
          </Link>
        )
      }
      page={page}
    />
  );
}

export function PageCardTool() {
  useRenderTool({
    name: PAGE_TOOL,
    parameters,
    render: ({ result, status }) => {
      if (status !== "complete" && result === undefined)
        return <ToolLine label={readToolName(PAGE_TOOL, true).label} running />;
      const page = readPage(result);
      /*
       * Nothing for a refusal. The Bot is told what to fix and tries again; a line saying so would
       * show the person the Bot's mistake, not something it made.
       */
      return page ? <ConversationPageCard page={page} /> : null;
    },
  });
  return null;
}
