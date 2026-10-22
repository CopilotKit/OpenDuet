import { createFileRoute } from "@tanstack/react-router";
import { PageSheet, useCloseSheet } from "@/components/duet/page-sheet";

/**
 * One page, open over the Pages list. Also where a `/pages/<id>` link lands on its own. There is no
 * conversation here, so its rows are still.
 */
export const Route = createFileRoute("/_authed/_app/pages/$pageId")({
  component: PageRoute,
});

function PageRoute() {
  const { pageId } = Route.useParams();
  const navigate = Route.useNavigate();
  const close = useCloseSheet(() => void navigate({ to: "/pages" }));
  return <PageSheet key={pageId} onClose={close} pageId={pageId} />;
}
