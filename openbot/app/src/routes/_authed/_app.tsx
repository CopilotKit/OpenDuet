import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/shell/app-shell";

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    // One viewport, never scrolls: each screen scrolls inside it, under the shell's header.
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
