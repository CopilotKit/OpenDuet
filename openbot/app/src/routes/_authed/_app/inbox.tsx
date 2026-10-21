import { createFileRoute } from "@tanstack/react-router";
import { InboxScreen } from "@/components/shell/inbox-screen";

/** Inbox: the actions and questions waiting on the person. */
export const Route = createFileRoute("/_authed/_app/inbox")({
  component: InboxScreen,
});
