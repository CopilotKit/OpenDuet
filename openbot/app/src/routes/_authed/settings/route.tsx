import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/shell/app-shell";

export const Route = createFileRoute("/_authed/settings")({
  component: RouteComponent,
});

/**
 * Settings is a page in the app's own shell (parity-spec 2.9): the back disc and the title pill over
 * it, the same chrome as every other page the menu or the avatar opens. It used to be OpenBot's
 * settings shell, a second sidebar whose only way out was "Back to app".
 */
function RouteComponent() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
