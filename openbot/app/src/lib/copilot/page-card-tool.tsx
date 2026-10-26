import { useRenderTool } from "@copilotkit/react-core/v2";
import { Link, useRouter } from "@tanstack/react-router";
import { motion } from "motion/react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { useConversationSend } from "@/components/channels/conversation-send";
import { useReplyHold } from "@/components/channels/reply-hold";
import { ToolLine } from "@/components/channels/tool-line";
import { PageCard } from "@/components/duet/page-card";
import { type PageSummary, pageSummarySchema } from "@/lib/pages/queries";
import { EASE_OUT } from "@/lib/motion";
import { readToolName } from "@/lib/plugins/tool-name";
import { asText, REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import { useReducedMotionPreference } from "@/lib/reduced-motion";

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
  const card = (
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
  return <HeldUntilReplied title={page.title}>{card}</HeldUntilReplied>;
}

/** How the card enters once the Bot has finished its line: quick, and settling rather than bouncing. */
export const CARD_ENTRANCE = { seconds: 0.24, rise: 8, scale: 0.98 } as const;

/**
 * The card waits for the Bot's words. While the turn is still being written it keeps its row with
 * the finished tool line, under the words as they stream; when the turn ends the line makes way and
 * the card rises into its place, the row's height following it so nothing below jumps. A card
 * already on screen, or one read back from history, is drawn as it is.
 */
function HeldUntilReplied({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const held = useReplyHold();
  const reduced = useReducedMotionPreference();
  // Decided once: a card that was ever drawn stays drawn, and only a held one makes an entrance.
  const [wasHeld] = useState(held);
  const [shown, setShown] = useState(!held);
  if (!held && !shown) setShown(true);
  const line = useRef<HTMLDivElement>(null);
  const lineHeight = useRef(0);
  useLayoutEffect(() => {
    if (!shown && line.current) lineHeight.current = line.current.offsetHeight;
  });
  /*
   * The row clips while its height grows, so the card never spills over the footer under it, and
   * stops clipping once grown, so the card's hairline and shadow show. A tab in the background may
   * never report the end, so the clip also comes off on a timer.
   */
  const [settled, setSettled] = useState(reduced);
  useEffect(() => {
    if (!shown || settled) return;
    const timer = setTimeout(
      () => setSettled(true),
      CARD_ENTRANCE.seconds * 1000 + 80,
    );
    return () => clearTimeout(timer);
  }, [shown, settled]);

  if (!shown)
    return (
      <div data-card-held="" ref={line}>
        <ToolLine detail={title} label={readToolName(PAGE_TOOL).label} />
      </div>
    );
  if (!wasHeld) return children;
  return (
    <motion.div
      animate={{ height: "auto" }}
      className={settled ? undefined : "overflow-hidden"}
      initial={reduced ? false : { height: lineHeight.current }}
      onAnimationComplete={() => setSettled(true)}
      transition={{ duration: CARD_ENTRANCE.seconds, ease: EASE_OUT }}
    >
      <motion.div
        animate={{ opacity: 1, y: 0, scale: 1 }}
        data-card-entrance={reduced ? "fade" : "rise"}
        initial={
          reduced
            ? { opacity: 0 }
            : { opacity: 0, y: CARD_ENTRANCE.rise, scale: CARD_ENTRANCE.scale }
        }
        style={{ transformOrigin: "top center" }}
        transition={{ duration: CARD_ENTRANCE.seconds, ease: EASE_OUT }}
      >
        {children}
      </motion.div>
    </motion.div>
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
