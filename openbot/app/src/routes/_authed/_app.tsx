import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/shell/app-shell";
import { searchTextEntry } from "@/lib/search-text";

export const Route = createFileRoute("/_authed/_app")({
  /*
   * `page`: a page the Bot made, open over whatever screen this is. Chat's cards set it and mask the
   * address as `/make/<id>` (see components/duet/page-sheet.tsx), so the conversation stays under
   * the page and closing it goes back to the conversation.
   */
  validateSearch: (search: Record<string, unknown>): { page?: string } =>
    searchTextEntry("page", search.page),
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
