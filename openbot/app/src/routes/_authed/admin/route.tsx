import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/shell/app-shell";
import { currentUserQueryOptions } from "../../../lib/auth/queries";

export const Route = createFileRoute("/_authed/admin")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user?.role !== "admin") {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

/**
 * Admin is a page in the app's own shell (parity-spec 2.9), as Settings is: the back disc and the
 * title pill over it, the sections as rows on its index page. It used to be OpenBot's admin sidebar,
 * whose only way out on a phone was a 30px "Show sidebar".
 */
function RouteComponent() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
