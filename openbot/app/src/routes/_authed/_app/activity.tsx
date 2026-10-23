import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/activity` became Pages, and what Activity listed as handled for you is under Resolved at the
 * foot of Tasks. Notifications and links sent before still point here, so they land on Pages.
 */
export const Route = createFileRoute("/_authed/_app/activity")({
  beforeLoad: () => {
    throw redirect({ to: "/pages", replace: true });
  },
});
