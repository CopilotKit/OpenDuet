import { createFileRoute, Outlet } from "@tanstack/react-router";
import { MakeScreen } from "@/components/shell/make-screen";

/** Make: everything the Bot made for the person, newest first, and the + that asks for more. */
export const Route = createFileRoute("/_authed/_app/make")({
  component: MakeRoute,
});

function MakeRoute() {
  return (
    <>
      <MakeScreen />
      <Outlet />
    </>
  );
}
