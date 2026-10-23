import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/pages` became Make. Links and notifications sent before still point here, so they land there. */
export const Route = createFileRoute("/_authed/_app/pages/")({
  beforeLoad: () => {
    throw redirect({ to: "/make", replace: true });
  },
});
