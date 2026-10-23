import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/inbox` became Tasks, whose Needs input group lists what the Inbox did. Notifications and links
 * sent before still point here, so they land on Tasks.
 */
export const Route = createFileRoute("/_authed/_app/inbox")({
  beforeLoad: () => {
    throw redirect({ to: "/tasks", replace: true });
  },
});
