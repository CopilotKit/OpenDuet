import { createFileRoute } from "@tanstack/react-router";
import { PageSheet, useCloseSheet } from "@/components/duet/page-sheet";

/**
 * One thing the Bot made, open over the Make grid. Also where a `/make/<id>` link lands on its own,
 * and where an older `/pages/<id>` link is sent. There is no conversation here, so its rows are still.
 */
export const Route = createFileRoute("/_authed/_app/make/$pageId")({
  component: PageRoute,
});

function PageRoute() {
  const { pageId } = Route.useParams();
  const navigate = Route.useNavigate();
  const close = useCloseSheet(() => void navigate({ to: "/make" }));
  return <PageSheet key={pageId} onClose={close} pageId={pageId} />;
}
