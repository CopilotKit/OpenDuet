import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/activity` became Pages, and Pages became Make. What Activity listed as handled for you is under
 * Resolved on Tasks. Notifications and links sent before still point here, so they land on Make.
 */
export const Route = createFileRoute("/_authed/_app/activity")({
  beforeLoad: () => {
    throw redirect({ to: "/make", replace: true });
  },
});
