import { createFileRoute } from "@tanstack/react-router";
import { ChatScreen } from "@/components/shell/chat-screen";

/** Chat: the person's one ongoing conversation with the product's own Bot. */
export const Route = createFileRoute("/_authed/_app/")({
  component: ChatScreen,
});
