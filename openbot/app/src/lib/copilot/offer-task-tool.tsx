import { useRenderTool } from "@copilotkit/react-core/v2";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import {
  useChatBot,
  useShownInThread,
} from "@/components/shell/chat-suggestion";
import { SuggestionCard } from "@/components/shell/suggestion-card";
import { OFFER_TASK_TOOL } from "@/lib/channels/check-in";
import { readToolName } from "@/lib/plugins/tool-name";
import { asText, REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import {
  personAsked,
  proactiveSuggestionQueryOptions,
  resolveSuggestionMutationOptions,
} from "@/lib/proactive";

/*
 * Draws the server's `offer_task` tool (server/src/openduet/offers.ts) as the card a check-in ends
 * on: the same card Chat shows above its composer, with the title, two lines of why, where it came
 * from, Hide and Start, and the drag. It sits in the thread under the Bot's words about it (the
 * transcript moves it there, `repliesLast` in chat-messages.ts), so it stays where the Bot offered
 * it rather than being replaced by the next suggestion.
 *
 * Start and Hide are the same answers Tasks gives, through the same mutation, so a card answered
 * here is answered everywhere, and one answered anywhere else reads Started or Hidden here instead
 * of offering its buttons again.
 */

const parameters = z.object({ suggestionId: z.string().optional() });

const offeredSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  detail: z.string(),
  source: z.string().nullable().optional(),
  status: z.enum(["open", "started", "dismissed"]),
});
export type OfferedTask = z.infer<typeof offeredSchema>;

/** The tool's result, or null for a refusal or anything that is not an offered task. */
export function readOffer(result: unknown): OfferedTask | null {
  if (typeof result !== "string" || asText(result).startsWith(REFUSAL_MARKER))
    return null;
  try {
    let value: unknown = JSON.parse(result);
    // A server tool's text can arrive JSON-encoded once more on the way through the runtime.
    if (typeof value === "string") value = JSON.parse(value);
    const parsed = offeredSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The card for one offered task, kept up to date with what became of it. */
export function OfferedTaskCard({ offered }: { offered: OfferedTask }) {
  const queryClient = useQueryClient();
  const chatBot = useChatBot();
  useShownInThread(offered.id);
  // What the tool saw when it offered the card stands in until the suggestion itself is read.
  const current = useQuery({
    ...proactiveSuggestionQueryOptions(offered.id),
    placeholderData: {
      id: offered.id,
      agentId: "",
      title: offered.title,
      detail: offered.detail,
      sourceApp: offered.source ?? null,
      sourceLink: null,
      status: offered.status,
      createdAt: "",
    },
  });
  const act = useMutation(resolveSuggestionMutationOptions(queryClient));
  const suggestion = current.data ?? {
    title: offered.title,
    detail: offered.detail,
    sourceApp: offered.source ?? null,
    status: offered.status,
  };
  const status = suggestion.status ?? offered.status;
  return (
    <SuggestionCard
      answered={
        status === "started"
          ? "started"
          : status === "dismissed"
            ? "hidden"
            : undefined
      }
      busy={act.isPending}
      error={act.error?.message ?? null}
      heading={
        chatBot ? `${chatBot.name} could take this on` : "Ready to start"
      }
      onAnswer={(action, comeBack) =>
        act.mutate(
          /*
           * Started here, a check-in's card makes a task that began at a check-in. A card the person
           * asked for, as a channel's Yes adds them, is an ordinary suggestion started.
           */
          action === "start" && !(current.data && personAsked(current.data))
            ? { id: offered.id, action, from: "check_in" }
            : { id: offered.id, action },
          { onError: () => comeBack?.() },
        )
      }
      suggestion={suggestion}
    />
  );
}

export function OfferTaskTool() {
  useRenderTool({
    name: OFFER_TASK_TOOL,
    parameters,
    render: ({ result, status }) => {
      if (status !== "complete" && result === undefined)
        return (
          <ToolLine label={readToolName(OFFER_TASK_TOOL, true).label} running />
        );
      const offered = readOffer(result);
      // Nothing for a refusal: the Bot offered an id that is not the person's, and there is no card.
      return offered ? <OfferedTaskCard offered={offered} /> : null;
    },
  });
  return null;
}
