import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/pages/<id>` became `/make/<id>` when Pages became Make. Cards drawn in Chat before then, and
 * links sent from them, still point here, so they open the same page there.
 */
export const Route = createFileRoute("/_authed/_app/pages/$pageId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/make/$pageId",
      params: { pageId: params.pageId },
      replace: true,
    });
  },
});
