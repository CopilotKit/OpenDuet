import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PagesScreen } from "@/components/shell/pages-screen";

/** Pages: everything the Bot made for the person, newest first. A page opens over the list. */
export const Route = createFileRoute("/_authed/_app/pages")({
  component: PagesRoute,
});

function PagesRoute() {
  return (
    <>
      <PagesScreen />
      <Outlet />
    </>
  );
}
