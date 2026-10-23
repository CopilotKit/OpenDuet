import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageShell } from "@/components/layout/page-shell";
import { SetupChecklist } from "@/components/onboarding/setup-checklist";

export const Route = createFileRoute("/_authed/settings/setup")({
  /*
   * `?connected=failed` is how a Gmail consent started here comes back when it did not go through
   * (`settings-setup` in `connectedAccountsUrlFor` on the server). Read once, then dropped.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { connected?: "failed" } =>
    search.connected === "failed" ? { connected: "failed" } : {},
  component: SetupPage,
});

/**
 * The checklist onboarding ends on, open again whenever somebody wants to see what is set up.
 *
 * Drawn in the Duet card rather than `PageRows`, unlike its neighbours in Settings: it is the same
 * list as onboarding's last step, and one list drawn two ways is two lists to keep in step. Its
 * Connect comes back here, not to Connections.
 */
function SetupPage() {
  const router = useRouter();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [failed] = useState(() => search.connected === "failed");
  useEffect(() => {
    if (search.connected === undefined) return;
    navigate({ to: "/settings/setup", search: {}, replace: true });
  }, [navigate, search.connected]);
  return (
    <PageShell
      description="What's ready, and what still needs setting up."
      title="Setup"
    >
      <div className="mt-8">
        <SetupChecklist
          notice={
            failed
              ? "Couldn't connect your Gmail and Calendar. Try again."
              : undefined
          }
          openPage={(path) => router.history.push(path)}
          returnTo="settings-setup"
        />
      </div>
    </PageShell>
  );
}
